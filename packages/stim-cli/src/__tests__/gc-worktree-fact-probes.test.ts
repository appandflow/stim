import type { StimContext } from '@stim-cli/core';
import { removeWorktreeTarget } from '../commands/worktree.ts';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { collectWorktreeSweep } from '../commands/gc/worktrees.ts';
import { upsertProject } from '../workspace/config.ts';
import { withAmbientContext } from '@stim-cli/core';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { runReport } from '../report-runtime.ts';
import { testContext } from './_context.ts';

let home: string;
let linked: string;
let child: ChildProcess | undefined;
let reportAbort: AbortController | undefined;
let activeReport: Promise<unknown> | undefined;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-worktree-facts-')));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  resetExecutor();
  const root = join(home, 'repo');
  linked = join(home, 'linked');
  mkdirSync(root);
  writeFileSync(join(root, 'tracked.txt'), 'initial');
  const executor = getExecutor();
  executor.runFile('git', ['init', '-q', '-b', 'main', root], { timeoutMs: 5000 });
  executor.runFile('git', ['-C', root, 'add', 'tracked.txt'], { timeoutMs: 5000 });
  executor.runFile(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'initial',
    ],
    { timeoutMs: 5000 },
  );
  executor.runFile('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature', linked], { timeoutMs: 5000 });
  writeFileSync(join(linked, 'tracked.txt'), 'changed');
  upsertProject(root, { metroPort: null });
  setExecutor({ ...executor, findExecutable: (name) => (name === 'gh' ? null : executor.findExecutable(name)) });
});

afterEach(async () => {
  reportAbort?.abort();
  await activeReport?.catch(() => {});
  reportAbort = undefined;
  activeReport = undefined;
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

test.each([
  'status',
  'dirty paths',
  'HEAD',
  'unpushed branch',
  'unpushed commits',
  'submodule path',
  'submodule index',
  'activity',
] as const)('a delayed %s Git fact leaves the event loop responsive and retains the dirty worktree', async (phase) => {
  const executor = getExecutor();
  let statuses = 0;
  let responsive: boolean | undefined;
  let claimRoot = '';
  let probePid: number | undefined;
  let recordedPid: number | undefined;
  const info = join(home, 'probe.json');
  const selected = (file: string, args: string[]) => {
    if (file !== 'git' || !args.includes(linked)) return false;
    if (phase === 'status' || phase === 'dirty paths')
      return args.includes('status') && ++statuses === (phase === 'status' ? 1 : 2);
    if (phase === 'HEAD') return args.includes('HEAD^{commit}') && args.includes('--end-of-options');
    if (phase === 'unpushed branch') return args.includes('symbolic-ref') && args.includes('--short');
    if (phase === 'unpushed commits') return args.includes('log') && args.includes('--oneline');
    if (phase === 'submodule path') return args.includes('--git-path') && args.includes('modules');
    if (phase === 'submodule index') return args.includes('ls-files') && args.includes('--stage');
    return args.includes('--git-dir');
  };
  const proxy = [
    '-e',
    'require("node:fs").writeFileSync(process.env.STIM_GC_PROBE_INFO,JSON.stringify({cwd:process.cwd(),tag:process.env.STIM_GC_PROBE_TAG})); setTimeout(() => { const { execFileSync } = require("node:child_process"); process.stdout.write(execFileSync("git", process.argv.slice(1), { encoding: "utf8", timeout: 5000 })); }, 150)',
    '--',
  ];
  const sync = (file: string, args: string[], options: Parameters<typeof executor.runFile>[2], quiet: boolean) => {
    const call = quiet ? executor.runFileQuiet.bind(executor) : executor.runFile.bind(executor);
    if (!selected(file, args)) return call(file, args, options);
    let ticked = false;
    const timer = setTimeout(() => (ticked = true), 25);
    try {
      const output = call(process.execPath, [...proxy, ...args], options);
      responsive = ticked;
      return output;
    } finally {
      clearTimeout(timer);
    }
  };
  setExecutor({
    ...executor,
    runFile: (file, args, options) => sync(file, args, options, false) ?? '',
    runFileQuiet: (file, args, options) => sync(file, args, options, true),
    async runFileAsync(file, args, options) {
      if (!selected(file, args)) return executor.runFileAsync(file, args, options);
      let ticked = false;
      const timer = setTimeout(() => (ticked = true), 25);
      try {
        const output = await executor.runFileAsync(process.execPath, [...proxy, ...args], {
          ...options,
          onSpawn: (spawned) => {
            options.onSpawn?.(spawned);
            child = spawned;
            probePid = spawned.pid;
            recordedPid = readClaimSet(claimRoot).live[0]?.child?.pid;
          },
        });
        responsive = ticked;
        return output;
      } finally {
        clearTimeout(timer);
      }
    },
  });
  reportAbort = new AbortController();
  const context = testContext({
    home,
    projectRoot: linked,
    cwd: linked,
    env: { ...process.env, STIM_GC_PROBE_INFO: info, STIM_GC_PROBE_TAG: phase },
    signal: reportAbort.signal,
  });
  const pending = runReport(context, (operation) =>
    withAmbientContext(operation, () =>
      withWorkspaceProcessLock(
        home,
        'facts',
        async (claim) => {
          claimRoot = claim.root;
          return collectWorktreeSweep({ idle: true, olderThan: null, graceMs: 0, now: Date.now(), operation });
        },
        { external: true, declareSpawnsFor: operation },
      ),
    ),
  );
  activeReport = pending;
  const report = await pending;
  const candidate = report.worktrees.find(({ path }) => path === linked);
  expect(responsive).toBe(true);
  expect(probePid).toBeDefined();
  expect(recordedPid).toBe(probePid);
  expect(JSON.parse(readFileSync(info, 'utf8'))).toEqual({ cwd: linked, tag: phase });
  expect(readClaimSet(claimRoot).live).toEqual([]);
  expect(candidate).toMatchObject({
    path: linked,
    keys: [linked],
    skipCode: 'dirty',
    head: expect.stringMatching(/^[a-f0-9]{40}$/),
    activity: { at: expect.any(Number) },
  });
  expect(candidate?.skipped).toContain('tracked.txt');
  expect(existsSync(join(linked, 'tracked.txt'))).toBe(true);
});

test('a stalled status child is killed at the safety budget and reports unreadable status', async () => {
  const executor = getExecutor();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  vi.useFakeTimers();
  setExecutor({
    ...executor,
    runFileAsync: (file, args, options) =>
      file === 'git' && args.includes(linked) && args.includes('status')
        ? executor.runFileAsync(
            process.execPath,
            ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'],
            {
              ...options,
              onSpawn: (spawned) => {
                child = spawned;
                spawned.stdout?.once('data', started);
              },
            },
          )
        : executor.runFileAsync(file, args, options),
  });
  const pending = collectWorktreeSweep({ idle: true, olderThan: null, graceMs: 0, now: Date.now() });
  await ready;
  await vi.advanceTimersByTimeAsync(60_000);
  const report = await pending;
  expect(child?.signalCode).toBe('SIGKILL');
  expect(report.worktrees.find(({ path }) => path === linked)).toMatchObject({
    skipCode: 'status-unreadable',
    skipped: 'git status could not be read',
  });
  expect(existsSync(join(linked, 'tracked.txt'))).toBe(true);
});

test('cancelling a blocked removal safety check drains its child and keeps the worktree and branch', async () => {
  const executor = getExecutor();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const operation: StimContext = {
    home,
    projectRoot: linked,
    cwd: linked,
    buildCache: null,
    env: { ...process.env },
    runId: 'remove-cancel',
    signal: controller.signal,
    output: () => {},
  };
  const exit = process.exitCode;
  setExecutor({
    ...executor,
    runFileAsync: (file, args, options) =>
      file === 'git' && args.includes(linked) && args.includes('status')
        ? executor.runFileAsync(
            process.execPath,
            ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
            {
              ...options,
              onSpawn: (spawned) => {
                child = spawned;
                spawned.stdout?.once('data', started);
              },
            },
          )
        : executor.runFileAsync(file, args, options),
  });
  const pending = removeWorktreeTarget(linked, {
    linkedOnly: true,
    operation,
    output: { error: () => {}, fail: () => {} },
  });
  try {
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error('Removal returned before its asynchronous safety check started.');
      }),
    ]);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(child && (child.exitCode !== null || child.signalCode === 'SIGKILL')).toBe(true);
    expect(existsSync(join(linked, 'tracked.txt'))).toBe(true);
    expect(executor.runFile('git', ['-C', linked, 'branch', '--show-current'], { timeoutMs: 5000 })).toBe('feature');
    expect(process.exitCode).toBe(exit);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});
