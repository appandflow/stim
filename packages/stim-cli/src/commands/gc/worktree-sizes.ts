import type { StimContext } from '@stim-cli/core';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { plural } from '../../command-output.ts';
import { diskUsageCacheFile, readDiskUsage } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { writeCacheFile } from '../../status-measures.ts';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { appRoots } from '../../maintenance/artifacts.ts';
import { ARTIFACT_DIRS } from '../../workspace/regenerable-dirs.ts';
import { listWorktreesAsync, matchWorktreeEntry, resolveSourceCheckoutAsync } from '../../workspace/worktree.ts';
import { canonicalPath } from './paths.ts';
import { phase } from './progress.ts';
import { candidateRootsAsync, type UnlistedWorktreeDir, type WorktreeSweep } from './worktrees.ts';
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

async function buildStateDirs(path: string, keys: readonly string[], operation?: StimContext): Promise<string[]> {
  const entries = await listWorktreesAsync(path, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
  });
  const own = keys.filter((key) => matchWorktreeEntry(entries, key)?.path === path);
  const root = canonicalPath(path);
  const worktree = { path, linked: true, locked: Boolean(matchWorktreeEntry(entries, path)?.locked), keys: own };
  const dirs = new Map<string, string>();
  const add = (dir: string) => {
    if (!isDirectory(dir)) return;
    const real = canonicalPath(dir);
    if (inside(root, real) && !dirs.has(real)) dirs.set(real, dir);
  };
  for (const kind of ['build', 'dependencies'] as const)
    for (const base of appRoots(worktree, kind)) for (const dir of ARTIFACT_DIRS[kind]) add(join(base, dir));
  add(join(path, PNPM_STORE));
  return [...dirs.keys()];
}

function cachedSize(dir: string, now: number): number | null {
  const cached = readDiskUsage(dir);
  if (!cached) return null;
  const at = Date.parse(cached.measuredAt);
  if (now - at >= BUILD_STATE_MAX_AGE_MS) return null;
  try {
    return statSync(dir).mtimeMs > at ? null : cached.bytes;
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

interface PendingWorktree {
  candidate: WorktreeSweep['worktrees'][number];
  root: string;
  dirs: string[];
  sizes: Map<string, number | null>;
}

/**
 * Sizes the regenerable directories maintenance clears and a project-local `.pnpm-store` in each worktree of the
 * sweep, from the disk-usage cache while an entry is under an hour old and no entry was added to or removed from the
 * directory since. Stale directories are measured with one `du` each, at most 4 at once, one at a time while the
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
    const dirs = await buildStateDirs(candidate.path, candidate.keys, operation);
    pending[index] = {
      candidate,
      root: canonicalPath(candidate.path),
      dirs,
      sizes: new Map(dirs.map((dir) => [dir, cachedSize(dir, now)])),
    };
  });
  const due = measure
    ? pending.flatMap(({ sizes }) => [...sizes].flatMap(([dir, bytes]) => (bytes === null ? [{ dir, sizes }] : [])))
    : [];
  const worktrees = new Set(due.map(({ sizes }) => sizes)).size;
  if (due.length) phase('worktrees', `measuring the build state of ${plural(worktrees, 'worktree')}`, operation);
  await eachLimited(due, sizeConcurrency(operation), async ({ dir, sizes }) => {
    operation?.signal.throwIfAborted();
    const measuredAt = new Date().toISOString();
    const bytes = await duSize(dir, operation);
    if (bytes === null) return;
    sizes.set(dir, bytes);
    operation?.signal.throwIfAborted();
    writeCacheFile(diskUsageCacheFile(dir), { path: dir, measuredAt, bytes });
  });
  for (const { candidate, root, dirs, sizes } of pending) {
    const entries = dirs.map((dir) => ({
      path: relative(root, dir).split(sep).join('/'),
      bytes: sizes.get(dir) ?? null,
    }));
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
