import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { diskUsageCacheFile } from '@stim-cli/core/state';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listOp, measureWorktreeSizes, worktreeListPayload } from '../commands/worktree-list.ts';
import { startWorktreeSizes } from '../commands/worktree-list-job.ts';
import { getExecutor } from '../exec.ts';
import { measureTree } from '../private-size.ts';

vi.mock('../commands/worktree-list-job.ts', () => ({ startWorktreeSizes: vi.fn<() => boolean>(() => true) }));

vi.mock('../private-size.ts', async (original) => ({
  ...(await original<typeof import('../private-size.ts')>()),
  measureTree: vi.fn<typeof import('../private-size.ts').measureTree>(async () => ({ bytes: 100, privateBytes: 50 })),
}));

let base: string;
let roots: [string, string, string];
const start = Date.parse('2026-01-01T00:00:00Z');
const reinstall = (root: string) => writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'changed install\n');

beforeEach(() => {
  vi.setSystemTime(start);
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
  vi.mocked(measureTree).mockReset();
  vi.mocked(measureTree).mockResolvedValue({ bytes: 100, privateBytes: 50 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const listing = async () => {
  await measureWorktreeSizes([roots[0]]);
  return worktreeListPayload([roots[0]]);
};

it.each([
  { rule: 'fresh parts stay cached', hours: 0.5, change: false, dependency: false, rest: false },
  { rule: 'own reinstall invalidates immediately', hours: 0.5, change: 'own', dependency: true, rest: false },
  { rule: 'sibling reinstall invalidates after six hours', hours: 7, change: 'sibling', dependency: true, rest: true },
  { rule: 'unchanged clone group stays cached', hours: 7, change: false, dependency: false, rest: true },
  { rule: 'one day backstop', hours: 25, change: false, dependency: true, rest: true },
])('$rule', async ({ hours, change, dependency, rest }) => {
  await listing();
  vi.mocked(measureTree).mockClear();
  vi.setSystemTime(start + hours * 60 * 60_000);
  if (change) reinstall(change === 'own' ? roots[1] : roots[2]);
  await listing();
  const calls = vi.mocked(measureTree).mock.calls;
  expect(calls.some(([path]) => path === join(roots[1], 'node_modules'))).toBe(dependency);
  expect(
    calls.some(([path, options]) => path === `${roots[1]}${sep}.` && options.targets?.includes(join(roots[1], '.git'))),
  ).toBe(rest);
});

it.each([
  { layout: 'a project-local store', make: () => mkdirSync(join(roots[1], '.pnpm-store')) },
  {
    layout: 'ios linked to a sibling native project',
    make: () => {
      mkdirSync(join(roots[1], 'native-project', 'Pods'), { recursive: true });
      symlinkSync('native-project', join(roots[1], 'ios'));
    },
  },
  { layout: 'a file named ios', make: () => writeFileSync(join(roots[1], 'ios'), '') },
])('walks a worktree with $layout whole', async ({ make }) => {
  make();
  await listing();
  const calls = vi.mocked(measureTree).mock.calls.filter(([path]) => path.startsWith(roots[1]));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe(roots[1]);
  expect(calls[0]?.[1].targets).toBeUndefined();
});

it.each([false, true])('sums private bytes, with unknown part: %s', async (unknown) => {
  mkdirSync(join(roots[1], 'ios', 'Pods'), { recursive: true });
  vi.mocked(measureTree).mockImplementation(async (path) => ({
    bytes: 100,
    privateBytes: unknown && path === join(roots[1], 'ios', 'Pods') ? null : 50,
  }));
  const payload = await listing();
  const entry = payload.repositories[0]?.worktrees.find((candidate) => candidate.path === roots[1]);
  expect(entry?.realBytes).toBe(unknown ? null : 150);
  expect(entry?.apparentBytes).toBe(300);
});

it('shows a refreshed rest over an older whole-worktree entry while the dependency sizes are older still', async () => {
  await listing();
  vi.setSystemTime(start + 3 * 60 * 60_000);
  writeFileSync(
    diskUsageCacheFile(roots[1]),
    JSON.stringify({ path: roots[1], bytes: 7, privateBytes: 7, measuredAt: new Date().toISOString() }),
  );
  vi.setSystemTime(start + 5 * 60 * 60_000);
  vi.mocked(measureTree).mockResolvedValue({ bytes: 1000, privateBytes: 500 });
  const payload = await listing();
  const entry = payload.repositories[0]?.worktrees.find((candidate) => candidate.path === roots[1]);
  expect(entry).toMatchObject({ realBytes: 500 + 50, measuredAt: new Date(start).toISOString() });
});

it('does not start measuring a dependency tree past six hours while its clone group is unchanged', async () => {
  await listing();
  vi.setSystemTime(start + 7 * 60 * 60_000);
  await listing();
  vi.mocked(startWorktreeSizes).mockClear();
  vi.spyOn(process, 'cwd').mockReturnValue(roots[0]);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => void output.push(String(value)));
  await listOp.run?.({ options: { json: true }, args: [], parent: {}, version: 'test' });
  vi.restoreAllMocks();
  process.exitCode = 0;
  expect(vi.mocked(startWorktreeSizes)).not.toHaveBeenCalled();
  expect(JSON.parse(output[0] ?? '').repositories[0].worktrees[0].measuring).toBeUndefined();
});
