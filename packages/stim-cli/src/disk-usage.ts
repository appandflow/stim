import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import {
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, recordIdentityUnlessExited } from '@stim-cli/core/process-identity';
import {
  diskUsageCacheFile,
  diskUsageFailureFile,
  diskUsageWalkClaims,
  readDiskUsage,
  readDiskUsageFailure,
  type DiskMeasure,
} from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { debugLog } from './debug-log.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from './engine/spawn-claims.ts';
import { measureTree, treeSignature } from './private-size.ts';
import { ARTIFACT_DIRS } from './workspace/regenerable-dirs.ts';

const DEPENDENCY_MAX_AGE_MS: number = 6 * 60 * 60_000;
const ABSENT = 'absent';

/** Whether `path` is a `node_modules` or `ios/Pods` folder, the trees whose measurement carries an install signature. */
export function isDependencyTree(path: string): boolean {
  return ARTIFACT_DIRS.dependencies.some((name) => path.endsWith(`${sep}${name.split('/').join(sep)}`));
}

function currentSignature(path: string): string {
  return treeSignature(path) ?? ABSENT;
}

/**
 * The cached measurement of the folder at `path` that every surface (`status`, `gc`, the daemon's cleanup) may report
 * and act on: a dependency tree's counts only while its install signature still matches, since a reinstall or a fresh
 * clone changes both its allocated and its private bytes. Null when the folder was not measured or the entry is stale.
 */
export function trustedMeasure(path: string): DiskMeasure | null {
  const measure = readDiskUsage(path);
  if (!measure) return null;
  if (!isDependencyTree(path)) return measure;
  return measure.signature === currentSignature(path) ? measure : null;
}

/** What deleting the dependency tree at `path` would free: its private bytes, or null when they are not known. */
export function knownPrivateBytes(path: string): number | null {
  return trustedMeasure(path)?.privateBytes ?? null;
}

/** The trusted measurement of `path` when it is fresh enough for a caller with `maxAgeMs` and `valid`, else null. */
export function freshMeasure(
  path: string,
  { maxAgeMs = DEPENDENCY_MAX_AGE_MS, valid, now = Date.now }: Pick<RefreshOptions, 'maxAgeMs' | 'valid' | 'now'> = {},
): DiskMeasure | null {
  const measure = trustedMeasure(path);
  if (!measure) return null;
  const limit = isDependencyTree(path) ? DEPENDENCY_MAX_AGE_MS : maxAgeMs;
  return now() - Date.parse(measure.measuredAt) < limit && (valid?.(measure) ?? true) ? measure : null;
}

function holdOn(claim: ClaimHandle): (child: ChildProcess) => void {
  return (child) => {
    if (child.pid === undefined) return;
    const captured = captureProcessIdentity(child.pid);
    if (!captured.ok) {
      if (captured.code === 'NOT_FOUND') {
        const pid = child.pid;
        recordIdentityUnlessExited(child, (processToken) => setClaimChild(claim, { pid, processToken }));
        return;
      }
      throw new Error(`Cannot record the disk usage walk: ${captured.reason}`);
    }
    setClaimChild(claim, { pid: child.pid, processToken: captured.token });
  };
}

function takeWalkClaim(): ClaimHandle | null {
  try {
    const attempt = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'disk usage walk' });
    if (attempt.pending) releaseClaim(attempt.pending);
    return attempt.acquired ?? null;
  } catch (error) {
    debugLog.log('disk-walk-claim', { error: String((error as Error)?.message ?? error) });
    return null;
  }
}

export interface RefreshOptions {
  timeoutMs: number;
  /**
   * How long the measurement of a folder that is not a dependency tree stays fresh, and how long a failed walk is
   * left alone when `failures` is set. A dependency tree stays fresh for DEPENDENCY_MAX_AGE_MS while its signature
   * matches, whatever the caller.
   */
  maxAgeMs?: number;
  now?: () => number;
  /**
   * Takes the machine-wide disk-usage walk claim, so one walk runs at a time across processes. When it is held the
   * outcome is `busy`.
   */
  claim?: boolean;
  /** Declares the walk as a child of this operation, which the walk's abort also stops. */
  operation?: StimContext;
  /** The entries to sum instead of `path` itself, such as a checkout without the worktrees nested in it. */
  targets?: () => string[];
  /** Whether the walk also counts private bytes. Dependency trees do by default. */
  private?: boolean;
  /** Whether a cached measurement under `maxAgeMs` is still the folder's, such as a folder not changed since. */
  valid?: (measure: DiskMeasure) => boolean;
  /** Records a failed walk, and leaves the folder alone for `maxAgeMs` after it. */
  failures?: boolean;
}

export type RefreshOutcome = 'fresh' | 'measured' | 'failed' | 'busy';

/**
 * The one way to size a folder that more than one surface reports. Returns the folder's cached measurement when it is
 * fresh. Otherwise it walks the folder once, with the private-size helper on macOS for dependency trees and `private`
 * folders and `du -sk` elsewhere, and records the result in the disk-usage cache every surface reads, with a dependency
 * tree's install signature taken before the walk. The freshness check runs again under the walk claim, so a walk
 * another process finished meanwhile is not repeated.
 */
export async function refreshMeasure(
  path: string,
  options: RefreshOptions,
): Promise<{ outcome: RefreshOutcome; measure: DiskMeasure | null }> {
  const { operation } = options;
  operation?.signal.throwIfAborted();
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEPENDENCY_MAX_AGE_MS;
  const dependency = isDependencyTree(path);
  const failedRecently = () => {
    const failedAt = options.failures ? readDiskUsageFailure(path) : null;
    return failedAt !== null && now() - Date.parse(failedAt) < maxAgeMs;
  };
  const skip = () => freshMeasure(path, options) !== null || failedRecently();
  const fresh = () => ({ outcome: 'fresh' as const, measure: freshMeasure(path, options) });
  if (skip()) return fresh();
  const record = (bytes: number, privateBytes: number | null, signature: string | null, at: number): DiskMeasure => {
    const measure: DiskMeasure = {
      bytes,
      measuredAt: new Date(at).toISOString(),
      ...(privateBytes !== null ? { privateBytes } : {}),
      ...(signature ? { signature } : {}),
    };
    writeCacheFile(diskUsageCacheFile(path), { path, ...measure });
    return measure;
  };
  if (!existsSync(path)) {
    if (!dependency) return { outcome: 'fresh', measure: null };
    return { outcome: 'measured', measure: record(0, 0, ABSENT, now()) };
  }
  const claim = options.claim ? takeWalkClaim() : null;
  if (options.claim && !claim) return { outcome: 'busy', measure: null };
  let cleanupUnverified = false;
  try {
    if (claim && skip()) return fresh();
    const startedAt = now();
    const signature = dependency ? treeSignature(path) : null;
    const targets = options.targets?.();
    let size: { bytes: number; privateBytes: number | null } | null;
    if (targets && !targets.length) size = { bytes: 0, privateBytes: null };
    else {
      if (claim) {
        if (operation) declareSpawnsOn(operation, claim);
        else markClaimChildPending(claim);
      }
      size = await measureTree(path, {
        timeoutMs: options.timeoutMs,
        operation,
        ...(claim ? { lowPriority: true } : {}),
        ...(claim && !operation ? { onSpawn: holdOn(claim) } : {}),
        ...(targets ? { targets } : {}),
        ...((options.private ?? dependency) ? {} : { private: false }),
      });
    }
    operation?.signal.throwIfAborted();
    if (!size) {
      if (options.failures)
        writeCacheFile(diskUsageFailureFile(path), { path, failedAt: new Date(now()).toISOString() });
      return { outcome: 'failed', measure: null };
    }
    return { outcome: 'measured', measure: record(size.bytes, size.privateBytes, signature, startedAt) };
  } catch (error) {
    cleanupUnverified = error instanceof Error && 'reportCleanup' in error;
    throw error;
  } finally {
    if (operation) stopDeclaringSpawnsOn(operation, claim);
    if (!cleanupUnverified) releaseClaim(claim);
  }
}
