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
import { loadConfig } from '../../workspace/config.ts';
import { discoverCheckouts } from '../../workspace/discovery.ts';
import { gitQuiet, gitQuietAsync } from '../../workspace/git.ts';
import { childEnvironment } from '../../workspace/git-read.ts';
import { withIdleWorkspace, workspaceInUse, workspaceInUseAsync } from '../../workspace/in-use.ts';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';
import {
  ARTIFACT_DIRS,
  discoveredBuildDirs,
  discoveredBuildDirsAsync,
  isBuildDirPath,
  regenerableDirProblem,
  type ArtifactKind,
} from '../../workspace/regenerable-dirs.ts';
import {
  readRunningProcesses,
  readRunningProcessesAsync,
  runningFromReason,
  type RunningProcesses,
} from '../../workspace/running-from.ts';
import { finishLightened, recordLightened, restoreProblem, workspaceKeys } from '../../workspace/lightened.ts';
import { recordSourceDependencies, takeWarmClaim, warmCopyingFrom } from '../../workspace/source-dependencies.ts';
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
  /** The source checkout of its repository; its own path for a source checkout. */
  source?: string;
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
  /** In a source checkout, whose dependencies no worktree warm restores. */
  source?: boolean;
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
  return {
    path: entry.path,
    source: source.path,
    linked: entry.path !== source.path,
    locked: Boolean(entry.locked),
    keys,
  };
}

/** The worktrees whose artifacts maintenance may clear, read without blocking when an operation is given. */
export function artifactWorktreesFor(
  operation: StimContext | undefined,
): ArtifactWorktree[] | Promise<ArtifactWorktree[]> {
  return operation ? artifactWorktreesAsync(operation.signal, operation) : artifactWorktrees();
}

export async function artifactCheckoutsAsync(
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ArtifactWorktree[]> {
  const found = new Map<string, ArtifactWorktree>();
  const discovered = await discoverCheckouts(loadConfig(), listedRoots(), operation);
  const known = new Set([...listedRoots(), ...discovered.map(({ path }) => path)]);
  for (const root of (await candidateRootsAsync(operation, discovered)).filter((entry) => known.has(entry))) {
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

export async function artifactWorktreesAsync(
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ArtifactWorktree[]> {
  const found = new Map((await artifactCheckoutsAsync(signal, operation)).map((entry) => [entry.path, entry]));
  const checkouts = [...found.values()];
  if (checkouts.length) {
    const agents = await agentSessionUse(
      checkouts.map((entry) => entry.path),
      Date.now(),
      signal,
    );
    checkouts.forEach((entry, i) => {
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

/** The workspaces whose native-run claim the caller holds, so their own claim is not a reason to keep. */
type Held = string | readonly string[] | undefined;

const isHeld = (locked: Held, key: string): boolean =>
  typeof locked === 'string' ? key === locked : (locked?.includes(key) ?? false);

function inUseNow(kind: ArtifactKind, locked: Held): InUseReader {
  return (key) =>
    kind === 'build'
      ? workspaceBuildReasons(key, { nativeRun: !isHeld(locked, key) })
      : workspaceInUse(key, { nativeRun: !isHeld(locked, key) });
}

async function inUseOf(
  candidate: ArtifactCandidate,
  kind: ArtifactKind,
  signal: AbortSignal,
  operation: StimContext | undefined,
  locked?: Held,
): Promise<InUseReader> {
  const reasons = new Map<string, string[]>();
  for (const key of candidate.keys) {
    const nativeRun = !isHeld(locked, key);
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
    locked?: Held;
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
  locked?: Held,
  running?: RunningProcesses | null,
  inUse: InUseReader = inUseNow(kind, locked),
): string | null {
  const { worktree, path, keys } = candidate;
  if (keys.some(pinned)) return 'pinned by maintenance.keep';
  if (candidate.locked) return LOCKED_REASON;
  const warming = candidate.source ? warmCopyingFrom(worktree) : null;
  if (warming) return warming;
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
    /** Dependencies of source checkouts, instead of those of linked worktrees. */
    source?: boolean;
  },
  signal: AbortSignal,
  operation?: StimContext,
): Promise<ReturnType<typeof collectArtifacts>> {
  const candidates: ArtifactCandidate[] = [];
  const skips: { target: string; reason: string }[] = [];
  let listed: RunningProcesses | null | undefined;
  const runningNow = async (): Promise<RunningProcesses | null> =>
    kind === 'dependencies'
      ? listed === undefined
        ? (listed = await readRunningProcessesAsync(signal))
        : listed
      : null;
  const all = await artifactWorktreesAsync(signal, operation);
  for (const worktree of all) {
    if (kind === 'dependencies' && worktree.linked === Boolean(options.source)) continue;
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
          ...(options.source ? { source: true } : {}),
        };
        const inUse = protectedHere ? null : await inUseOf(candidate, kind, signal, operation);
        const running = inUse ? await runningNow() : null;
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
        if (!reason && candidate.source)
          reason = (await regenerableDirProblem(worktree.path, path, signal)) ?? linkedWorktreeUsing(candidate, all);
        if (reason) skips.push({ target: path, reason });
        else candidates.push(candidate);
      }
  }
  return { candidates, skips };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const LINK_SCAN_ENTRIES = 2000;
const LINK_SCAN_DEPTH = 2;

/**
 * Why a listed linked worktree keeps a source checkout's dependency tree: a symlink in it resolves into the tree, or the
 * worktree could not be fully checked. The same relative path is checked first. The scan then reads the worktree's
 * directories down to `LINK_SCAN_DEPTH` levels (so `apps/<app>/node_modules` is seen) and checks every entry in them,
 * a `node_modules` entry itself included, without descending into `node_modules` or `.git`. Past `LINK_SCAN_ENTRIES`
 * entries or at a directory it cannot read, the check is incomplete and the tree is kept. A worktree git does not
 * list is not scanned.
 */
function linkedWorktreeUsing(candidate: ArtifactCandidate, worktrees: readonly ArtifactWorktree[]): string | null {
  const real = canonicalPath(candidate.path);
  const rel = relative(candidate.worktree, candidate.path);
  const into = (path: string): boolean => {
    try {
      const target = canonicalPath(path);
      return target === real || target.startsWith(`${real}${sep}`);
    } catch {
      return false;
    }
  };
  for (const other of worktrees) {
    if (!other.linked || (other.source !== undefined && other.source !== candidate.worktree)) continue;
    const direct = join(other.path, rel);
    if (isSymlink(direct) && into(direct)) return `the worktree ${other.path} links ${rel} to it`;
    let seen = 0;
    let incomplete = false;
    const scan = (dir: string, depth: number): string | null => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        incomplete = true;
        return null;
      }
      for (const entry of entries) {
        if (++seen > LINK_SCAN_ENTRIES) {
          incomplete = true;
          return null;
        }
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          if (into(path)) return path;
        } else if (
          depth < LINK_SCAN_DEPTH &&
          entry.isDirectory() &&
          entry.name !== '.git' &&
          entry.name !== 'node_modules'
        ) {
          const found = scan(path, depth + 1);
          if (found) return found;
          if (incomplete) return null;
        }
      }
      return null;
    };
    const found = scan(other.path, 0);
    if (found) return `the worktree ${other.path} links ${relative(other.path, found)} to it`;
    if (incomplete) return `the worktree ${other.path} could not be fully checked for links into it`;
  }
  return null;
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
    recheck?: (keys: readonly string[], worktree: string) => Promise<string | null>;
    operation?: StimContext;
  },
): Promise<{ status: 'done' | 'kept'; bytes: number; detail: string }> {
  const { operation } = options;
  const signal = operation?.signal ?? new AbortController().signal;
  const worktree = containing(options.worktrees, action.target);
  if (kind === 'dependencies' && worktree && !worktree.linked)
    return { status: 'kept', bytes: 0, detail: 'it is in the source checkout' };
  if (!worktree || !isKnownDir(kind, action.target))
    return { status: 'kept', bytes: 0, detail: 'it is no longer a regenerable directory of a known worktree' };
  const root = canonicalPath(worktree.path);
  if (options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`))
    return { status: 'kept', bytes: 0, detail: 'the command that started this pass runs inside its worktree' };
  const agents = (await agentSessionUse([worktree.path], Date.now(), signal))[0] ?? [];
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
    const late = key && options.recheck ? await options.recheck(candidate.keys, candidate.worktree) : null;
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

function containing(worktrees: readonly ArtifactWorktree[], target: string): ArtifactWorktree | null {
  return worktrees
    .filter((entry) => target.startsWith(`${entry.path}${sep}`))
    .reduce<ArtifactWorktree | null>(
      (best, entry) => (best && best.path.length >= entry.path.length ? best : entry),
      null,
    );
}

export type TreeOutcome = { status: 'done' | 'kept' | 'failed'; bytes: number; detail: string };

/**
 * Deletes the dependency trees `targets` of one source checkout as a unit. Each tree is checked on its own (it is a real
 * git-ignored directory on its own volume, no listed worktree links into it, and the usual in-use, pin and process
 * guards); the survivors are checked once more, together, under the claims, which are the native-run claim of every
 * workspace in the checkout and of its root, and the warm claim taken exclusively without waiting; then every
 * survivor is deleted inside the same hold and the record is written last, naming each tree a delete began on.
 */
export async function clearSourceTrees(
  targets: readonly string[],
  options: {
    protectedRoot: string;
    pinned: (workspace: string) => boolean | Promise<boolean>;
    worktrees: readonly ArtifactWorktree[];
    /** Why the checkout is no longer idle, asked once under the claims; null when it still is. */
    recheck: (keys: readonly string[], worktree: string) => Promise<string | null>;
    operation?: StimContext;
  },
): Promise<Map<string, TreeOutcome>> {
  const results = new Map<string, TreeOutcome>();
  const keepAll = (paths: readonly string[], detail: string) => {
    for (const path of paths) results.set(path, { status: 'kept', bytes: 0, detail });
  };
  const [first] = targets;
  if (first === undefined) return results;
  const { operation } = options;
  const signal = operation?.signal ?? new AbortController().signal;
  const worktree = containing(options.worktrees, first);
  if (!worktree || worktree.linked || targets.some((target) => !isKnownDir('dependencies', target))) {
    keepAll(targets, 'it is no longer a regenerable directory of a known source checkout');
    return results;
  }
  const root = canonicalPath(worktree.path);
  if (options.protectedRoot === root || options.protectedRoot.startsWith(`${root}${sep}`)) {
    keepAll(targets, 'the command that started this pass runs inside its worktree');
    return results;
  }
  const base: ArtifactCandidate = {
    worktree: worktree.path,
    path: first,
    keys: worktree.keys,
    locked: worktree.locked,
    agents: (await agentSessionUse([worktree.path], Date.now(), signal))[0] ?? [],
    source: true,
  };
  const checkTree = async (path: string, held?: readonly string[]): Promise<string | null> => {
    const candidate = { ...base, path, ...(held ? { source: false } : {}) };
    const pinned = await pinsOf(candidate.keys, options.pinned);
    return (
      keptReason(
        candidate,
        'dependencies',
        {
          windowMs: 0,
          pinned,
          now: Date.now(),
          running: await readRunningProcessesAsync(),
          inUse: await inUseOf(candidate, 'dependencies', signal, operation, held),
          ...(held ? { locked: held } : {}),
        },
        await artifactReads(candidate, 'dependencies', signal, operation),
      ) ??
      (await regenerableDirProblem(worktree.path, path, signal)) ??
      linkedWorktreeUsing(candidate, options.worktrees)
    );
  };
  let selected: string[] = [];
  let recordFailure: string | null = null;
  for (const path of targets) {
    const problem = await checkTree(path);
    if (problem) keepAll([path], problem);
    else selected.push(path);
  }
  if (!selected.length) return results;
  const before = lowestFree(measureDisk());
  const heldKeys = [...new Set([...workspaceKeys(worktree.keys), worktree.path])];
  const underClaims = async (): Promise<void> => {
    const lock = worktree.locked ? 'locked' : await worktreeLockAsync(worktree.path);
    if (lock) return keepAll(selected, lockReason(lock));
    const late = await options.recheck(worktree.keys, worktree.path);
    if (late) return keepAll(selected, late);
    const stillSelected: string[] = [];
    for (const path of selected) {
      const problem = await checkTree(path, heldKeys);
      if (problem) keepAll([path], problem);
      else stillSelected.push(path);
    }
    selected = stillSelected;
    const begun: string[] = [];
    recordFailure = null;
    for (const path of selected) {
      begun.push(path);
      try {
        rmSync(path, { recursive: true, force: true });
        results.set(path, { status: 'done', bytes: 0, detail: path });
      } catch (error) {
        results.set(path, {
          status: 'failed',
          bytes: 0,
          detail: `${path} may be partly deleted: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (begun.length)
      try {
        recordSourceDependencies(worktree.keys, begun);
      } catch (error) {
        recordFailure = error instanceof Error ? error.message : String(error);
      }
  };
  const hold = async (keys: readonly string[]): Promise<void> => {
    const [head, ...rest] = keys;
    if (head === undefined) {
      const warm = takeWarmClaim(worktree.path);
      if ('kept' in warm) return keepAll(selected, warm.kept);
      try {
        return await underClaims();
      } finally {
        warm.release();
      }
    }
    const run = await withIdleWorkspace(head, () => hold(rest), {
      purpose: 'maintenance',
      supervisor: true,
      operation,
    });
    if (!run.ran) keepAll(selected, `in use: ${run.reasons.join('; ')}`);
  };
  await hold(heldKeys);
  const freed = Math.max(0, lowestFree(measureDisk()) - before);
  const bytes = Number.isFinite(freed) ? Math.round(freed * 1024 * 1024) : 0;
  const firstDone = [...results].find(([, outcome]) => outcome.status === 'done');
  if (firstDone) results.set(firstDone[0], { ...firstDone[1], bytes });
  if (recordFailure)
    for (const [path, outcome] of results)
      if (outcome.status === 'done')
        results.set(path, {
          ...outcome,
          detail: `${outcome.detail}; the record of the deletion could not be written: ${recordFailure}`,
        });
  return results;
}
