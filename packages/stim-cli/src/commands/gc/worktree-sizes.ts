import type { StimContext } from '@stim-cli/core';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { plural } from '../../command-output.ts';
import { diskUsageCacheFile, readDiskUsage } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { writeCacheFile } from '../../status-measures.ts';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { knownPrivateBytes, measureTree, treeSignature } from '../../private-size.ts';
import { appRoots } from '../../maintenance/artifacts.ts';
import { ARTIFACT_DIRS, discoveredBuildDirs, xcodebuildOutputDirs } from '../../workspace/regenerable-dirs.ts';
import { listWorktreesAsync, matchWorktreeEntry, resolveSourceCheckoutAsync } from '../../workspace/worktree.ts';
import { canonicalPath } from './paths.ts';
import { phase } from './progress.ts';
import {
  candidateRootsAsync,
  type UnlistedWorktreeDir,
  type WorktreeBuildState,
  type WorktreeSweep,
} from './worktrees.ts';
import { runOperationFile } from '../../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { eachLimited, mapLimited, readConcurrency, sizeConcurrency } from './limited.ts';

const SIZE_TIMEOUT_MS = 30_000;
const BUILD_STATE_MAX_AGE_MS = 60 * 60_000;
const BUILD_STATE_TIMEOUT_MS = 10_000;
const PNPM_STORE = '.pnpm-store';
const WORKTREES_DIR = '.worktrees';

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

interface BuildStateDirs {
  dirs: string[];
  /** The directories measured with their private bytes: dependency trees, DerivedData and CMake output. */
  privateSized: Set<string>;
  /** The xcodebuild output under another name than `.dd`, which gc lists and never deletes. */
  reportOnly: Set<string>;
}

async function buildStateDirs(path: string, keys: readonly string[], operation?: StimContext): Promise<BuildStateDirs> {
  const entries = await listWorktreesAsync(path, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
  });
  const own = keys.filter((key) => matchWorktreeEntry(entries, key)?.path === path);
  const root = canonicalPath(path);
  const worktree = { path, linked: true, locked: Boolean(matchWorktreeEntry(entries, path)?.locked), keys: own };
  const dirs = new Map<string, string>();
  const privateSized = new Set<string>();
  const reportOnly = new Set<string>();
  const add = (dir: string, how: 'fixed' | 'discovered' | 'report-only' = 'fixed') => {
    if (!isDirectory(dir)) return;
    const real = canonicalPath(dir);
    if (!inside(root, real) || dirs.has(real)) return;
    dirs.set(real, dir);
    if (how !== 'fixed') privateSized.add(real);
    if (how === 'report-only') reportOnly.add(real);
  };
  for (const kind of ['build', 'dependencies'] as const)
    for (const base of appRoots(worktree, kind)) {
      for (const dir of ARTIFACT_DIRS[kind]) add(join(base, dir));
      if (kind !== 'build') continue;
      for (const dir of discoveredBuildDirs(base)) add(dir, 'discovered');
      for (const dir of xcodebuildOutputDirs(base)) add(dir, 'report-only');
    }
  add(join(path, PNPM_STORE));
  return { dirs: [...dirs.keys()], privateSized, reportOnly };
}

interface DirSize {
  bytes: number;
  privateBytes: number | null;
}

function isDependencyTree(dir: string): boolean {
  return ARTIFACT_DIRS.dependencies.some((name) => dir.endsWith(`${sep}${name.split('/').join(sep)}`));
}

function cachedSize(dir: string, now: number, privateSized: ReadonlySet<string>): DirSize | null {
  const cached = readDiskUsage(dir);
  if (!cached) return null;
  const at = Date.parse(cached.measuredAt);
  if (now - at >= BUILD_STATE_MAX_AGE_MS) return null;
  if (isDependencyTree(dir))
    return cached.signature === treeSignature(dir)
      ? { bytes: cached.bytes, privateBytes: knownPrivateBytes(dir) }
      : null;
  try {
    return statSync(dir).mtimeMs > at
      ? null
      : { bytes: cached.bytes, privateBytes: privateSized.has(dir) ? (cached.privateBytes ?? null) : null };
  } catch {
    return null;
  }
}

async function duSize(dir: string, operation?: StimContext): Promise<number | null> {
  let out: string;
  try {
    out = await runOperationFile(operation, getExecutor(), 'du', ['-sk', dir], {
      timeoutMs: BUILD_STATE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      cwd: operation?.cwd,
      signal: operation?.signal,
    });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    const stdout = error instanceof Error && 'stdout' in error ? error.stdout : null;
    out = typeof stdout === 'string' ? stdout : '';
  }
  const kb = /^(\d+)\t/.exec(out)?.[1];
  return kb ? Number(kb) * 1024 : null;
}

interface PendingWorktree extends BuildStateDirs {
  candidate: WorktreeSweep['worktrees'][number];
  root: string;
  sizes: Map<string, DirSize | null>;
}

/**
 * Sizes the regenerable directories maintenance clears and a project-local `.pnpm-store` in each worktree of the
 * sweep, from the disk-usage cache while an entry is under an hour old and no entry was added to or removed from the
 * directory since (for node_modules and Pods, while their install signature is unchanged). Stale directories are
 * measured with one `du` each, node_modules and Pods with the private-size walk of `measureTree`, at most 4 at once, one at a time while the
 * operation declares its children on a claim, with 10 seconds each, so a
 * slow tree delays only itself; a directory du could not measure in time is reported unmeasured (null). Without
 * `measure`, stale directories are reported unmeasured without a `du`. Also lists
 * the directories directly under a repository's `.worktrees/` that are no git worktree at all.
 */
export async function measureWorktreeSweep(
  sweep: WorktreeSweep,
  operation?: StimContext,
  measure = true,
): Promise<WorktreeSweep> {
  operation?.signal.throwIfAborted();
  const now = Date.now();
  const measured = sweep.worktrees.filter((candidate) => candidate.skipCode !== 'not-a-worktree');
  const pending: PendingWorktree[] = [];
  await eachLimited([...measured.entries()], readConcurrency(operation), async ([index, candidate]) => {
    operation?.signal.throwIfAborted();
    const found = await buildStateDirs(candidate.path, candidate.keys, operation);
    pending[index] = {
      ...found,
      candidate,
      root: canonicalPath(candidate.path),
      sizes: new Map(found.dirs.map((dir) => [dir, cachedSize(dir, now, found.privateSized)])),
    };
  });
  const due = measure
    ? pending.flatMap(({ sizes, privateSized }) =>
        [...sizes].flatMap(([dir, bytes]) => (bytes === null ? [{ dir, sizes, privateSized }] : [])),
      )
    : [];
  const worktrees = new Set(due.map(({ sizes }) => sizes)).size;
  if (due.length) phase('worktrees', `measuring the build state of ${plural(worktrees, 'worktree')}`, operation);
  await eachLimited(due, sizeConcurrency(operation), async ({ dir, sizes, privateSized }) => {
    operation?.signal.throwIfAborted();
    const measuredAt = new Date().toISOString();
    if (isDependencyTree(dir) || privateSized.has(dir)) {
      const signature = isDependencyTree(dir) ? treeSignature(dir) : null;
      const size = await measureTree(dir, { timeoutMs: BUILD_STATE_TIMEOUT_MS, operation });
      if (!size) return;
      sizes.set(dir, size);
      operation?.signal.throwIfAborted();
      writeCacheFile(diskUsageCacheFile(dir), {
        path: dir,
        measuredAt,
        bytes: size.bytes,
        ...(size.privateBytes !== null ? { privateBytes: size.privateBytes } : {}),
        ...(signature ? { signature } : {}),
      });
      return;
    }
    const bytes = await duSize(dir, operation);
    if (bytes === null) return;
    sizes.set(dir, { bytes, privateBytes: null });
    operation?.signal.throwIfAborted();
    writeCacheFile(diskUsageCacheFile(dir), { path: dir, measuredAt, bytes });
  });
  for (const { candidate, root, dirs, sizes, reportOnly } of pending) {
    const entries = dirs.map((dir) => {
      const entry: WorktreeBuildState['dirs'][number] = {
        path: relative(root, dir).split(sep).join('/'),
        bytes: sizes.get(dir)?.bytes ?? null,
        privateBytes: sizes.get(dir)?.privateBytes ?? null,
      };
      if (reportOnly.has(dir)) entry.reportOnly = true;
      return entry;
    });
    candidate.buildState = {
      bytes: entries.every((dir) => dir.bytes !== null)
        ? entries.reduce((sum, dir) => sum + (dir.bytes ?? 0), 0)
        : null,
      dirs: entries.toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)),
    };
  }
  sweep.unlisted = await unlistedWorktreeDirs(operation);
  return sweep;
}

/** Whether `path` is a checkout git still knows: its own `.git` directory, or a `.git` file whose gitdir exists. */
function hasLiveGitDir(path: string): boolean {
  const dotGit = join(path, '.git');
  let text: string;
  try {
    if (lstatSync(dotGit).isDirectory()) return true;
    text = readFileSync(dotGit, 'utf-8');
  } catch {
    return false;
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return Boolean(gitdir) && existsSync(resolve(dirname(dotGit), gitdir ?? ''));
}

async function unlistedWorktreeDirs(operation?: StimContext): Promise<UnlistedWorktreeDir[]> {
  const repositories = new Map<string, string[]>();
  const options = { env: operation?.env, signal: operation?.signal, declareFor: operation };
  const roots = await candidateRootsAsync(operation);
  const resolved: Awaited<ReturnType<typeof resolveSourceCheckoutAsync>>[] = [];
  await eachLimited([...roots.entries()], readConcurrency(operation), async ([index, root]) => {
    operation?.signal.throwIfAborted();
    resolved[index] = await resolveSourceCheckoutAsync(root, options);
  });
  for (const { entries, ...source } of resolved) {
    if ('refusal' in source || repositories.has(source.path)) continue;
    repositories.set(
      source.path,
      entries.map((entry) => canonicalPath(entry.path)),
    );
  }
  const unlisted: { path: string; repository: string }[] = [];
  for (const [repository, listed] of repositories) {
    operation?.signal.throwIfAborted();
    const parent = join(repository, WORKTREES_DIR);
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names.toSorted()) {
      operation?.signal.throwIfAborted();
      const path = join(parent, name);
      if (!isDirectory(path) || hasLiveGitDir(path)) continue;
      const real = canonicalPath(path);
      if (listed.some((entry) => entry === real || entry.startsWith(`${real}${sep}`))) continue;
      unlisted.push({ path, repository });
    }
  }
  const found = await mapLimited(unlisted, sizeConcurrency(operation), async ({ path, repository }) => ({
    path,
    repository,
    bytes: await measuredDirectorySizeAsync(path, {
      timeoutMs: SIZE_TIMEOUT_MS,
      operation,
      signal: operation?.signal,
    }),
  }));
  return found;
}
