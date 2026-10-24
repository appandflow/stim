import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { lstat, readdir, stat as pathStat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import type { MaintenanceAction } from '@stim-cli/core/state';
import {
  candidateRoots,
  candidateRootsAsync,
  worktreeActivityOf,
  worktreeActivityOfAsync,
} from '../commands/gc/worktrees.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { matchWorktreeEntry, reclaimKeys } from '../commands/worktree.ts';
import { gitQuiet, gitQuietAsync } from '../workspace/git.ts';
import { childEnvironment } from '../workspace/git-read.ts';
import { withIdleWorkspace, workspaceInUse } from '../workspace/in-use.ts';
import { ARTIFACT_DIRS, type ArtifactKind } from '../workspace/regenerable-dirs.ts';
import { readRunningProcesses, runningFromReason, type RunningProcesses } from '../workspace/running-from.ts';
import { finishLightened, recordLightened, restoreProblem } from '../workspace/lightened.ts';
import {
  listWorktrees,
  resolveSourceCheckoutAsync,
  sourceCheckoutOf,
  type SourceCheckout,
  type WorktreeEntry,
} from '../workspace/worktree.ts';
import { measureDisk } from './measure.ts';
import { lowestFree } from './pressure.ts';

const PACKAGE_PARENTS = ['apps', 'packages'];
const SCAN_DEPTH: Record<ArtifactKind, number> = { build: 3, dependencies: 1 };
const SCAN_LIMIT = 20_000;

export interface ArtifactWorktree {
  path: string;
  linked: boolean;
  keys: string[];
}

export interface ArtifactCandidate {
  worktree: string;
  path: string;
  keys: string[];
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function artifactWorktrees(): ArtifactWorktree[] {
  const found = new Map<string, ArtifactWorktree>();
  for (const root of candidateRoots()) {
    const entry = artifactWorktree(root, listWorktrees(root));
    if (entry) found.set(entry.path, entry);
  }
  return [...found.values()];
}

function artifactWorktree(
  root: string,
  entries: WorktreeEntry[],
  source: SourceCheckout = sourceCheckoutOf(entries),
): ArtifactWorktree | null {
  const entry = matchWorktreeEntry(entries, root);
  if (!entry || entry.bare || 'refusal' in source) return null;
  const keys = reclaimKeys(entry.path).filter((key) => matchWorktreeEntry(entries, key)?.path === entry.path);
  return { path: entry.path, linked: entry.path !== source.path, keys };
}

async function artifactWorktreesAsync(signal: AbortSignal, operation?: StimContext): Promise<ArtifactWorktree[]> {
  const found = new Map<string, ArtifactWorktree>();
  for (const root of await candidateRootsAsync(operation)) {
    signal.throwIfAborted();
    const { entries, ...source } = await resolveSourceCheckoutAsync(root, {
      env: operation?.env,
      signal,
      declareFor: operation,
    });
    const entry = artifactWorktree(root, entries, source);
    if (entry) found.set(entry.path, entry);
  }
  return [...found.values()];
}

export function appRoots(worktree: ArtifactWorktree, kind: ArtifactKind): string[] {
  const roots = new Set([worktree.path, ...worktree.keys]);
  if (kind === 'build')
    for (const parent of PACKAGE_PARENTS) {
      const dir = join(worktree.path, parent);
      try {
        for (const name of readdirSync(dir)) if (isDirectory(join(dir, name))) roots.add(join(dir, name));
      } catch {}
    }
  return [...roots];
}

/** The newest mtime under `dir` down to `maxDepth`, or null when the tree is too large or unreadable to tell. */
function newestWrite(dir: string, maxDepth: number): number | null {
  let newest = 0;
  let seen = 0;
  const walk = (path: string, depth: number): boolean => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return false;
    }
    if (++seen > SCAN_LIMIT) return false;
    newest = Math.max(newest, stat.mtimeMs);
    if (depth === maxDepth || !stat.isDirectory()) return true;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return false;
    }
    return names.every((name) => walk(join(path, name), depth + 1));
  };
  return walk(dir, 0) ? newest : null;
}

async function newestWriteAsync(dir: string, maxDepth: number, signal: AbortSignal): Promise<number | null> {
  let newest = 0;
  let seen = 0;
  const walk = async (path: string, depth: number): Promise<boolean> => {
    signal.throwIfAborted();
    try {
      const stat = await lstat(path);
      if (++seen > SCAN_LIMIT) return false;
      newest = Math.max(newest, stat.mtimeMs);
      if (depth === maxDepth || !stat.isDirectory()) return true;
      for (const name of await readdir(path)) if (!(await walk(join(path, name), depth + 1))) return false;
      return true;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  return (await walk(dir, 0)) ? newest : null;
}

function keptReason(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  {
    now,
    windowMs,
    pinned,
    locked,
    running,
  }: {
    now: number;
    windowMs: number;
    pinned: (workspace: string) => boolean;
    locked?: string;
    running?: RunningProcesses | null;
  },
  reads?: { tracked: string | null; activity: ReturnType<typeof worktreeActivityOf>; written: number | null },
): string | null {
  const guarded = artifactGuard(candidate, kind, pinned, locked, running);
  if (guarded) return guarded;
  const { worktree, path, keys } = candidate;
  const tracked = reads ? reads.tracked : gitQuiet(worktree, ['ls-files', '--', relative(worktree, path)]);
  if (tracked === null) return 'git cannot tell whether it holds tracked files';
  if (tracked.trim()) return 'it holds files git tracks';
  const activity = reads ? reads.activity : worktreeActivityOf(worktree, keys);
  const written = reads ? reads.written : newestWrite(path, SCAN_DEPTH[kind]);
  if (!activity || written === null) return 'its last activity cannot be read';
  const last = Math.max(activity.at, written);
  if (now - last < windowMs) return `used within the last ${Math.round(windowMs / 60_000)} minutes`;
  return null;
}

function artifactGuard(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  pinned: (workspace: string) => boolean,
  locked?: string,
  running?: RunningProcesses | null,
): string | null {
  const { worktree, path, keys } = candidate;
  if (keys.some(pinned)) return 'pinned by maintenance.keep';
  let real: string;
  try {
    real = canonicalPath(path);
  } catch {
    return 'its path cannot be resolved';
  }
  if (!isDirectory(path) || real !== join(canonicalPath(worktree), relative(worktree, path)))
    return 'it or a directory above it is a link, or it lies outside its worktree';
  const inUse = keys.flatMap((key) =>
    workspaceInUse(key, { supervisor: kind === 'dependencies', nativeRun: key !== locked }),
  );
  if (inUse.length) return `in use: ${inUse.join('; ')}`;
  if (kind === 'dependencies')
    return runningFromReason(worktree, running === undefined ? readRunningProcesses() : running);
  return null;
}

export async function collectArtifactsAsync(
  kind: ArtifactKind,
  options: { now: number; windowMs: number; protectedRoot: string; pinned: (workspace: string) => boolean },
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ReturnType<typeof collectArtifacts>> {
  const candidates: ArtifactCandidate[] = [];
  const skips: { target: string; reason: string }[] = [];
  const running = kind === 'dependencies' ? readRunningProcesses() : null;
  for (const worktree of await artifactWorktreesAsync(signal, operation)) {
    if (kind === 'dependencies' && !worktree.linked) continue;
    const root = canonicalPath(worktree.path);
    const protectedHere = options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`);
    const bases = new Set([worktree.path, ...worktree.keys]);
    if (kind === 'build')
      for (const parent of PACKAGE_PARENTS) {
        const dir = join(worktree.path, parent);
        try {
          for (const name of await readdir(dir)) {
            signal.throwIfAborted();
            if ((await lstat(join(dir, name))).isDirectory()) bases.add(join(dir, name));
          }
        } catch {
          signal.throwIfAborted();
        }
      }
    for (const base of bases)
      for (const dir of ARTIFACT_DIRS[kind]) {
        signal.throwIfAborted();
        const path = join(base, dir);
        try {
          await pathStat(path);
        } catch {
          signal.throwIfAborted();
          continue;
        }
        const candidate = { worktree: worktree.path, path, keys: worktree.keys };
        let reason = protectedHere
          ? 'the command that started this pass runs inside its worktree'
          : artifactGuard(candidate, kind, options.pinned, undefined, running);
        if (!reason) {
          const tracked = await gitQuietAsync(worktree.path, ['ls-files', '--', relative(worktree.path, path)], {
            ...(operation ? childEnvironment(operation.env) : {}),
            cwd: operation?.cwd,
            signal,
            declareFor: operation,
            killSignal: 'SIGKILL',
          });
          const untracked = tracked !== null && !tracked.trim();
          const activity = untracked ? await worktreeActivityOfAsync(worktree.path, worktree.keys, operation) : null;
          const written = untracked ? await newestWriteAsync(path, SCAN_DEPTH[kind], signal) : null;
          reason = keptReason(candidate, kind, { ...options, running }, { tracked, activity, written });
        }
        if (reason) skips.push({ target: path, reason });
        else candidates.push(candidate);
      }
  }
  return { candidates, skips };
}

/** Regenerable directories of idle worktrees, oldest activity first; dependencies only in linked worktrees. */
export function collectArtifacts(
  kind: ArtifactKind,
  options: { now: number; windowMs: number; protectedRoot: string; pinned: (workspace: string) => boolean },
): { candidates: ArtifactCandidate[]; skips: { target: string; reason: string }[] } {
  const candidates: ArtifactCandidate[] = [];
  const skips: { target: string; reason: string }[] = [];
  const running = kind === 'dependencies' ? readRunningProcesses() : null;
  for (const worktree of artifactWorktrees()) {
    if (kind === 'dependencies' && !worktree.linked) continue;
    const root = canonicalPath(worktree.path);
    const protectedHere = options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`);
    for (const base of appRoots(worktree, kind))
      for (const dir of ARTIFACT_DIRS[kind]) {
        const path = join(base, dir);
        try {
          statSync(path);
        } catch {
          continue;
        }
        const candidate = { worktree: worktree.path, path, keys: worktree.keys };
        const reason = protectedHere
          ? 'the command that started this pass runs inside its worktree'
          : keptReason(candidate, kind, { ...options, running });
        if (reason) skips.push({ target: path, reason });
        else candidates.push(candidate);
      }
  }
  return { candidates, skips };
}

export async function clearArtifact(
  action: MaintenanceAction,
  kind: ArtifactKind,
  options: {
    windowMs: number;
    protectedRoot: string;
    pinned: (workspace: string) => boolean;
    worktrees: readonly ArtifactWorktree[];
    /** Keep dependencies that worktree warm could not restore, instead of deleting them without a restore record. */
    requireRestorable?: boolean;
    restoreCache?: Parameters<typeof restoreProblem>[1];
  },
): Promise<{ status: 'done' | 'kept'; bytes: number; detail: string }> {
  const worktree = options.worktrees
    .filter((entry) => action.target.startsWith(`${entry.path}${sep}`))
    .reduce<ArtifactWorktree | null>(
      (best, entry) => (best && best.path.length >= entry.path.length ? best : entry),
      null,
    );
  if (kind === 'dependencies' && worktree && !worktree.linked)
    return { status: 'kept', bytes: 0, detail: 'it is in the source checkout' };
  if (!worktree || !ARTIFACT_DIRS[kind].some((dir) => action.target.endsWith(`${sep}${dir.split('/').join(sep)}`)))
    return { status: 'kept', bytes: 0, detail: 'it is no longer a regenerable directory of a known worktree' };
  const root = canonicalPath(worktree.path);
  if (options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`))
    return { status: 'kept', bytes: 0, detail: 'the command that started this pass runs inside its worktree' };
  const candidate = { worktree: worktree.path, path: action.target, keys: worktree.keys };
  const early = keptReason(candidate, kind, { ...options, now: Date.now() });
  if (early) return { status: 'kept', bytes: 0, detail: early };
  const unrestorable = kind === 'dependencies' ? await restoreProblem(candidate, options.restoreCache) : null;
  if (unrestorable && options.requireRestorable) return { status: 'kept', bytes: 0, detail: unrestorable };
  const before = lowestFree(measureDisk());
  const [key] = candidate.keys;
  const remove = () => {
    const reason = keptReason(candidate, kind, { ...options, now: Date.now(), ...(key ? { locked: key } : {}) });
    if (reason) return reason;
    const record = kind === 'dependencies' && !unrestorable;
    if (record) recordLightened(candidate.keys, candidate.path);
    rmSync(candidate.path, { recursive: true, force: true });
    if (record) finishLightened(candidate.keys, candidate.path);
    return null;
  };
  const kept = key
    ? await withIdleWorkspace(key, remove, { purpose: 'maintenance', supervisor: kind === 'dependencies' }).then(
        (run) => (run.ran ? run.value : `in use: ${run.reasons.join('; ')}`),
      )
    : remove();
  if (kept) return { status: 'kept', bytes: 0, detail: kept };
  const freed = Math.max(0, lowestFree(measureDisk()) - before);
  return {
    status: 'done',
    bytes: Number.isFinite(freed) ? Math.round(freed * 1024 * 1024) : 0,
    detail: candidate.path,
  };
}
