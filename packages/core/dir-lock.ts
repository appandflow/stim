import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { releaseClaim, sleepSync, tryAcquireClaim, type ClaimHandle } from './ownership-claim.ts';

const DEFAULT_LOCK_WAIT_MS = 12000;
const DEFAULT_LOCK_POLL_MS = 25;
const lockDepths = new Map<string, number>();

export interface DirLockOptions {
  waitMs?: number;
  pollMs?: number;
  ensureParent?: () => void;
}

function prepareDirLock(lockPath: string, ensureParent: DirLockOptions['ensureParent']): void {
  ensureParent?.();
  statSync(dirname(lockPath));
}

function attemptDirLock(lockPath: string): ClaimHandle | null {
  const attempt = tryAcquireClaim({ root: `${lockPath}.claims`, mode: 'exclusive', label: 'directory lock' });
  if (attempt.pending) releaseClaim(attempt.pending);
  return attempt.acquired ?? null;
}

function dirLockTimeout(lockPath: string): Error {
  const error = new Error(
    `Timed out waiting for the lock at ${lockPath}.` +
      ' Another Stim process is holding it; wait for that command to finish and run the command again.',
  );
  (error as Error & { code?: string; lockPath?: string }).code = 'STIM_LOCK_TIMEOUT';
  (error as Error & { code?: string; lockPath?: string }).lockPath = lockPath;
  return error;
}

function nestedDirLock<T>(lockPath: string, fn: () => T): T {
  lockDepths.set(lockPath, (lockDepths.get(lockPath) ?? 0) + 1);
  try {
    return fn();
  } finally {
    lockDepths.set(lockPath, (lockDepths.get(lockPath) ?? 1) - 1);
  }
}

function holdDirLock<T>(lockPath: string, claim: ClaimHandle, fn: () => T): T {
  lockDepths.set(lockPath, 1);
  try {
    return fn();
  } finally {
    lockDepths.set(lockPath, 0);
    releaseClaim(claim);
  }
}

export function withDirLock<T>(
  lockPath: string,
  fn: () => T,
  { waitMs = DEFAULT_LOCK_WAIT_MS, pollMs = DEFAULT_LOCK_POLL_MS, ensureParent }: DirLockOptions = {},
): T {
  if ((lockDepths.get(lockPath) || 0) > 0) return nestedDirLock(lockPath, fn);
  prepareDirLock(lockPath, ensureParent);
  const deadline = Date.now() + waitMs;
  let held: ClaimHandle | null;
  while (!(held = attemptDirLock(lockPath))) {
    if (Date.now() >= deadline) throw dirLockTimeout(lockPath);
    sleepSync(pollMs);
  }
  return holdDirLock(lockPath, held, fn);
}

/**
 * `withDirLock` that waits for a contended lock on a timer instead of blocking the thread. `fn` still runs
 * synchronously: nothing awaits between taking the lock, running `fn` and releasing the lock, so the held
 * transaction and reentrant nesting behave exactly as with `withDirLock`.
 * An optional signal cancels acquisition; it cannot interrupt the synchronous transaction.
 */
export async function withDirLockAsync<T>(
  lockPath: string,
  fn: () => T,
  options: DirLockOptions & { signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  if ((lockDepths.get(lockPath) || 0) > 0) return nestedDirLock(lockPath, fn);
  return acquireDirLockAsync<T>(lockPath, options, (held) =>
    holdDirLock(lockPath, held, () => {
      options.signal?.throwIfAborted();
      return fn();
    }),
  );
}

async function acquireDirLockAsync<T>(
  lockPath: string,
  {
    waitMs = DEFAULT_LOCK_WAIT_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
    ensureParent,
    signal,
  }: DirLockOptions & { signal?: AbortSignal },
  fn: (held: ClaimHandle) => T | Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  prepareDirLock(lockPath, ensureParent);
  const deadline = Date.now() + waitMs;
  let held: ClaimHandle | null;
  while (!(held = attemptDirLock(lockPath))) {
    if (Date.now() >= deadline) throw dirLockTimeout(lockPath);
    await delay(pollMs, undefined, { signal });
  }
  return fn(held);
}

/**
 * Holds the ownership claim until the body settles. Transactions are exclusive even
 * within one process and are not reentrant. Cancellation stops acquisition; the body owns cancellation after admission.
 */
export async function withDirLockTransaction<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: DirLockOptions & { signal?: AbortSignal } = {},
): Promise<T> {
  return acquireDirLockAsync<T>(lockPath, options, async (claim) => {
    try {
      options.signal?.throwIfAborted();
      return await fn();
    } finally {
      releaseClaim(claim);
    }
  });
}
