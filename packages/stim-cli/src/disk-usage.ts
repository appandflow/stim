import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
  readDiskUsageFailureSignature,
  readDiskUsagePartial,
  readDiskUsageCloneGroup,
  type DiskMeasure,
} from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { debugLog } from './debug-log.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from './engine/spawn-claims.ts';
import { INSTALL_MARKERS, installSignature, measureTree, treeSignature, type TreeSize } from './private-size.ts';
import { lastSizeFailure } from './size-failures.ts';
import { ARTIFACT_DIRS } from './workspace/regenerable-dirs.ts';
import { answered, hungRead, READ_TIMEOUT_MS, Unanswered } from './workspace/bounded-read.ts';

const DEPENDENCY_MAX_AGE_MS: number = 6 * 60 * 60_000;
const DEPENDENCY_BACKSTOP_MS: number = 24 * 60 * 60_000;
const ABSENT = 'absent';

/** Whether `path` is a `node_modules` or `ios/Pods` folder, the trees whose measurement carries an install signature. */
export function isDependencyTree(path: string): boolean {
  return ARTIFACT_DIRS.dependencies.some((name) => path.endsWith(`${sep}${name.split('/').join(sep)}`));
}

function cloneMembers(own: string, suffix: string, roots: readonly string[]): string[] {
  return [...new Set([own, ...roots].map((root) => join(root, suffix)))].toSorted();
}

/** The clone members through bounded filesystem reads; null when a read did not answer. Aborts propagate. */
async function dependencyCloneMembersAsync(path: string, signal?: AbortSignal): Promise<string[] | null> {
  const read = async <T>(label: string, start: () => Promise<T>): Promise<T | null> => {
    try {
      return await answered(label, start, READ_TIMEOUT_MS, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Unanswered) throw error;
      return null;
    }
  };
  try {
    signal?.throwIfAborted();
    if (hungRead() !== null) return null;
    const parent = await read(dirname(path), () => realpath(dirname(path)));
    if (parent === null) return [];
    for (let own = parent; ; own = dirname(own)) {
      const dotGit = join(own, '.git');
      const info = await read(dotGit, () => stat(dotGit));
      if (info) {
        let common: string | null;
        if (info.isDirectory()) common = await read(dotGit, () => realpath(dotGit));
        else {
          const content = await read(dotGit, () => readFile(dotGit, 'utf-8'));
          const gitdir = content && /^gitdir: (.+)$/m.exec(content)?.[1]?.trim();
          if (!gitdir) return [];
          const linked = resolve(own, gitdir);
          const commondir = join(linked, 'commondir');
          const commonInfo = await read(commondir, () => stat(commondir));
          const value = commonInfo ? await read(commondir, () => readFile(commondir, 'utf-8')) : null;
          if (commonInfo && value === null) return [];
          const target = value !== null ? resolve(linked, value.trim()) : linked;
          common = await read(target, () => realpath(target));
        }
        if (common === null) return [];
        const roots: string[] = [];
        if (basename(common) === '.git') roots.push(dirname(common));
        const admin = join(common, 'worktrees');
        const ids = await read(admin, () => readdir(admin));
        for (const id of ids ?? []) {
          const file = join(admin, id, 'gitdir');
          const content = await read(file, () => readFile(file, 'utf-8'));
          if (content !== null) roots.push(dirname(resolve(admin, id, content.trim())));
        }
        if (hungRead() !== null) return null;
        return cloneMembers(own, relative(own, join(parent, basename(path))), roots);
      }
      if (dirname(own) === own) return [];
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Unanswered) return null;
    throw error;
  }
}

/** A stable stamp of member paths and their install signatures; null signatures represent absent trees. */
function dependencyCloneStamp(members: readonly (readonly [string, string | null])[]): string {
  const lines = members.map(([path, signature]) => `${path}\0${signature ?? ABSENT}`).toSorted();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** The current clone-group stamp through bounded reads, or null when a read did not answer. */
export async function dependencyCloneGroup(
  path: string,
  signal?: AbortSignal,
  readSignature?: (path: string) => Promise<string | null>,
): Promise<string | null> {
  const stamp = async (file: string): Promise<string | null> => {
    try {
      const info = await answered(file, () => lstat(file), READ_TIMEOUT_MS, signal);
      return `${info.ino}:${info.mtimeMs}`;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Unanswered) throw error;
      return null;
    }
  };
  const signature =
    readSignature ??
    (async (member: string) => {
      const root = await stamp(member);
      if (root === null) return null;
      const markers: (string | null)[] = [];
      for (const name of INSTALL_MARKERS) markers.push(await stamp(join(member, name)));
      return installSignature(root, markers);
    });
  try {
    const paths = await dependencyCloneMembersAsync(path, signal);
    if (paths === null) return null;
    const members: [string, string | null][] = [];
    for (const member of paths) {
      members.push([member, await signature(member)]);
      if (hungRead() !== null) return null;
    }
    return dependencyCloneStamp(members);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Unanswered) return null;
    throw error;
  }
}

function currentSignature(path: string): string {
  return treeSignature(path) ?? ABSENT;
}

/**
 * The cached measurement of the folder at `path` that every surface (`status`, `gc`, the daemon's cleanup) may report
 * and act on: a dependency tree's counts only while its install signature still matches, since a reinstall or a fresh
 * clone changes both its allocated and its private bytes. Null when the folder was not measured or the entry is stale.
 */
export function trustedMeasure(path: string, signature?: string): DiskMeasure | null {
  const measure = readDiskUsage(path);
  if (!measure) return null;
  if (!isDependencyTree(path)) return measure;
  return measure.signature === (signature ?? currentSignature(path)) ? measure : null;
}

/** What deleting the dependency tree at `path` would free: its private bytes, or null when they are not known. */
export function knownPrivateBytes(path: string): number | null {
  return trustedMeasure(path)?.privateBytes ?? null;
}

/** A fresh trusted measurement, requiring a supplied matching clone-group stamp for dependencies past six hours. */
export function freshMeasure(
  path: string,
  {
    maxAgeMs = DEPENDENCY_MAX_AGE_MS,
    valid,
    now = Date.now,
    signature,
    cloneGroup,
  }: Pick<RefreshOptions, 'maxAgeMs' | 'valid' | 'now' | 'signature' | 'cloneGroup'> = {},
): DiskMeasure | null {
  const measure = trustedMeasure(path, signature);
  if (!measure) return null;
  const age = now() - Date.parse(measure.measuredAt);
  if (!(valid?.(measure) ?? true)) return null;
  if (!isDependencyTree(path)) return age < maxAgeMs ? measure : null;
  if (age < DEPENDENCY_MAX_AGE_MS) return measure;
  if (age >= DEPENDENCY_BACKSTOP_MS) return null;
  const recorded = readDiskUsageCloneGroup(path);
  if (recorded === null) return null;
  return cloneGroup !== undefined && recorded === cloneGroup ? measure : null;
}

function holdOn(claim: ClaimHandle): (child: ChildProcess) => void {
  return (child) => {
    if (child.pid === undefined) return;
    const captured = captureProcessIdentity(child.pid);
    if (!captured.ok) {
      if (captured.code === 'NOT_FOUND') {
        const pid = child.pid;
        recordIdentityUnlessExited(
          child,
          (processToken) => setClaimChild(claim, { pid, processToken }),
          (reason) => debugLog.log('disk-walk-stopped', { reason }),
        );
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
   * left alone when `failures` is set. Dependency trees are reused while their install is unchanged, for six hours
   * unconditionally, then while their clone group is unchanged, with a one-day backstop.
   */
  maxAgeMs?: number;
  now?: () => number;
  /**
   * Takes the machine-wide disk-usage walk claim, so one walk runs at a time across processes. When it is held the
   * outcome is `busy`.
   */
  claim?: boolean;
  /** Whether a walk without the walk claim runs at low priority; by default only one outside an operation does. */
  lowPriority?: boolean;
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
  /**
   * Asked under the walk claim, right before a walk would start: false leaves the folder unwalked with the outcome
   * `busy`.
   */
  admit?: () => boolean;
  /** Called once the walk is over, whatever its outcome, before the walk claim is released. */
  settled?: () => void;
  /**
   * The caller has established, through a bounded read, that `path` exists: do not probe it. Without it the folder is
   * probed with a synchronous `existsSync`, which a stalled mount can block.
   */
  knownToExist?: true;
  /**
   * The dependency tree's install signature, read by the caller through a bounded read. Without it the signature is
   * read with synchronous stats, which a stalled mount can block.
   */
  signature?: string;
  /** A supplied current stamp; otherwise refresh reads it asynchronously unless `signature` is supplied alone. */
  cloneGroup?: string;
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
): Promise<{ outcome: RefreshOutcome; measure: DiskMeasure | null; partial?: true }> {
  const { operation } = options;
  operation?.signal.throwIfAborted();
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEPENDENCY_MAX_AGE_MS;
  const dependency = isDependencyTree(path);
  const failedRecently = () => {
    const failedAt = options.failures ? readDiskUsageFailure(path) : null;
    if (failedAt === null || now() - Date.parse(failedAt) >= maxAgeMs) return false;
    return !dependency || readDiskUsageFailureSignature(path) === (options.signature ?? treeSignature(path));
  };
  let cloneGroup = options.cloneGroup;
  let groupRead = false;
  const resolveGroup = async () => {
    if (!dependency || cloneGroup !== undefined || options.signature !== undefined || groupRead) return;
    groupRead = true;
    cloneGroup = (await dependencyCloneGroup(path, operation?.signal)) ?? undefined;
  };
  const skip = async () => {
    if (dependency && cloneGroup === undefined && options.signature === undefined) {
      const cached = trustedMeasure(path);
      const age = cached ? now() - Date.parse(cached.measuredAt) : -1;
      if (age >= DEPENDENCY_MAX_AGE_MS && age < DEPENDENCY_BACKSTOP_MS && readDiskUsageCloneGroup(path) !== null)
        await resolveGroup();
    }
    return freshMeasure(path, { ...options, cloneGroup }) !== null || failedRecently();
  };
  const fresh = () => {
    const measure = freshMeasure(path, { ...options, cloneGroup });
    return {
      outcome: 'fresh' as const,
      measure,
      ...(measure && readDiskUsagePartial(path) ? { partial: true as const } : {}),
    };
  };
  if (await skip()) return fresh();
  const record = (
    bytes: number,
    privateBytes: number | null,
    signature: string | null,
    at: number,
    walkMs: number | null,
    partial?: true,
    privateUnknown?: 'volume' | 'walk',
  ): DiskMeasure => {
    const measure: DiskMeasure = {
      bytes,
      measuredAt: new Date(at).toISOString(),
      ...(privateBytes !== null ? { privateBytes } : {}),
      ...(signature ? { signature } : {}),
    };
    writeCacheFile(diskUsageCacheFile(path), {
      path,
      ...measure,
      ...(cloneGroup !== undefined ? { cloneGroup } : {}),
      ...(walkMs !== null ? { walkMs } : {}),
      ...(partial ? { partial } : {}),
      ...(privateBytes === null && privateUnknown ? { privateUnknown } : {}),
    });
    return measure;
  };
  if (options.knownToExist !== true && !existsSync(path)) {
    if (!dependency) return { outcome: 'fresh', measure: null };
    await resolveGroup();
    return {
      outcome: 'measured',
      measure: record(0, 0, ABSENT, now(), null),
    };
  }
  const claim = options.claim ? takeWalkClaim() : null;
  if (options.claim && !claim) return { outcome: 'busy', measure: null };
  let cleanupUnverified = false;
  try {
    if (claim && (await skip())) return fresh();
    if (options.admit && !options.admit()) return { outcome: 'busy', measure: null };
    const startedAt = now();
    const signature = dependency ? (options.signature ?? treeSignature(path)) : null;
    await resolveGroup();
    const targets = options.targets?.();
    let size: TreeSize | null;
    if (targets && !targets.length) size = { bytes: 0, privateBytes: null };
    else {
      if (claim) {
        if (operation) declareSpawnsOn(operation, claim);
        else markClaimChildPending(claim);
      }
      size = await measureTree(path, {
        timeoutMs: options.timeoutMs,
        operation,
        ...(claim
          ? { lowPriority: true }
          : options.lowPriority !== undefined
            ? { lowPriority: options.lowPriority }
            : {}),
        ...(claim && !operation ? { onSpawn: holdOn(claim) } : {}),
        ...(targets ? { targets } : {}),
        ...((options.private ?? dependency) ? {} : { private: false }),
      });
    }
    operation?.signal.throwIfAborted();
    if (!size) {
      if (options.failures)
        writeCacheFile(diskUsageFailureFile(path), {
          path,
          failedAt: new Date(now()).toISOString(),
          ...(signature ? { signature } : {}),
          ...lastSizeFailure(path),
        });
      return { outcome: 'failed', measure: null };
    }
    return {
      outcome: 'measured',
      measure: record(
        size.bytes,
        size.privateBytes,
        signature,
        startedAt,
        Math.max(0, now() - startedAt),
        size.partial,
        size.privateUnknown,
      ),
      ...(size.partial ? { partial: true as const } : {}),
    };
  } catch (error) {
    cleanupUnverified = error instanceof Error && 'reportCleanup' in error;
    throw error;
  } finally {
    if (operation) stopDeclaringSpawnsOn(operation, claim);
    options.settled?.();
    if (!cleanupUnverified) releaseClaim(claim);
  }
}
