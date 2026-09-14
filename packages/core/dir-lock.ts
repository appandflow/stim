import { releaseClaim, tryAcquireDirClaim, type ClaimHandle } from './ownership-claim.ts';

const DEFAULT_LOCK_WAIT_MS = 12000;
const DEFAULT_LOCK_POLL_MS = 25;
const lockDepths = new Map<string, number>();

export interface DirLockOptions {
  /** @deprecated Occupied locks are never expired. */
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
  ensureParent?: () => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireDirLock(
  lockPath: string,
  {
    waitMs,
    pollMs,
    ensureParent,
  }: Required<Pick<DirLockOptions, 'waitMs' | 'pollMs'>> & Pick<DirLockOptions, 'ensureParent'>,
): ClaimHandle {
  ensureParent?.();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const attempt = tryAcquireDirClaim(lockPath);
    if (attempt.acquired) return attempt.acquired;
    if (attempt.pending) releaseClaim(attempt.pending);
    if (Date.now() >= deadline) {
      const error = new Error(
        `Timed out waiting for the lock at ${lockPath}. ` +
          'Another Stim process may be holding it; if none is running, remove that directory.',
      );
      (error as Error & { code?: string; lockPath?: string }).code = 'STIM_LOCK_TIMEOUT';
      (error as Error & { code?: string; lockPath?: string }).lockPath = lockPath;
      throw error;
    }
    sleepSync(pollMs);
  }
}

export function withDirLock<T>(
  lockPath: string,
  fn: () => T,
  { waitMs = DEFAULT_LOCK_WAIT_MS, pollMs = DEFAULT_LOCK_POLL_MS, ensureParent }: DirLockOptions = {},
): T {
  const depth = lockDepths.get(lockPath) || 0;
  if (depth > 0) {
    lockDepths.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      lockDepths.set(lockPath, (lockDepths.get(lockPath) ?? 1) - 1);
    }
  }
  const claim = acquireDirLock(lockPath, { waitMs, pollMs, ensureParent });
  lockDepths.set(lockPath, 1);
  try {
    return fn();
  } finally {
    lockDepths.set(lockPath, 0);
    releaseClaim(claim);
  }
}
