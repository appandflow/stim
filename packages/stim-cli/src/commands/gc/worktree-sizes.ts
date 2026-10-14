import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { plural } from '../../command-output.ts';
import { diskUsageCacheFile, readDiskUsage } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { writeCacheFile } from '../../status-measures.ts';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { ARTIFACT_DIRS, appRoots } from '../../maintenance/artifacts.ts';
import { listWorktreesAsync, resolveSourceCheckoutAsync } from '../../workspace/worktree.ts';
import { matchWorktreeEntry } from '../worktree.ts';
import { canonicalPath } from './paths.ts';
import { phase } from './progress.ts';
import { candidateRootsAsync, type UnlistedWorktreeDir, type WorktreeSweep } from './worktrees.ts';

const SIZE_TIMEOUT_MS = 30_000;
const BUILD_STATE_MAX_AGE_MS = 60 * 60_000;
const BUILD_STATE_TIMEOUT_MS = 10_000;
const BUILD_STATE_CONCURRENCY = 4;
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

async function buildStateDirs(path: string, keys: readonly string[]): Promise<string[]> {
  const entries = await listWorktreesAsync(path);
  const own = keys.filter((key) => matchWorktreeEntry(entries, key)?.path === path);
  const root = canonicalPath(path);
  const worktree = { path, linked: true, keys: own };
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

async function duSize(dir: string): Promise<number | null> {
  let out: string;
  try {
    out = await getExecutor().runFileAsync('du', ['-sk', dir], {
      timeoutMs: BUILD_STATE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    const stdout = error instanceof Error && 'stdout' in error ? error.stdout : null;
    out = typeof stdout === 'string' ? stdout : '';
  }
  const kb = /^(\d+)\t/.exec(out)?.[1];
  return kb ? Number(kb) * 1024 : null;
}

async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = items[Symbol.iterator]();
  const worker = async (): Promise<void> => {
    for (const item of queue) await run(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
 * directory since. Stale directories are measured with one `du` each, at most 4 at once and 10 seconds each, so a
 * slow tree delays only itself; a directory du could not measure in time is reported unmeasured (null). Also lists
 * the directories directly under a repository's `.worktrees/` that are no git worktree at all.
 */
export async function measureWorktreeSweep(sweep: WorktreeSweep): Promise<WorktreeSweep> {
  const now = Date.now();
  const pending: PendingWorktree[] = [];
  for (const candidate of sweep.worktrees) {
    if (candidate.skipCode === 'not-a-worktree') continue;
    const dirs = await buildStateDirs(candidate.path, candidate.keys);
    pending.push({
      candidate,
      root: canonicalPath(candidate.path),
      dirs,
      sizes: new Map(dirs.map((dir) => [dir, cachedSize(dir, now)])),
    });
  }
  const due = pending.flatMap(({ sizes }) =>
    [...sizes].flatMap(([dir, bytes]) => (bytes === null ? [{ dir, sizes }] : [])),
  );
  const worktrees = new Set(due.map(({ sizes }) => sizes)).size;
  if (due.length) phase('worktrees', `measuring the build state of ${plural(worktrees, 'worktree')}`);
  await eachLimited(due, BUILD_STATE_CONCURRENCY, async ({ dir, sizes }) => {
    const measuredAt = new Date().toISOString();
    const bytes = await duSize(dir);
    if (bytes === null) return;
    sizes.set(dir, bytes);
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
  sweep.unlisted = await unlistedWorktreeDirs();
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

async function unlistedWorktreeDirs(): Promise<UnlistedWorktreeDir[]> {
  const repositories = new Map<string, string[]>();
  for (const root of await candidateRootsAsync()) {
    const { entries, ...source } = await resolveSourceCheckoutAsync(root);
    if ('refusal' in source || repositories.has(source.path)) continue;
    repositories.set(
      source.path,
      entries.map((entry) => canonicalPath(entry.path)),
    );
  }
  const found: UnlistedWorktreeDir[] = [];
  for (const [repository, listed] of repositories) {
    const parent = join(repository, WORKTREES_DIR);
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names.toSorted()) {
      const path = join(parent, name);
      if (!isDirectory(path) || hasLiveGitDir(path)) continue;
      const real = canonicalPath(path);
      if (listed.some((entry) => entry === real || entry.startsWith(`${real}${sep}`))) continue;
      found.push({ path, repository, bytes: await measuredDirectorySizeAsync(path, { timeoutMs: SIZE_TIMEOUT_MS }) });
    }
  }
  return found;
}
