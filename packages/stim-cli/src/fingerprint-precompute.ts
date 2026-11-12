import { setPriority } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import { getExecutor } from './exec.ts';
import { processContext } from './cli-operation.ts';
import { makeTemporaryDirectory, removeTemporaryEntry } from './temporary.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import type { ClaimHandle } from './ownership-claim.ts';
import { trackReportResource } from './report-runtime.ts';
import { withFingerprintOwnership } from './engine/fingerprint-ownership.ts';
import { settleDetachedGroups } from './fingerprint/detached-groups.ts';
import { groupExitBudgetMs } from './process-group-exit.ts';
import { captureProcessIdentity, inspectProcessIdentity } from './process-identity.ts';
import type { AndroidLayout } from './workspace/settings.ts';
import type { Fingerprint } from './fingerprint/evaluate.ts';
import type { FingerprintNote } from './fingerprint/doctor.ts';
import type { Uncertain } from './fingerprint/key.ts';
export type FingerprintPrecompute = { outcome: 'present' | 'recorded' } | { outcome: 'skipped'; reason: string };

const PRECOMPUTE_TIMEOUT_MS = 120_000;
const CLEANUP_GRACE_MS = 10_000;

export interface FingerprintPrecomputeRequest {
  root: string;
  platform: 'ios' | 'android';
  iosProjectPath?: string;
  androidLayout?: AndroidLayout;
  fingerprintInputs?: string[];
}

async function runFingerprintChild(
  operation: StimContext,
  request: FingerprintPrecomputeRequest & {
    task?: 'evaluate' | 'notes' | 'verify';
    embedMode?: 'development' | 'production';
    pendingFile?: string;
  },
): Promise<unknown> {
  const claims: ClaimHandle[] = [];
  const timeoutFailure = () =>
    new WorkspaceProcessCleanupError(
      claims,
      'Fingerprint cleanup did not finish within the report deadline.',
      'Verify the evaluator processes and their descendants have stopped.',
    );
  const cleanupFailure = Object.assign(timeoutFailure(), { reportCleanup: true });
  const running = withFingerprintOwnership(operation, request.root, async (owned) => {
    claims.push(...owned);
    const updatedFailure = timeoutFailure();
    cleanupFailure.message = updatedFailure.message;
    Object.assign(cleanupFailure, { remedy: updatedFailure.remedy });
    const directory = makeTemporaryDirectory(request.root, 'stim-fingerprint-owner-', operation);
    const acknowledgement = join(directory, 'settled.json');
    const nonce = randomUUID();
    let spawned = false;
    let output: string | undefined;
    let failure: unknown;
    let retain = false;
    let child: ChildProcess | undefined;
    let identity: { pid: number; processToken: string } | undefined;
    let interruption: unknown;
    let grace: NodeJS.Timeout | undefined;
    const hardStop = new AbortController();
    const deadline = performance.now() + PRECOMPUTE_TIMEOUT_MS;
    const signalChild = () => {
      if (child && identity && inspectProcessIdentity(identity) === 'same') child.kill('SIGTERM');
    };
    const stop = (reason: unknown) => {
      if (interruption !== undefined) return;
      interruption = reason;
      signalChild();
      grace = setTimeout(() => hardStop.abort(reason), CLEANUP_GRACE_MS);
      grace.unref();
    };
    const cancel = () => stop(operation.signal.reason);
    operation.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(
      () => stop(Object.assign(new Error('Fingerprint evaluation timed out.'), { code: 'ETIMEDOUT' })),
      PRECOMPUTE_TIMEOUT_MS,
    );
    timeout.unref();
    try {
      try {
        operation.signal.throwIfAborted();
        output = await getExecutor().runFileAsync(
          process.execPath,
          [fileURLToPath(new URL('../dist/fingerprint-precompute.mjs', import.meta.url))],
          {
            cwd: request.root,
            env: {
              ...Object.fromEntries(
                Object.entries(operation.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
              ),
              ...(request.task === 'verify' ? { STIM_HOME: operation.home } : {}),
            },
            omitEnv: Object.keys(processContext(request.root).env).filter(
              (name) => operation.env[name] === undefined && !(request.task === 'verify' && name === 'STIM_HOME'),
            ),
            input: JSON.stringify({ ...request, ownership: { directory, acknowledgement, nonce } }),
            timeoutMs: 'unbounded',
            signal: hardStop.signal,
            context: { ...operation, signal: hardStop.signal },
            declareFor: operation,
            onSpawn: (started) => {
              child = started;
              spawned = started.pid !== undefined && started.pid > 0;
              if (spawned && started.pid) {
                const captured = captureProcessIdentity(started.pid);
                if (captured.ok) identity = { pid: started.pid, processToken: captured.token };
              }
              try {
                if (started.pid) setPriority(started.pid, 10);
              } catch {}
              if (interruption !== undefined) signalChild();
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      if (performance.now() >= deadline)
        stop(Object.assign(new Error('Fingerprint evaluation timed out.'), { code: 'ETIMEDOUT' }));
      let acknowledged = false;
      try {
        const fd = openSync(acknowledgement, 'r');
        let data: string;
        try {
          const buffer = Buffer.alloc(1025);
          const length = readSync(fd, buffer, 0, buffer.length, 0);
          if (length > 1024) throw new Error('Fingerprint acknowledgement is too large.');
          data = buffer.toString('utf8', 0, length);
        } finally {
          closeSync(fd);
        }
        const value: unknown = JSON.parse(data);
        acknowledged = Boolean(
          value &&
          typeof value === 'object' &&
          'nonce' in value &&
          value.nonce === nonce &&
          'settled' in value &&
          value.settled === true,
        );
      } catch {}
      // @ref LLP 0007#releasing-a-claim-after-a-killed-fingerprint-child -- the child's ledger of detached groups stands in for its acknowledgement
      const unverifiedChild = typeof failure === 'object' && failure !== null && 'reportCleanup' in failure;
      if (
        spawned &&
        (unverifiedChild ||
          !(acknowledged || (await settleDetachedGroups(directory, identity, groupExitBudgetMs(10_000)))))
      ) {
        retain = true;
        throw Object.assign(
          new WorkspaceProcessCleanupError(
            claims,
            `Fingerprint child cleanup could not be verified; retained ${directory}.`,
            `Verify its evaluator processes have stopped, then remove ${directory}.`,
            failure instanceof Error ? failure : undefined,
            acknowledged,
          ),
          { reportCleanup: true },
        );
      }
      if (interruption !== undefined) throw interruption;
      if (failure) throw failure;
      if (!output) throw new Error('Fingerprint child returned no result.');
      const value = JSON.parse(output) as unknown;
      if (value && typeof value === 'object' && 'failure' in value) {
        const childFailure = value.failure;
        if (childFailure && typeof childFailure === 'object' && 'reportCleanup' in childFailure) {
          retain = true;
          throw Object.assign(
            new WorkspaceProcessCleanupError(
              claims,
              `Fingerprint child cleanup could not be verified; retained ${directory}.`,
              `Verify its evaluator processes have stopped, then remove ${directory}.`,
            ),
            { reportCleanup: true },
          );
        }
      }
      return value;
    } finally {
      operation.signal.removeEventListener('abort', cancel);
      clearTimeout(timeout);
      clearTimeout(grace);
      if (!retain) removeTemporaryEntry(directory);
    }
  });
  const closed = running.then(
    () => undefined,
    (error: unknown) => {
      if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
      return undefined;
    },
  );
  void closed.catch(() => {});
  trackReportResource(operation, closed, () => {}, operation.signal, cleanupFailure);
  return running;
}

export async function runFingerprintPrecompute(
  operation: StimContext,
  request: FingerprintPrecomputeRequest,
): Promise<FingerprintPrecompute> {
  return (await runFingerprintChild(operation, request)) as FingerprintPrecompute;
}

export async function runFingerprintVerification(
  operation: StimContext,
  request: FingerprintPrecomputeRequest & { pendingFile: string },
): Promise<{ verified: number } | { outcome: 'skipped'; reason: string }> {
  return (await runFingerprintChild(operation, { ...request, task: 'verify' })) as
    | { verified: number }
    | { outcome: 'skipped'; reason: string };
}

export async function readFingerprint(
  operation: StimContext,
  request: FingerprintPrecomputeRequest & { embedMode: 'development' | 'production' },
): Promise<Fingerprint | Uncertain | null> {
  return (await runFingerprintChild(operation, { ...request, task: 'evaluate' })) as Fingerprint | Uncertain | null;
}

export async function readFingerprintNotes(
  operation: StimContext,
  request: FingerprintPrecomputeRequest & { embedMode: 'development' | 'production' },
): Promise<FingerprintNote[]> {
  return (await runFingerprintChild(operation, { ...request, task: 'notes' })) as FingerprintNote[];
}
