import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { MaintenanceAction } from '@stim-cli/core/state';
import { candidateRoots, worktreeActivityOf } from '../commands/gc/worktrees.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { matchWorktreeEntry, reclaimKeys } from '../commands/worktree.ts';
import { gitQuiet } from '../workspace/git.ts';
import { withIdleWorkspace, workspaceInUse } from '../workspace/in-use.ts';
import { listWorktrees, sourceCheckoutOf } from '../workspace/worktree.ts';
import { measureDisk } from './measure.ts';
import { lowestFree } from './pressure.ts';

export type ArtifactKind = 'build' | 'dependencies';

/** Directories that hold only what a build or an install regenerates, relative to an app or package root. */
const ARTIFACT_DIRS: Record<ArtifactKind, readonly string[]> = {
  build: ['ios/build', 'android/app/build', 'android/build', 'android/.gradle', '.build'],
  dependencies: ['node_modules', 'ios/Pods'],
};

const PACKAGE_PARENTS = ['apps', 'packages'];
const SCAN_DEPTH: Record<ArtifactKind, number> = { build: 3, dependencies: 1 };
const SCAN_LIMIT = 20_000;

interface Worktree {
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

function worktrees(): Worktree[] {
  const found = new Map<string, Worktree>();
  for (const root of candidateRoots()) {
    const entries = listWorktrees(root);
    const entry = matchWorktreeEntry(entries, root);
    const source = sourceCheckoutOf(entries);
    if (!entry || entry.bare || 'refusal' in source || found.has(entry.path)) continue;
    const keys = reclaimKeys(entry.path).filter((key) => matchWorktreeEntry(entries, key)?.path === entry.path);
    found.set(entry.path, { path: entry.path, linked: entry.path !== source.path, keys });
  }
  return [...found.values()];
}

function appRoots(worktree: Worktree, kind: ArtifactKind): string[] {
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

function keptReason(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  {
    now,
    windowMs,
    pinned,
    locked,
  }: { now: number; windowMs: number; pinned: (workspace: string) => boolean; locked?: string },
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
  const tracked = gitQuiet(worktree, ['ls-files', '--', relative(worktree, path)]);
  if (tracked === null) return 'git cannot tell whether it holds tracked files';
  if (tracked.trim()) return 'it holds files git tracks';
  const activity = worktreeActivityOf(worktree, keys);
  const written = newestWrite(path, SCAN_DEPTH[kind]);
  if (!activity || written === null) return 'its last activity cannot be read';
  const last = Math.max(activity.at, written);
  if (now - last < windowMs) return `used within the last ${Math.round(windowMs / 60_000)} minutes`;
  return null;
}

/** Regenerable directories of idle worktrees, oldest activity first; dependencies only in linked worktrees. */
export function collectArtifacts(
  kind: ArtifactKind,
  options: { now: number; windowMs: number; protectedRoot: string; pinned: (workspace: string) => boolean },
): { candidates: ArtifactCandidate[]; skips: { target: string; reason: string }[] } {
  const candidates: ArtifactCandidate[] = [];
  const skips: { target: string; reason: string }[] = [];
  for (const worktree of worktrees()) {
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
          : keptReason(candidate, kind, options);
        if (reason) skips.push({ target: path, reason });
        else candidates.push(candidate);
      }
  }
  return { candidates, skips };
}

export async function clearArtifact(
  action: MaintenanceAction,
  kind: ArtifactKind,
  options: { windowMs: number; protectedRoot: string; pinned: (workspace: string) => boolean },
): Promise<{ status: 'done' | 'kept'; bytes: number; detail: string }> {
  const worktree = worktrees().find(
    (entry) => action.target.startsWith(`${entry.path}${sep}`) && (kind === 'build' || entry.linked),
  );
  if (!worktree || !ARTIFACT_DIRS[kind].some((dir) => action.target.endsWith(`${sep}${dir.split('/').join(sep)}`)))
    return { status: 'kept', bytes: 0, detail: 'it is no longer a regenerable directory of a known worktree' };
  const root = canonicalPath(worktree.path);
  if (options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`))
    return { status: 'kept', bytes: 0, detail: 'the command that started this pass runs inside its worktree' };
  const candidate = { worktree: worktree.path, path: action.target, keys: worktree.keys };
  const early = keptReason(candidate, kind, { ...options, now: Date.now() });
  if (early) return { status: 'kept', bytes: 0, detail: early };
  const before = lowestFree(measureDisk());
  const [key] = candidate.keys;
  const remove = () => {
    const reason = keptReason(candidate, kind, { ...options, now: Date.now(), ...(key ? { locked: key } : {}) });
    if (reason) return reason;
    rmSync(candidate.path, { recursive: true, force: true });
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
