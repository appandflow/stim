import { lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaimRefusedError, releaseClaim, tryAcquireClaim, type ClaimHandle } from './ownership-claim.ts';
import { quotedPath } from './quoted-path.ts';

const DEFAULT_LOCK_WAIT_MS = 12000;
const DEFAULT_LOCK_POLL_MS = 25;
const lockDepths = new Map<string, number>();
const OWNER_MARKER = /^\.stim-claim-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

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

/**
 * Whether Windows refused a call on the lock directory because another process is removing it at that
 * moment. NTFS answers ERROR_ACCESS_DENIED, which Node reports as EPERM, until that removal completes,
 * where POSIX answers EEXIST or ENOENT: https://github.com/appandflow/stim/issues/883.
 */
function removalInFlight(error: unknown): boolean {
  return process.platform === 'win32' && (error as NodeJS.ErrnoException)?.code === 'EPERM';
}

function createLockDirectory(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST' || removalInFlight(error)) return false;
    throw error;
  }
}

function removeLockDirectory(lockPath: string, marker: string): boolean {
  try {
    unlinkSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || removalInFlight(error)) return false;
    throw error;
  }
  try {
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException)?.code ?? '')) return false;
    if (removalInFlight(error)) return false;
    throw error;
  }
}

function takeLockDirectory(lockPath: string, claim: ClaimHandle): string | null {
  if (!createLockDirectory(lockPath)) {
    let entries: string[];
    try {
      entries = readdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || removalInFlight(error)) return null;
      throw error;
    }
    const name = entries.length === 1 ? entries[0] : undefined;
    if (!name || !OWNER_MARKER.test(name)) return null;
    const marker = join(lockPath, name);
    let entry;
    try {
      entry = lstatSync(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || removalInFlight(error)) return null;
      throw error;
    }
    if (!entry.isFile() || entry.size !== 0) {
      throw new ClaimRefusedError({
        root: lockPath,
        claimPath: lockPath,
        label: 'directory lock',
        reason: `its compatibility marker ${name} is not an empty file`,
      });
    }
    if (!removeLockDirectory(lockPath, marker) || !createLockDirectory(lockPath)) return null;
  }
  const marker = join(lockPath, `.stim-claim-${claim.claimId}`);
  try {
    writeFileSync(marker, '', { flag: 'wx' });
  } catch (error) {
    try {
      rmSync(marker, { force: true });
      rmdirSync(lockPath);
    } catch {}
    throw error;
  }
  return marker;
}

function acquireDirLock(
  lockPath: string,
  {
    waitMs,
    pollMs,
    ensureParent,
  }: Required<Pick<DirLockOptions, 'waitMs' | 'pollMs'>> & Pick<DirLockOptions, 'ensureParent'>,
): { claim: ClaimHandle; marker: string } {
  ensureParent?.();
  statSync(dirname(lockPath));
  const deadline = Date.now() + waitMs;
  let claim: ClaimHandle | undefined;
  try {
    for (;;) {
      if (!claim) {
        const attempt = tryAcquireClaim({ root: `${lockPath}.claims`, mode: 'exclusive', label: 'directory lock' });
        claim = attempt.acquired;
        if (attempt.pending) releaseClaim(attempt.pending);
      }
      if (claim) {
        const marker = takeLockDirectory(lockPath, claim);
        if (marker) return { claim, marker };
      }
      if (Date.now() >= deadline) {
        const error = new Error(
          `Timed out waiting for the lock at ${lockPath}. ` +
            (claim
              ? 'No current Stim holds it: the directory is empty, or an older Stim version holds or left it. ' +
                `If no older Stim is running, remove it and run the command again:\n  rm -rf ${quotedPath(lockPath)}`
              : 'Another Stim process is holding it; wait for that command to finish and run the command again.'),
        );
        (error as Error & { code?: string; lockPath?: string }).code = 'STIM_LOCK_TIMEOUT';
        (error as Error & { code?: string; lockPath?: string }).lockPath = lockPath;
        throw error;
      }
      sleepSync(pollMs);
    }
  } catch (error) {
    releaseClaim(claim);
    throw error;
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
  const { claim, marker } = acquireDirLock(lockPath, { waitMs, pollMs, ensureParent });
  lockDepths.set(lockPath, 1);
  try {
    return fn();
  } finally {
    lockDepths.set(lockPath, 0);
    try {
      removeLockDirectory(lockPath, marker);
    } catch {}
    releaseClaim(claim);
  }
}
