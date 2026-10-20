import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { upsertProject } from '../workspace/config.ts';
import { collectWorktreeSweep, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { measureWorktreeSweep } from '../commands/gc/worktree-sizes.ts';

let home: string;
let root: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-worktree-discovery-')));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
  root = join(home, 'repo');
  mkdirSync(root);
  const executor = getExecutor();
  executor.runFile('git', ['init', '-q', '-b', 'main', root], { timeoutMs: 5000 });
  executor.runFile(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    { timeoutMs: 5000 },
  );
  upsertProject(root, { metroPort: null });
});

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  child = undefined;
  vi.useRealTimers();
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function sweep(): WorktreeSweep {
  return { idle: null, graceMs: 0, now: Date.now(), noOwnCommitsIdleMs: null, worktrees: [] };
}

test.each(['candidate discovery', 'candidate classification', 'build state', 'unlisted directories'] as const)(
  'a delayed Git inventory leaves the event loop responsive during %s',
  async (phase) => {
    mkdirSync(join(root, '.build'));
    writeFileSync(join(root, '.build', 'artifact'), 'build');
    mkdirSync(join(root, '.worktrees', 'lost'), { recursive: true });
    writeFileSync(join(root, '.worktrees', 'lost', 'artifact'), 'unlisted');
    const executor = getExecutor();
    const nth = phase === 'candidate classification' ? 3 : phase === 'unlisted directories' ? 2 : 1;
    let calls = 0;
    let responsive: boolean | undefined;
    const delayed = (file: string, args: string[]) => file === 'git' && args.includes('worktree') && ++calls === nth;
    const proxy = [
      '-e',
      'setTimeout(() => { const { execFileSync } = require("node:child_process"); process.stdout.write(execFileSync("git", process.argv.slice(1), { encoding: "utf8", timeout: 5000 })); }, 150)',
      '--',
    ];
    setExecutor({
      ...executor,
      runFileQuiet(file, args, options) {
        if (!delayed(file, args)) return executor.runFileQuiet(file, args, options);
        let ticked = false;
        const timer = setTimeout(() => (ticked = true), 25);
        try {
          const output = executor.runFileQuiet(process.execPath, [...proxy, ...args], options);
          responsive = ticked;
          return output;
        } finally {
          clearTimeout(timer);
        }
      },
      async runFileAsync(file, args, options) {
        if (!delayed(file, args)) return executor.runFileAsync(file, args, options);
        let ticked = false;
        const timer = setTimeout(() => (ticked = true), 25);
        try {
          const output = await executor.runFileAsync(process.execPath, [...proxy, ...args], options);
          responsive = ticked;
          return output;
        } finally {
          clearTimeout(timer);
        }
      },
    });
    let actual: unknown;
    let expected: unknown;
    const number = expect.any(Number);
    if (phase === 'candidate discovery' || phase === 'candidate classification') {
      const report = await collectWorktreeSweep({ idle: true, olderThan: null, now: Date.now(), graceMs: 0 });
      actual = report.worktrees.map(({ path, keys, skipCode }) => ({ path, keys, skipCode }));
      expected = [{ path: root, keys: [root], skipCode: 'source-checkout' }];
    } else {
      const report = sweep();
      if (phase === 'build state')
        report.worktrees = [
          {
            path: root,
            keys: [root],
            idleDays: null,
            merge: null,
            head: null,
            pullRequest: null,
            skipCode: 'source-checkout',
            skipped: 'source checkout',
            eligibleAt: null,
            activity: null,
          },
        ];
      const measured = await measureWorktreeSweep(report);
      actual = { buildState: measured.worktrees[0]?.buildState?.dirs ?? null, unlisted: measured.unlisted };
      expected = {
        buildState: phase === 'build state' ? [{ path: '.build', bytes: number }] : null,
        unlisted: [{ path: join(root, '.worktrees', 'lost'), repository: root, bytes: number }],
      };
    }
    expect(actual).toEqual(expected);
    expect(responsive).toBe(true);
  },
);

test('a stalled Git inventory child is terminated and leaves no unlisted deletion candidates', async () => {
  mkdirSync(join(root, '.worktrees', 'lost'), { recursive: true });
  const executor = getExecutor();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let calls = 0;
  vi.useFakeTimers();
  setExecutor({
    ...executor,
    runFileAsync: (file, args, options) => {
      if (file !== 'git' || !args.includes('worktree') || ++calls !== 1)
        return Promise.reject(new Error('inventory unavailable'));
      return executor.runFileAsync(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        {
          ...options,
          onSpawn: (spawned) => {
            child = spawned;
            spawned.stdout?.once('data', started);
          },
        },
      );
    },
  });
  const pending = measureWorktreeSweep(sweep());
  await ready;
  await vi.advanceTimersByTimeAsync(10_000);
  const report = await pending;
  expect(child?.signalCode).toBe('SIGKILL');
  expect(report.unlisted).toEqual([]);
});
