import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { getExecutor } from './exec.ts';
import { repoRoot } from './workspace/worktree.ts';

export function installedNpmTreeProblems(projectRoot: string): string {
  try {
    getExecutor().runFile('npm', ['ls', '--all', '--json', '--silent'], { cwd: projectRoot, timeoutMs: 30_000 });
    return '';
  } catch (error) {
    const stdout = error instanceof Error && 'stdout' in error ? error.stdout : '';
    let problems: unknown;
    try {
      problems = JSON.parse(String(stdout ?? ''))?.problems;
    } catch {}
    if (!Array.isArray(problems)) return randomUUID();
    return createHash('sha256').update(problems.map(String).toSorted().join('\n')).digest('hex');
  }
}

export async function installedNpmTreeIsValidAsync(projectRoot: string): Promise<boolean> {
  try {
    await getExecutor().runFileAsync('npm', ['ls', '--all', '--json', '--silent'], {
      cwd: projectRoot,
      timeoutMs: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

const DEPENDENCY_STATES = [
  { lock: 'pnpm-lock.yaml', installed: ['node_modules'], command: 'pnpm install' },
  { lock: 'yarn.lock', installed: ['node_modules', '.pnp.cjs', '.pnp.js'], command: 'yarn install' },
  { lock: 'bun.lock', installed: ['node_modules'], command: 'bun install' },
  { lock: 'bun.lockb', installed: ['node_modules'], command: 'bun install' },
  { lock: 'package-lock.json', installed: ['node_modules'], command: 'npm ci' },
];

export interface DependencyState {
  lock: string;
  installed: string[];
  command: string;
  root: string;
}

export function dependencyState(
  projectRoot: string,
  root: string = repoRoot(projectRoot) ?? projectRoot,
): DependencyState | null {
  let dir = projectRoot;
  while (true) {
    const state = DEPENDENCY_STATES.find((candidate) => existsSync(join(dir, candidate.lock)));
    if (state) return { ...state, root: dir };
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith('..')) return null;
    dir = parent;
  }
}

export function hasInstalledDependencies(
  projectRoot: string,
  markers: string[] = ['node_modules', '.pnp.cjs', '.pnp.js'],
): boolean {
  return markers.some((entry) => existsSync(join(projectRoot, entry)));
}
