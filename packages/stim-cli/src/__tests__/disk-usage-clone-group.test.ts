import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { freshMeasure, refreshMeasure } from '../disk-usage.ts';
import { getExecutor } from '../exec.ts';
import { measureTree } from '../private-size.ts';

vi.mock('../private-size.ts', async (original) => ({
  ...(await original<typeof import('../private-size.ts')>()),
  measureTree: vi.fn<typeof import('../private-size.ts').measureTree>(async () => ({ bytes: 100, privateBytes: 50 })),
}));

let base: string;
let roots: [string, string, string];
const start = Date.parse('2026-01-01T00:00:00Z');
const reinstall = (root: string) => writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'changed install\n');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-clone-group-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  const main = join(base, 'repo');
  mkdirSync(main);
  const git = (args: string[]) => getExecutor().runFile('git', args, { cwd: main, timeoutMs: 5000 });
  git(['init', '-q', '-b', 'main']);
  git([
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial',
    '--allow-empty',
  ]);
  roots = [main, join(base, 'one'), join(base, 'two')];
  for (const [index, root] of roots.entries()) {
    if (index) git(['worktree', 'add', '-q', '-b', `branch-${index}`, root]);
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'initial\n');
  }
  vi.mocked(measureTree).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it.each([
  { rule: 'unchanged group after six hours', hours: 7, change: 'none', walked: false },
  { rule: 'own reinstall within six hours', hours: 1, change: 'own', walked: true },
  { rule: 'sibling reinstall after six hours', hours: 7, change: 'sibling', walked: true },
  { rule: 'sibling reinstall within six hours', hours: 1, change: 'sibling', walked: false },
  { rule: 'sibling tree removed after six hours', hours: 7, change: 'removed', walked: true },
  { rule: 'source reinstall after six hours', hours: 7, change: 'source', walked: true },
  { rule: 'one-day backstop', hours: 25, change: 'none', walked: true },
])('$rule', async ({ hours, change, walked }) => {
  const tree = join(roots[1], 'node_modules');
  await refreshMeasure(tree, { timeoutMs: 1000, now: () => start });
  expect(measureTree).toHaveBeenCalledOnce();
  vi.mocked(measureTree).mockClear();
  if (change === 'own') reinstall(roots[1]);
  if (change === 'sibling') reinstall(roots[2]);
  if (change === 'source') reinstall(roots[0]);
  if (change === 'removed') rmSync(join(roots[2], 'node_modules'), { recursive: true });
  await refreshMeasure(tree, { timeoutMs: 1000, now: () => start + hours * 60 * 60_000 });
  expect(measureTree).toHaveBeenCalledTimes(walked ? 1 : 0);
});

it('includes the source checkout on a bare repository HEAD branch', async () => {
  const bare = join(base, 'bare.git');
  const source = join(base, 'source');
  const feature = join(base, 'feature');
  const git = (args: string[]) => getExecutor().runFile('git', args, { cwd: base, timeoutMs: 5000 });
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  git(['-C', bare, 'fetch', '-q', roots[0], 'main:main']);
  git(['-C', bare, 'worktree', 'add', '-q', source, 'main']);
  git(['-C', bare, 'worktree', 'add', '-q', '-b', 'feature', feature, 'main']);
  for (const root of [source, feature]) {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'initial\n');
  }
  const tree = join(feature, 'node_modules');
  await refreshMeasure(tree, { timeoutMs: 1000, now: () => start });
  vi.mocked(measureTree).mockClear();
  reinstall(source);
  await refreshMeasure(tree, { timeoutMs: 1000, now: () => start + 7 * 60 * 60_000 });
  expect(measureTree).toHaveBeenCalledOnce();
});

it('requires a supplied stamp for a sync freshness check but refresh resolves it without walking', async () => {
  const tree = join(roots[1], 'node_modules');
  await refreshMeasure(tree, { timeoutMs: 1000, now: () => start });
  vi.mocked(measureTree).mockClear();
  const now = () => start + 7 * 60 * 60_000;
  expect(freshMeasure(tree, { now })).toBeNull();
  await refreshMeasure(tree, { timeoutMs: 1000, now });
  expect(measureTree).not.toHaveBeenCalled();
});
