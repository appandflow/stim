import type { ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { debugLog } from './debug-log.ts';
import { getExecutor } from './exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-error.ts';
import { clearClaimChild, setClaimChild, type ClaimHandle } from './ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from './process-identity.ts';
import { logReportChild } from './report-child-log.ts';
import { runRmJob, type DeleteOutcome, type RmJob } from './workspace/remover.ts';

const READY_MS = 5000;
const CANCEL_GRACE_MS = 5000;
const EXIT_WAIT_MS = 5000;

/** Deletes trees through one delete child, or in the caller's thread when that child could not start. */
export interface DeleteSession {
  /**
   * Deletes `path` and everything below it, on device `dev` only, while `claim` holds it. While the child runs the
   * delete, the claim records the child, so it reads as held until the child is gone. Throws `WorkspaceProcessCleanupError`,
   * with the claim still held, when a cancelled child's exit cannot be proven.
   */
  rm(path: string, claim: ClaimHandle, options: { dev: number; signal?: AbortSignal }): Promise<DeleteOutcome>;
  /** Whether the child has exited, so the session takes no more jobs and the caller opens another. */
  exited(): boolean;
  close(): Promise<void>;
}

const NO_SIGNAL = new AbortController().signal;

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The canonical `path`, or null when it is already gone. */
async function canonical(path: string): Promise<string | null> {
  const parent = await realpath(dirname(path)).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!parent) return null;
  const resolved = join(parent, basename(path));
  const stat = await lstat(resolved).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  return stat ? resolved : null;
}

const inThread: DeleteSession = {
  async rm(path, _claim, { dev, signal }) {
    const resolved = await canonical(path);
    return resolved ? runRmJob({ id: 0, op: 'rm', path: resolved, dev }, signal ?? NO_SIGNAL) : { done: { left: [] } };
  },
  exited: () => false,
  async close() {},
};

/** The in-thread session, after recording why the delete child is not used in the daemon log and the debug log. */
function fallBack(reason: string): DeleteSession {
  const msg = `the delete child is not used, so this delete runs in this process: ${reason}`;
  logReportChild(msg, { reason }, 'daemon_delete_child_fallback', 'warn');
  debugLog.log('delete_child.fallback', { reason });
  return inThread;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Starts the delete child (`dist/delete-child.mjs`). It falls back to deleting in this thread, through the same remover,
 * when the child cannot be spawned, exits before it is ready, is not ready within 5 s, or its identity cannot be
 * captured; such a child gets no job, sees EOF and is killed. Throws the abort reason, after killing the child, when
 * `signal` aborts first, and a cleanup refusal naming the child when it is still running 5 s after it was stopped.
 */
export async function openDeleteSession(signal?: AbortSignal): Promise<DeleteSession> {
  signal?.throwIfAborted();
  let child: ChildProcess;
  try {
    const entry = fileURLToPath(new URL('../dist/delete-child.mjs', import.meta.url));
    child = getExecutor().spawn(process.execPath, [entry], {
      cwd: dirname(entry),
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    return fallBack(`it could not be spawned: ${error instanceof Error ? error.message : String(error)}`);
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
    child.stdin?.end();
    setImmediate(() => {
      if (!gone) child.kill('SIGKILL');
    });
    return fallBack(`its identity was not captured: ${captured?.ok === false ? captured.reason : 'it has no pid'}`);
  }
  const identity: ProcessRecord = { pid, processToken: captured.token };
  const kill = () => {
    if (!gone && inspectProcessIdentity(identity) === 'same') child.kill('SIGKILL');
  };
  const stopped = () => gone || inspectProcessIdentity(identity) === 'gone';
  const reap = async () => {
    child.stdin?.end();
    kill();
    await Promise.race([exited, delay(EXIT_WAIT_MS)]);
    if (stopped()) return;
    throw Object.assign(new Error(`The delete child ${pid} did not exit after it was stopped.`), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      remedy: `Check whether process ${pid} (\`ps -p ${pid}\`) still runs, and stop it if it does.`,
      reportChild: identity,
      cleanupSettled: stopped,
    });
  };
  const replies = new Map<number, (outcome: DeleteOutcome | 'unverified') => void>();
  let ready: (state: 'ready' | 'aborted' | { failed: string }) => void;
  const started = new Promise<'ready' | 'aborted' | { failed: string }>((resolve) => {
    ready = resolve;
  });
  void exited.then(() =>
    ready({ failed: `it exited before it was ready (${child.signalCode ?? `code ${child.exitCode}`})` }),
  );
  if (!child.stdout || !child.stdin) {
    await reap();
    return fallBack('it has no stdin or stdout');
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
    if (readyLine !== undefined) ready(readyLine === true ? 'ready' : { failed: `it answered ${line}` });
    else if (typeof id === 'number' && progress === undefined) replies.get(id)?.(outcome as DeleteOutcome);
  });
  const timeout = setTimeout(() => ready({ failed: `it was not ready within ${READY_MS} ms` }), READY_MS);
  const abort = () => ready('aborted');
  signal?.addEventListener('abort', abort, { once: true });
  const readiness = await started;
  clearTimeout(timeout);
  signal?.removeEventListener('abort', abort);
  if (readiness !== 'ready') {
    await reap();
    if (readiness === 'aborted') signal?.throwIfAborted();
    return fallBack(readiness === 'aborted' ? 'the caller cancelled' : readiness.failed);
  }
  const stdin = child.stdin;
  let next = 0;
  let raised = false;
  return {
    async rm(path, claim, { dev, signal: jobSignal }) {
      const resolved = await canonical(path);
      if (!resolved) return { done: { left: [] } };
      jobSignal?.throwIfAborted();
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
      jobSignal?.addEventListener('abort', cancel, { once: true });
      const job: RmJob = { id, op: 'rm', path: resolved, dev };
      stdin.write(`${JSON.stringify(job)}\n`);
      let result: Awaited<typeof outcome>;
      try {
        result = await outcome;
      } finally {
        jobSignal?.removeEventListener('abort', cancel);
        clearTimeout(stopTimer);
        replies.delete(id);
      }
      if (result === 'unverified') {
        raised = true;
        throw new WorkspaceProcessCleanupError(
          [claim],
          `The delete child ${pid} did not exit after it was cancelled and killed; ${resolved} may still be changing.`,
          `Check whether process ${pid} (\`ps -p ${pid}\`) still runs.`,
          Object.assign(new Error('delete child exit unverified'), {
            reportChild: identity,
            cleanupSettled: stopped,
          }),
        );
      }
      clearClaimChild(claim);
      if (result !== 'exited') return result;
      const how = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      return { failed: { code: null, message: `the delete child exited (${how}) before it finished`, path: null } };
    },
    exited: () => gone,
    async close() {
      stdin.end();
      await Promise.race([exited, delay(EXIT_WAIT_MS)]);
      if (gone) return;
      if (raised) kill();
      else await reap();
    },
  };
}
