import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { plural } from '../../command-output.ts';
import { getExecutor } from '../../exec.ts';
import { measuredDirectorySize } from '../../fs-util.ts';
import { ARTIFACT_DIRS, appRoots } from '../../maintenance/artifacts.ts';
import { listWorktrees, sourceCheckoutOf } from '../../workspace/worktree.ts';
import { matchWorktreeEntry } from '../worktree.ts';
import { canonicalPath } from './paths.ts';
import { phase } from './progress.ts';
import { candidateRoots, type UnlistedWorktreeDir, type WorktreeSweep } from './worktrees.ts';

const SIZE_TIMEOUT_MS = 30_000;
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

function buildStateDirs(path: string, keys: readonly string[]): string[] {
  const entries = listWorktrees(path);
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

function duSizes(dirs: readonly string[]): Map<string, number | null> {
  const sizes = new Map<string, number | null>();
  let out: string | null;
  try {
    out = getExecutor().runFile('du', ['-sk', ...dirs], { timeoutMs: SIZE_TIMEOUT_MS });
  } catch {
    out = null;
  }
  for (const line of (out ?? '').split('\n')) {
    const [, kb, dir] = /^(\d+)\t(.+)$/.exec(line) ?? [];
    if (kb && dir) sizes.set(dir, Number(kb) * 1024);
  }
  for (const dir of dirs)
    if (!sizes.has(dir)) sizes.set(dir, measuredDirectorySize(dir, { timeoutMs: SIZE_TIMEOUT_MS }));
  return sizes;
}

/**
 * Measures, with one `du` per worktree, the regenerable directories maintenance clears and a project-local
 * `.pnpm-store` in each worktree of the sweep, and lists the directories directly under a repository's `.worktrees/`
 * that are no git worktree at all.
 */
export function measureWorktreeSweep(sweep: WorktreeSweep): WorktreeSweep {
  const measured = sweep.worktrees.filter((candidate) => candidate.skipCode !== 'not-a-worktree');
  if (measured.length) phase('worktrees', `measuring the build state of ${plural(measured.length, 'worktree')}`);
  for (const candidate of measured) {
    const root = canonicalPath(candidate.path);
    const dirs = buildStateDirs(candidate.path, candidate.keys);
    const sizes = dirs.length ? duSizes(dirs) : new Map<string, number | null>();
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
  sweep.unlisted = unlistedWorktreeDirs();
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

function unlistedWorktreeDirs(): UnlistedWorktreeDir[] {
  const repositories = new Map<string, string[]>();
  for (const root of candidateRoots()) {
    const entries = listWorktrees(root);
    const source = sourceCheckoutOf(entries);
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
      found.push({ path, repository, bytes: measuredDirectorySize(path, { timeoutMs: SIZE_TIMEOUT_MS }) });
    }
  }
  return found;
}
