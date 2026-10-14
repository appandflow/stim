import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getExecutor } from '../../exec.ts';
import { measuredDirectorySize } from '../../fs-util.ts';
import { ARTIFACT_DIRS, appRoots } from '../../maintenance/artifacts.ts';
import { listWorktrees, sourceCheckoutOf } from '../../workspace/worktree.ts';
import { canonicalPath } from './paths.ts';
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

function buildStateDirs(path: string, keys: readonly string[]): string[] {
  const worktree = { path, linked: true, keys: [...keys] };
  const dirs = new Set<string>();
  for (const kind of ['build', 'dependencies'] as const)
    for (const base of appRoots(worktree, kind))
      for (const dir of ARTIFACT_DIRS[kind]) if (isDirectory(join(base, dir))) dirs.add(join(base, dir));
  if (isDirectory(join(path, PNPM_STORE))) dirs.add(join(path, PNPM_STORE));
  return [...dirs];
}

function duSizes(dirs: readonly string[]): Map<string, number> | null {
  let out: string;
  try {
    out = getExecutor().runFile('du', ['-sk', ...dirs], { timeoutMs: SIZE_TIMEOUT_MS });
  } catch {
    return null;
  }
  const sizes = new Map<string, number>();
  for (const line of out.split('\n')) {
    const [, kb, dir] = /^(\d+)\t(.+)$/.exec(line) ?? [];
    if (kb && dir) sizes.set(dir, Number(kb) * 1024);
  }
  return sizes;
}

/**
 * Measures, with one `du` per worktree, the regenerable directories maintenance clears and a project-local
 * `.pnpm-store` in each worktree of the sweep, and lists the directories directly under a repository's `.worktrees/`
 * that git does not list as worktrees.
 */
export function measureWorktreeSweep(sweep: WorktreeSweep): WorktreeSweep {
  for (const candidate of sweep.worktrees) {
    if (candidate.skipCode === 'not-a-worktree') continue;
    const dirs = buildStateDirs(candidate.path, candidate.keys);
    const sizes = dirs.length ? duSizes(dirs) : new Map<string, number>();
    const measured = dirs.map((dir) => ({
      path: relative(candidate.path, dir).split(sep).join('/'),
      bytes: sizes?.get(dir) ?? null,
    }));
    candidate.buildState = {
      bytes: measured.every((dir) => dir.bytes !== null)
        ? measured.reduce((sum, dir) => sum + (dir.bytes ?? 0), 0)
        : null,
      dirs: measured.toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)),
    };
  }
  sweep.unlisted = unlistedWorktreeDirs();
  return sweep;
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
      if (!isDirectory(path)) continue;
      const real = canonicalPath(path);
      if (listed.some((entry) => entry === real || entry.startsWith(`${real}${sep}`))) continue;
      found.push({ path, repository, bytes: measuredDirectorySize(path, { timeoutMs: SIZE_TIMEOUT_MS }) });
    }
  }
  return found;
}
