import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { lstat, readdir, stat as pathStat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { lastNativeUseFrom, type MaintenanceAction } from '@stim-cli/core/state';
import {
  agentSessionUse,
  candidateRoots,
  listedRoots,
  candidateRootsAsync,
  worktreeActivityOf,
  worktreeActivityOfAsync,
} from '../../commands/gc/worktrees.ts';
import { canonicalPath } from '../../commands/gc/paths.ts';
import {
  recentNativeUseReason,
  workspaceBuildReasons,
  workspaceBuildReasonsAsync,
} from '../../commands/gc/workspaces.ts';
import { reclaimKeys } from '../../commands/worktree.ts';
import { gitQuiet, gitQuietAsync } from '../../workspace/git.ts';
import { childEnvironment } from '../../workspace/git-read.ts';
import { withIdleWorkspace, workspaceInUse, workspaceInUseAsync } from '../../workspace/in-use.ts';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';
import {
  ARTIFACT_DIRS,
  discoveredBuildDirs,
  discoveredBuildDirsAsync,
  isBuildDirPath,
  type ArtifactKind,
} from '../../workspace/regenerable-dirs.ts';
import {
  readRunningProcesses,
  readRunningProcessesAsync,
  runningFromReason,
  type RunningProcesses,
} from '../../workspace/running-from.ts';
import { finishLightened, recordLightened, restoreProblem } from '../../workspace/lightened.ts';
import {
  listWorktrees,
  LOCKED_REASON,
  lockReason,
  matchWorktreeEntry,
  resolveSourceCheckoutAsync,
  sourceCheckoutOf,
  worktreeLockAsync,
  type SourceCheckout,
  type WorktreeEntry,
} from '../../workspace/worktree.ts';
import { lowestFree, measureDisk } from './measure.ts';

const PACKAGE_PARENTS = ['apps', 'packages'];
const SCAN_DEPTH: Record<ArtifactKind, number> = { build: 3, dependencies: 1 };
const SCAN_LIMIT = 20_000;

export interface ArtifactWorktree {
  path: string;
  linked: boolean;
  locked: boolean;
  keys: string[];
  /** Why a running agent session keeps the worktree, read when the worktrees were listed. */
  agents?: string[];
}

export interface ArtifactCandidate {
  worktree: string;
  path: string;
  keys: string[];
  locked: boolean;
  agents?: string[];
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function registeredRoots(roots: string[]): string[] {
  const registry = new Set(listedRoots());
  return roots.filter((root) => registry.has(root));
}

export function artifactWorktrees(): ArtifactWorktree[] {
  const found = new Map<string, ArtifactWorktree>();
  for (const root of registeredRoots(candidateRoots())) {
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
  return { path: entry.path, linked: entry.path !== source.path, locked: Boolean(entry.locked), keys };
}

/** The worktrees whose artifacts maintenance may clear, read without blocking when an operation is given. */
export function artifactWorktreesFor(
  operation: StimContext | undefined,
): ArtifactWorktree[] | Promise<ArtifactWorktree[]> {
  return operation ? artifactWorktreesAsync(operation.signal, operation) : artifactWorktrees();
}

export async function artifactWorktreesAsync(
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ArtifactWorktree[]> {
  const found = new Map<string, ArtifactWorktree>();
  for (const root of registeredRoots(await candidateRootsAsync(operation))) {
    signal.throwIfAborted();
    const { entries, ...source } = await resolveSourceCheckoutAsync(root, {
      env: operation?.env,
      signal,
      declareFor: operation,
    });
    const entry = artifactWorktree(root, entries, source);
    if (entry) found.set(entry.path, entry);
  }
  const linked = [...found.values()].filter((entry) => entry.linked);
  if (linked.length) {
    const agents = await agentSessionUse(
      linked.map((entry) => entry.path),
      Date.now(),
      signal,
    );
    linked.forEach((entry, i) => {
      entry.agents = agents[i] ?? [];
    });
  }
  return [...found.values()];
}

/** The directories of `kind` that `base` may hold: the fixed names, and for build output the discovered ones. */
function artifactPaths(base: string, kind: ArtifactKind): string[] {
  return [...ARTIFACT_DIRS[kind].map((dir) => join(base, dir)), ...(kind === 'build' ? discoveredBuildDirs(base) : [])];
}

async function artifactPathsAsync(base: string, kind: ArtifactKind): Promise<string[]> {
  return [
    ...ARTIFACT_DIRS[kind].map((dir) => join(base, dir)),
    ...(kind === 'build' ? await discoveredBuildDirsAsync(base) : []),
  ];
}

function isKnownDir(kind: ArtifactKind, path: string): boolean {
  return kind === 'build'
    ? isBuildDirPath(path)
    : ARTIFACT_DIRS[kind].some((dir) => path.endsWith(`${sep}${dir.split('/').join(sep)}`));
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

type ArtifactReads = {
  tracked: string | null;
  activity: ReturnType<typeof worktreeActivityOf>;
  written: number | null;
};

async function artifactReads(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ArtifactReads> {
  const { worktree, path, keys } = candidate;
  const tracked = await gitQuietAsync(worktree, ['ls-files', '--', relative(worktree, path)], {
    ...(operation ? childEnvironment(operation.env) : {}),
    cwd: operation?.cwd,
    signal,
    declareFor: operation,
    killSignal: 'SIGKILL',
  });
  const windowed = tracked !== null && !tracked.trim() && kind === 'dependencies';
  const activity = windowed ? await worktreeActivityOfAsync(worktree, keys, operation) : null;
  const written = windowed ? await newestWriteAsync(path, SCAN_DEPTH[kind], signal) : null;
  return { tracked, activity, written };
}

async function pinsOf(
  keys: readonly string[],
  pinned: (workspace: string) => boolean | Promise<boolean>,
): Promise<(workspace: string) => boolean> {
  const pins = new Map<string, boolean>();
  for (const key of keys) pins.set(key, await pinned(key));
  return (workspace) => pins.get(workspace) ?? true;
}

type InUseReader = (workspace: string) => string[];

function inUseNow(kind: ArtifactKind, locked: string | undefined): InUseReader {
  return (key) =>
    kind === 'build'
      ? workspaceBuildReasons(key, { nativeRun: key !== locked })
      : workspaceInUse(key, { nativeRun: key !== locked });
}

async function inUseOf(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  signal: AbortSignal,
  operation: StimContext | undefined,
  locked?: string,
): Promise<InUseReader> {
  const reasons = new Map<string, string[]>();
  for (const key of candidate.keys) {
    const nativeRun = key !== locked;
    reasons.set(
      key,
      kind === 'build'
        ? await workspaceBuildReasonsAsync(key, signal, operation, { nativeRun })
        : await workspaceInUseAsync(key, { nativeRun }, signal, operation),
    );
  }
  return (key) => reasons.get(key) ?? [];
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
    inUse,
  }: {
    now: number;
    windowMs: number;
    pinned: (workspace: string) => boolean;
    locked?: string;
    running?: RunningProcesses | null;
    inUse?: InUseReader;
  },
  reads?: ArtifactReads,
): string | null {
  const guarded = artifactGuard(candidate, kind, pinned, locked, running, inUse);
  if (guarded) return guarded;
  const { worktree, path, keys } = candidate;
  const tracked = reads ? reads.tracked : gitQuiet(worktree, ['ls-files', '--', relative(worktree, path)]);
  if (tracked === null) return 'git cannot tell whether it holds tracked files';
  if (tracked.trim()) return 'it holds files git tracks';
  if (kind === 'build') return buildNativeUseReason(keys, now);
  const activity = reads ? reads.activity : worktreeActivityOf(worktree, keys);
  const written = reads ? reads.written : newestWrite(path, SCAN_DEPTH[kind]);
  if (!activity || written === null) return 'its last activity cannot be read';
  const last = Math.max(activity.at, written);
  if (windowMs > 0 && now - last < windowMs) return `used within the last ${Math.round(windowMs / 60_000)} minutes`;
  return null;
}

function buildNativeUseReason(keys: readonly string[], now: number): string | null {
  const states = keys.map((key) => readWorkspaceState(key)).filter((state) => state !== null);
  if (!states.length) return 'no Stim workspace records when it last ran ios, android or macos';
  return recentNativeUseReason(
    Math.max(...states.map((state) => lastNativeUseFrom(state)).filter(Number.isFinite)),
    now,
  );
}

function artifactGuard(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  pinned: (workspace: string) => boolean,
  locked?: string,
  running?: RunningProcesses | null,
  inUse: InUseReader = inUseNow(kind, locked),
): string | null {
  const { worktree, path, keys } = candidate;
  if (keys.some(pinned)) return 'pinned by maintenance.keep';
  if (candidate.locked) return LOCKED_REASON;
  if (candidate.agents?.length) return `in use: ${candidate.agents.join('; ')}`;
  if (!pathExists(path)) return 'it is already gone';
  let real: string;
  try {
    real = canonicalPath(path);
  } catch {
    return 'its path cannot be resolved';
  }
  if (!isDirectory(path) || real !== join(canonicalPath(worktree), relative(worktree, path)))
    return 'it or a directory above it is a link, or it lies outside its worktree';
  const reasons = keys.flatMap(inUse);
  if (reasons.length) return `in use: ${reasons.join('; ')}`;
  if (kind === 'dependencies')
    return runningFromReason(worktree, running === undefined ? readRunningProcesses() : running);
  return null;
}

export async function collectArtifactsAsync(
  kind: ArtifactKind,
  options: {
    now: number;
    windowMs: number;
    protectedRoot: string;
    pinned: (workspace: string) => boolean | Promise<boolean>;
  },
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ReturnType<typeof collectArtifacts>> {
  const candidates: ArtifactCandidate[] = [];
  const skips: { target: string; reason: string }[] = [];
  const running = kind === 'dependencies' ? await readRunningProcessesAsync(signal) : null;
  for (const worktree of await artifactWorktreesAsync(signal, operation)) {
    if (kind === 'dependencies' && !worktree.linked) continue;
    const root = canonicalPath(worktree.path);
    const protectedHere = options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`);
    const pinned = await pinsOf(worktree.keys, options.pinned);
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
      for (const path of await artifactPathsAsync(base, kind)) {
        signal.throwIfAborted();
        try {
          await pathStat(path);
        } catch {
          signal.throwIfAborted();
          continue;
        }
        const candidate = {
          worktree: worktree.path,
          path,
          keys: worktree.keys,
          locked: worktree.locked,
          agents: worktree.agents,
        };
        const inUse = protectedHere ? null : await inUseOf(candidate, kind, signal, operation);
        let reason = !inUse
          ? 'the command that started this pass runs inside its worktree'
          : artifactGuard(candidate, kind, pinned, undefined, running, inUse);
        if (!reason)
          reason = keptReason(
            candidate,
            kind,
            { ...options, pinned, running, ...(inUse ? { inUse } : {}) },
            await artifactReads(candidate, kind, signal, operation),
          );
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
      for (const path of artifactPaths(base, kind)) {
        try {
          statSync(path);
        } catch {
          continue;
        }
        const candidate = { worktree: worktree.path, path, keys: worktree.keys, locked: worktree.locked };
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
    pinned: (workspace: string) => boolean | Promise<boolean>;
    worktrees: readonly ArtifactWorktree[];
    /** Keep dependencies that worktree warm could not restore with the same versions. */
    requireRestorable?: boolean;
    restoreCache?: Parameters<typeof restoreProblem>[1];
    /** Why the workspace is no longer idle, asked again under its native-run claim; null when it still is. */
    recheck?: (workspace: string) => Promise<string | null>;
    operation?: StimContext;
  },
): Promise<{ status: 'done' | 'kept'; bytes: number; detail: string }> {
  const { operation } = options;
  const signal = operation?.signal ?? new AbortController().signal;
  const worktree = options.worktrees
    .filter((entry) => action.target.startsWith(`${entry.path}${sep}`))
    .reduce<ArtifactWorktree | null>(
      (best, entry) => (best && best.path.length >= entry.path.length ? best : entry),
      null,
    );
  if (kind === 'dependencies' && worktree && !worktree.linked)
    return { status: 'kept', bytes: 0, detail: 'it is in the source checkout' };
  if (!worktree || !isKnownDir(kind, action.target))
    return { status: 'kept', bytes: 0, detail: 'it is no longer a regenerable directory of a known worktree' };
  const root = canonicalPath(worktree.path);
  if (options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`))
    return { status: 'kept', bytes: 0, detail: 'the command that started this pass runs inside its worktree' };
  const agents = worktree.linked ? ((await agentSessionUse([worktree.path], Date.now(), signal))[0] ?? []) : [];
  const candidate = {
    worktree: worktree.path,
    path: action.target,
    keys: worktree.keys,
    locked: worktree.locked,
    agents,
  };
  const running = kind === 'dependencies' ? await readRunningProcessesAsync() : null;
  const pinned = await pinsOf(candidate.keys, options.pinned);
  const early = keptReason(
    candidate,
    kind,
    { ...options, pinned, now: Date.now(), running, inUse: await inUseOf(candidate, kind, signal, operation) },
    await artifactReads(candidate, kind, signal, operation),
  );
  if (early) return { status: 'kept', bytes: 0, detail: early };
  const unrestorable =
    kind === 'dependencies' ? await restoreProblem(candidate, options.restoreCache, operation) : null;
  if (unrestorable && options.requireRestorable) return { status: 'kept', bytes: 0, detail: unrestorable };
  const before = lowestFree(measureDisk());
  const [key] = candidate.keys;
  const remove = async () => {
    const lock = candidate.locked ? 'locked' : await worktreeLockAsync(candidate.worktree);
    if (lock) return lockReason(lock);
    const reason = keptReason(
      candidate,
      kind,
      {
        ...options,
        pinned: await pinsOf(candidate.keys, options.pinned),
        now: Date.now(),
        running: kind === 'dependencies' ? await readRunningProcessesAsync() : null,
        inUse: await inUseOf(candidate, kind, signal, operation, key),
        ...(key ? { locked: key } : {}),
      },
      await artifactReads(candidate, kind, signal, operation),
    );
    if (reason) return reason;
    const late = key && options.recheck ? await options.recheck(key) : null;
    if (late) return late;
    const record = kind === 'dependencies';
    if (record) recordLightened(candidate.keys, candidate.path);
    rmSync(candidate.path, { recursive: true, force: true });
    if (record) finishLightened(candidate.keys, candidate.path);
    return null;
  };
  const kept = key
    ? await withIdleWorkspace(key, remove, {
        purpose: 'maintenance',
        supervisor: kind === 'dependencies',
        ...(kind === 'build' ? { hosted: false, managedLocks: false } : {}),
        operation,
      }).then((run) => (run.ran ? run.value : `in use: ${run.reasons.join('; ')}`))
    : await remove();
  if (kept) return { status: 'kept', bytes: 0, detail: kept };
  const freed = Math.max(0, lowestFree(measureDisk()) - before);
  return {
    status: 'done',
    bytes: Number.isFinite(freed) ? Math.round(freed * 1024 * 1024) : 0,
    detail: candidate.path,
  };
}
