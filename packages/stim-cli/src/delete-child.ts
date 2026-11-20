import type { ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getExecutor } from './exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-error.ts';
import { clearClaimChild, setClaimChild, type ClaimHandle } from './ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from './process-identity.ts';
import { runRmJob, type DeleteOutcome, type RmJob } from './workspace/remover.ts';

const CANCEL_GRACE_MS = 5000;
const EXIT_WAIT_MS = 5000;

/** Deletes trees through one delete child, or in the caller's thread when that child could not start. */
export interface DeleteSession {
  /**
   * Deletes `path` and everything below it while `claim` holds it. While the child runs the delete, the claim records the
   * child, so it reads as held until the child is gone. Throws `WorkspaceProcessCleanupError`, with the claim still
   * held, when a cancelled child's exit cannot be proven.
   */
  rm(path: string, claim: ClaimHandle, signal?: AbortSignal): Promise<DeleteOutcome>;
  close(): Promise<void>;
}

const NO_SIGNAL = new AbortController().signal;

async function planJob(path: string): Promise<Omit<RmJob, 'id'> | null> {
  const parent = await realpath(dirname(path)).catch(() => null);
  if (!parent) return null;
  const canonical = join(parent, basename(path));
  const stat = await lstat(canonical).catch(() => null);
  return stat ? { op: 'rm', path: canonical, dev: stat.dev } : null;
}

const inThread: DeleteSession = {
  async rm(path, _claim, signal) {
    const job = await planJob(path);
    return job ? runRmJob({ id: 0, ...job }, signal ?? NO_SIGNAL) : { done: { left: [] } };
  },
  async close() {},
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Starts the delete child (`dist/delete-child.mjs`). It falls back to deleting in this thread, through the same remover,
 * when the child cannot be spawned, exits before it is ready, or its identity cannot be captured; such a child gets no
 * job and is killed.
 */
export async function openDeleteSession(): Promise<DeleteSession> {
  let child: ChildProcess;
  try {
    child = getExecutor().spawn(
      process.execPath,
      [fileURLToPath(new URL('../dist/delete-child.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' },
    );
  } catch {
    return inThread;
  }
  child.on('error', () => {});
  child.stdin?.on('error', () => {});
  let gone = child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<void>((resolve) => {
    if (gone) resolve();
    child.once('exit', () => {
      gone = true;
      resolve();
    });
  });
  const pid = child.pid;
  const captured = pid === undefined ? null : captureProcessIdentity(pid);
  // @ref LLP 0007#a-report-child-whose-identity-was-not-captured-is-killed-after-its-cancel -- signalled only from a macrotask, before its exit is delivered
  if (!captured?.ok || pid === undefined) {
    setImmediate(() => {
      if (!gone) child.kill('SIGKILL');
    });
    return inThread;
  }
  const identity: ProcessRecord = { pid, processToken: captured.token };
  const kill = () => {
    if (!gone && inspectProcessIdentity(identity) === 'same') child.kill('SIGKILL');
  };
  const replies = new Map<number, (outcome: DeleteOutcome | 'unverified') => void>();
  let ready: (started: boolean) => void;
  const started = new Promise<boolean>((resolve) => {
    ready = resolve;
  });
  void exited.then(() => ready(false));
  if (!child.stdout || !child.stdin) {
    kill();
    return inThread;
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown> | null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const { id, ready: readyLine, progress, ...outcome } = message;
    if (readyLine !== undefined) ready(readyLine === true);
    else if (typeof id === 'number' && progress === undefined) replies.get(id)?.(outcome as DeleteOutcome);
  });
  if (!(await started)) {
    kill();
    return inThread;
  }
  const stdin = child.stdin;
  let next = 0;
  return {
    async rm(path, claim, signal) {
      const planned = await planJob(path);
      if (!planned) return { done: { left: [] } };
      signal?.throwIfAborted();
      if (gone) return { failed: { code: null, message: 'the delete child is no longer running', path: null } };
      const id = ++next;
      // @ref LLP 0007#a-delete-child-holds-the-claim-of-the-tree-it-deletes -- the claim reads as held while the child runs
      setClaimChild(claim, identity);
      let stopTimer: NodeJS.Timeout | undefined;
      const outcome = new Promise<DeleteOutcome | 'exited' | 'unverified'>((resolve) => {
        replies.set(id, resolve);
        void exited.then(() => resolve('exited'));
      });
      const cancel = () => {
        stdin.write(`${JSON.stringify({ cancel: id })}\n`);
        stopTimer = setTimeout(() => {
          kill();
          stopTimer = setTimeout(() => replies.get(id)?.('unverified'), EXIT_WAIT_MS);
        }, CANCEL_GRACE_MS);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      stdin.write(`${JSON.stringify({ id, ...planned })}\n`);
      let result: Awaited<typeof outcome>;
      try {
        result = await outcome;
      } finally {
        signal?.removeEventListener('abort', cancel);
        clearTimeout(stopTimer);
        replies.delete(id);
      }
      if (result === 'unverified')
        throw new WorkspaceProcessCleanupError(
          [claim],
          `The delete child ${pid} did not exit after it was cancelled and killed; ${planned.path} may still be changing.`,
          `Check whether process ${pid} (\`ps -p ${pid}\`) still runs.`,
          Object.assign(new Error('delete child exit unverified'), {
            reportChild: identity,
            cleanupSettled: () => gone || inspectProcessIdentity(identity) === 'gone',
          }),
        );
      clearClaimChild(claim);
      if (result !== 'exited') return result;
      const how = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      return { failed: { code: null, message: `the delete child exited (${how}) before it finished`, path: null } };
    },
    async close() {
      stdin.end();
      await Promise.race([exited, delay(EXIT_WAIT_MS)]);
      kill();
    },
  };
}
