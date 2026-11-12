import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maintenanceChildLogFile,
  maintenanceDir,
  maintenanceStateFile,
  gcLogFile,
  maintenanceRunClaims,
  readMaintenanceState,
  workspaceLogsDir,
  sharedCompilationCache,
} from '@stim-cli/core/state';
import { runMaintenance } from '../stimd/passes/run.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import * as measurements from '../stimd/passes/measure.ts';
import * as preview from '../stimd/passes/preview.ts';
import { cacheClaimRoot } from '../cache/cache-claim.ts';
import { maintenanceStatus } from '../stimd/passes/status.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { runGc } from '../commands/gc.ts';
import statusOp from '../commands/status.ts';
import { runCli } from '../cli/define-op.ts';
import { warnCriticalDisk } from '../stimd/passes/trigger.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeChildProcess } from './_factories.ts';

const disk = vi.hoisted(() => ({ full: false, reserve: '', code: 'ENOSPC', partialReserveWrite: false }));
vi.mock('@stim-cli/core/ownership-claim', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stim-cli/core/ownership-claim')>();
  const { existsSync: exists } = await import('node:fs');
  return {
    ...original,
    tryAcquireClaim: (...args: Parameters<typeof original.tryAcquireClaim>) => {
      if (disk.full && (!disk.reserve || exists(disk.reserve)))
        throw Object.assign(new Error(`${disk.code}: no space left, mkdir '${args[0].root}'`), { code: disk.code });
      return original.tryAcquireClaim(...args);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      if (disk.partialReserveWrite && String(args[0]).endsWith('disk-reserve')) {
        original.writeFileSync(args[0], 'partial');
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return original.writeFileSync(...args);
    },
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-maintenance-run-'));
  process.env.STIM_HOME = home;
  process.env.STIM_DAEMON = 'report';
  process.env.STIM_DISK_MIN_FREE_GB = '20';
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    runFile: () => '',
    runFileQuiet: () => null,
    findExecutable: () => null,
    spawn: () => makeChildProcess(),
  });
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: 18 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
  vi.spyOn(measurements, 'measureSizes').mockResolvedValue([]);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  Object.assign(disk, { full: false, reserve: '', code: 'ENOSPC', partialReserveWrite: false });
  for (const key of ['STIM_HOME', 'STIM_DAEMON', 'STIM_DISK_MIN_FREE_GB', 'STIM_DISK_HARD_FLOOR_GB'])
    delete process.env[key];
  process.env.STIM_DAEMON = 'off';
  process.exitCode = 0;
});

test('load deferral leaves the size check due and a failing pressure check is not retried by the next command', async () => {
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(true);
  vi.spyOn(measurements, 'measurePressure').mockImplementation(() => {
    throw new Error('statfs failed');
  });
  await runMaintenance('status');
  const state = readMaintenanceState()!;
  expect(state.lastAt.pressure).toEqual(expect.any(Number));
  expect(state.lastAt.size).toBeUndefined();
  expect(state.recent).toContainEqual(
    expect.objectContaining({ event: 'maintenance_failure', error: 'statfs failed' }),
  );
  await runMaintenance('status');
  expect(measurements.measurePressure).toHaveBeenCalledTimes(1);
  expect(measurements.measureSizes).not.toHaveBeenCalled();
});

test('an already held pass makes the child exit silently, names the holder to its caller, and gc refuses with the holder', async () => {
  const attempt = tryAcquireClaim({
    root: maintenanceRunClaims(),
    mode: 'exclusive',
    label: 'maintenance',
    details: { trigger: 'first-pass' },
  });
  expect(attempt.acquired).toBeDefined();
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await runMaintenance('second-pass')).toBe(`pid ${process.pid} runs a maintenance pass (first-pass)`);
    expect(readMaintenanceState()).toBeNull();
    expect(measurements.measurePressure).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    await runGc({ pressure: 'normal', json: true });
    const payload = JSON.parse(String(out.mock.calls[0]![0]));
    expect(payload).toMatchObject({ code: 'STIM_CLAIM_REFUSED' });
    expect(payload.message).toContain(`pid ${process.pid}`);
    expect(payload.message).toContain('first-pass');
    expect(payload.message).toContain(attempt.acquired!.path);
    expect(out).toHaveBeenCalledTimes(1);
  } finally {
    releaseClaim(attempt.acquired!);
  }
});

test('a pass creates its disk reserve, and at zero free disk frees it to take its claim and run', async () => {
  const reserve = join(maintenanceDir(), 'disk-reserve');
  await runMaintenance('status');
  expect(readFileSync(reserve).length).toBe(1024 * 1024);
  rmSync(maintenanceStateFile());
  Object.assign(disk, { full: true, reserve });
  await runMaintenance('status');
  expect(readMaintenanceState()?.lastPass).toMatchObject({ trigger: 'status', mode: 'report' });
  expect(readFileSync(reserve).length).toBe(1024 * 1024);
  expect(existsSync(maintenanceRunClaims())).toBe(false);
});

test('gc at zero free disk gives back the reserve to take its claim, then deletes', async () => {
  const reserve = join(maintenanceDir(), 'disk-reserve');
  await runMaintenance('status');
  const orphan = join(home, 'workspaces', 'orphan--0000000000000000');
  mkdirSync(orphan, { recursive: true });
  Object.assign(disk, { full: true, reserve });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ pressure: 'normal', json: true });
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ mode: 'delete', level: 'normal', failures: 0 });
  expect(existsSync(orphan)).toBe(false);
  expect(readFileSync(reserve).length).toBe(1024 * 1024);
  expect(existsSync(maintenanceRunClaims())).toBe(false);
});

test('a reserve that can be neither written nor removed still releases the run claim', async () => {
  mkdirSync(join(maintenanceDir(), 'disk-reserve', 'blocker'), { recursive: true });
  await runMaintenance('status');
  expect(readMaintenanceState()?.lastPass).toMatchObject({ trigger: 'status' });
  expect(existsSync(join(maintenanceDir(), 'disk-reserve', 'blocker'))).toBe(true);
  expect(existsSync(maintenanceRunClaims())).toBe(false);
});

test('an unresolved claim produces only one child crash-log line', async () => {
  mkdirSync(join(maintenanceRunClaims(), 'exclusive'), { recursive: true });
  writeFileSync(join(maintenanceRunClaims(), 'exclusive', 'bad.claim'), '{');
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  writeFileSync(maintenanceChildLogFile(), 'x'.repeat(65 * 1024));
  await runMaintenance('status');
  expect(maintenanceStatus().claim).toMatchObject({
    unresolved: expect.stringContaining('bad.claim'),
    removeCommand: expect.stringContaining('bad.claim'),
  });
  expect(readFileSync(maintenanceChildLogFile(), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readMaintenanceState()).toBeNull();
  expect(err).not.toHaveBeenCalled();
});

test('status and gc JSON each stay a single payload under the preAction disk warning', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runCli(statusOp, ['--json'], { version: '9.9.9', before: () => warnCriticalDisk(['status', '--json']) });
  expect(out).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({
    environments: [],
    maintenance: { mode: 'report', running: null },
    daemon: { mode: 'report', running: null },
  });
  out.mockClear();
  warnCriticalDisk(['gc', '--json']);
  await runGc({ json: true, dryRun: true });
  expect(out).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ mode: 'dry-run', failures: null });
});

test.each([
  ['two consecutive identical passes produce one set of action and skip records and one pass record', false],
  ['a changed plan logs only newly planned actions and skips', true],
] as const)('%s', async (_name, changed) => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const workspace = join(home, 'idle');
  ensureWorkspaceStorage(workspace);
  const action = {
    kind: 'would-clear-outputs' as const,
    target: workspace,
    workspace,
    bytes: 1024,
    reason: 'low disk',
  };
  const skip = { target: 'busy', workspace, reason: 'build in progress' };
  const planned = vi.spyOn(preview, 'plannedMaintenance').mockResolvedValue({
    actions: [action],
    skips: [skip],
    blocked: ['busy'],
    byCheck: { caps: { skips: [skip], blocked: ['busy'] } },
  });
  await runMaintenance('status');
  now += 15 * 60_000;
  if (changed)
    planned.mockResolvedValue({
      actions: [action, { ...action, target: 'new-output' }],
      skips: [skip, { ...skip, target: 'new-busy' }],
      blocked: ['busy'],
      byCheck: { caps: { skips: [skip, { ...skip, target: 'new-busy' }], blocked: ['busy'] } },
    });
  await runMaintenance('status');
  const records = readFileSync(gcLogFile(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const actions = records.filter((record) => record.event === 'maintenance_action');
  const skips = records.filter((record) => record.event === 'maintenance_skip');
  expect(actions.map((record) => record.action.target)).toEqual(changed ? [workspace, 'new-output'] : [workspace]);
  expect(skips.map((record) => record.target)).toEqual(changed ? ['busy', 'new-busy'] : ['busy']);
  expect(records.filter((record) => record.event === 'maintenance_pass')).toHaveLength(changed ? 2 : 1);
  const mirrored = readFileSync(join(workspaceLogsDir(workspace), 'maintenance.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    mirrored.filter((record) => record.event === 'maintenance_action').map((record) => record.action.target),
  ).toEqual(actions.map((record) => record.action.target));
  expect(mirrored.filter((record) => record.event === 'maintenance_skip').map((record) => record.target)).toEqual(
    skips.map((record) => record.target),
  );
  expect(readMaintenanceState()).toMatchObject({
    lastPass: { startedAt: now },
    plan: changed ? [action, { ...action, target: 'new-output' }] : [action],
  });
});

test('a kept worktree is logged once per reason code, with the code', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const target = join(home, 'kept-worktree');
  const keep = (code: string, reason: string) => ({ target, reason, code });
  const planned = vi.spyOn(preview, 'plannedMaintenance');
  const pass = async (skip: ReturnType<typeof keep>) => {
    planned.mockResolvedValue({
      actions: [],
      skips: [skip],
      blocked: [],
      byCheck: { worktree: { skips: [skip], blocked: [] } },
    });
    await runMaintenance('status');
    now += 15 * 60_000;
  };

  await pass(keep('dirty', 'dirty: 1 uncommitted or untracked file (a.ts)'));
  await pass(keep('dirty', 'dirty: 2 uncommitted or untracked files (a.ts, b.ts)'));
  await pass(keep('unpushed', 'unpushed: 1 commit on no remote or other branch'));

  const logged = readFileSync(gcLogFile(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.event === 'maintenance_skip');
  expect(logged.map(({ target: path, code }) => ({ path, code }))).toEqual([
    { path: target, code: 'dirty' },
    { path: target, code: 'unpushed' },
  ]);
});

test('a pass where only the minute pressure reading is due keeps the last plan and pass', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const action = { kind: 'would-clear-outputs' as const, target: join(home, 'a'), bytes: 1024, reason: 'over cap' };
  const planned = vi
    .spyOn(preview, 'plannedMaintenance')
    .mockResolvedValue({ actions: [action], skips: [], blocked: [], byCheck: {} });
  await runMaintenance('status');
  const first = readMaintenanceState();
  now += 60_000;
  planned.mockResolvedValue({ actions: [{ ...action, target: join(home, 'b') }], skips: [], blocked: [], byCheck: {} });
  await runMaintenance('status');

  expect(readMaintenanceState()).toMatchObject({
    lastAt: { ...first?.lastAt, pressure: now },
    lastPass: first?.lastPass,
    plan: [action],
  });
});

test('a pass where only the idle check is due keeps the cap trims of the last size check', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const dir = join(home, 'build-cache');
  vi.spyOn(measurements, 'measureSizes').mockResolvedValue([
    { name: 'shared build cache', category: 'build-cache', dir, bytes: 10 * 1024 ** 3, measuredAt: now },
  ]);
  process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = '5';
  onTestFinished(() => {
    delete process.env.STIM_CACHES_BUILD_CACHE_MAX_GB;
  });
  await runMaintenance('status');
  const trim = expect.objectContaining({ kind: 'would-trim-cache', target: dir });
  expect(readMaintenanceState()?.plan).toEqual([trim]);
  process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = '50';
  now += 5 * 60_000;
  await runMaintenance('status');

  expect(readMaintenanceState()).toMatchObject({ lastAt: { idle: now }, plan: [trim] });
});

test.each(['report', 'on'])(
  'in %s mode a cap the last size check could not reach stays blocked, and is logged once, across idle-only passes',
  async (mode) => {
    process.env.STIM_DAEMON = mode;
    process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = '5';
    onTestFinished(() => {
      delete process.env.STIM_CACHES_BUILD_CACHE_MAX_GB;
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const dir = join(home, 'build-cache');
    vi.spyOn(measurements, 'measureSizes').mockResolvedValue([
      {
        name: 'shared build cache',
        category: 'build-cache',
        dir,
        bytes: 10 * 1024 ** 3,
        measuredAt: now,
        blocked: 'a build uses it',
      },
    ]);
    const blocked = ['build-cache 10.0G over the 5G cap; target 4.0G; eligible targets cannot reach the target'];
    await runMaintenance('status');
    expect(readMaintenanceState()?.lastPass?.blocked).toEqual(blocked);
    now += 5 * 60_000;
    await runMaintenance('status');
    expect(readMaintenanceState()?.lastPass?.blocked).toEqual(blocked);
    now += 15 * 60_000;
    await runMaintenance('status');

    expect(readMaintenanceState()).toMatchObject({ lastAt: { worktree: now }, lastPass: { blocked } });
    const records = readFileSync(gcLogFile(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.event === 'maintenance_pass')).toHaveLength(1);
    expect(records.filter((record) => record.event === 'maintenance_skip' && record.target === dir)).toHaveLength(1);
  },
);

test('in on mode a pass where only the idle check is due neither plans cap trims nor drops a kept one', async () => {
  process.env.STIM_DAEMON = 'on';
  process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = '5';
  process.env.STIM_CACHES_METRO_CACHE_MAX_GB = '50';
  onTestFinished(() => {
    delete process.env.STIM_CACHES_BUILD_CACHE_MAX_GB;
    delete process.env.STIM_CACHES_METRO_CACHE_MAX_GB;
  });
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const build = join(home, 'not-a-build-cache');
  const metro = join(home, 'not-a-metro-cache');
  vi.spyOn(measurements, 'measureSizes').mockResolvedValue([
    { name: 'shared build cache', category: 'build-cache', dir: build, bytes: 10 * 1024 ** 3, measuredAt: now },
    { name: 'Metro transform caches', category: 'metro-cache', dir: metro, bytes: 10 * 1024 ** 3, measuredAt: now },
  ]);
  await runMaintenance('status');
  const trim = expect.objectContaining({ kind: 'would-trim-cache', target: build });
  expect(readMaintenanceState()).toMatchObject({ plan: [trim], skipKeys: expect.arrayContaining([build]) });
  process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = '50';
  process.env.STIM_CACHES_METRO_CACHE_MAX_GB = '5';
  now += 5 * 60_000;
  await runMaintenance('status');

  const state = readMaintenanceState();
  expect(state).toMatchObject({ lastAt: { idle: now }, plan: [trim], skipKeys: expect.arrayContaining([build]) });
  expect(state?.skipKeys).not.toContain(metro);
});

test.each(['report', 'on'])(
  'in %s mode turning the sweep and worktree checks off drops what they last blocked, skipped and kept',
  async (mode) => {
    process.env.STIM_DAEMON = mode;
    onTestFinished(() => {
      delete process.env.STIM_MAINTENANCE_SWEEP_HOURS;
      delete process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES;
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const action = (check: 'sweep' | 'worktree') => ({
      kind: 'would-clear-outputs' as const,
      target: join(home, check),
      bytes: 1,
      reason: check,
      check,
    });
    const part = (check: 'sweep' | 'worktree') => ({
      blocked: [`${check} blocked`],
      skips: [{ target: `${check} skip`, reason: check }],
    });
    const planned = vi.spyOn(preview, 'plannedMaintenance').mockResolvedValue({
      actions: [action('sweep'), action('worktree')],
      blocked: ['sweep blocked', 'worktree blocked'],
      skips: [...part('sweep').skips, ...part('worktree').skips],
      byCheck: { sweep: part('sweep'), worktree: part('worktree') },
    });
    await runMaintenance('status');
    expect(readMaintenanceState()?.lastPass?.blocked).toEqual(['sweep blocked', 'worktree blocked']);
    process.env.STIM_MAINTENANCE_SWEEP_HOURS = '0';
    process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES = 'false';
    planned.mockResolvedValue({ actions: [], blocked: [], skips: [], byCheck: {} });
    now += 61 * 60_000;
    await runMaintenance('status');

    expect(readMaintenanceState()).toMatchObject({ lastPass: { blocked: [] }, skipKeys: [], plan: [] });
  },
);

test('cached Swift CAS observations refresh build protection before each plan', async () => {
  process.env.STIM_DISK_HARD_FLOOR_GB = '5';
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  mkdirSync(sharedCompilationCache());
  const sizes = [
    {
      name: 'Swift compilation cache',
      dir: sharedCompilationCache(),
      category: 'compilation-cache' as const,
      bytes: 16 * 1024 ** 3,
      measuredAt: 1,
      blocked: 'the ios build (pid 42 in /w/app) may be using it',
    },
  ];
  const settings = { ...resolveMaintenanceSettings(), swiftCompilationCacheMaxGb: 15 };
  expect((await preview.plannedMaintenance(sizes, settings)).actions).toContainEqual(
    expect.objectContaining({ kind: 'would-empty-cache' }),
  );
  const build = tryAcquireClaim({
    root: cacheClaimRoot(sharedCompilationCache()),
    mode: 'shared',
    details: { platform: 'ios', projectRoot: '/w/app' },
  }).acquired;
  const using = `the ios build (pid ${process.pid} in /w/app) may be using it`;
  try {
    const busy = await preview.plannedMaintenance(sizes, settings);
    expect(busy.actions).toEqual([]);
    expect(busy.skips).toContainEqual(expect.objectContaining({ target: sharedCompilationCache(), reason: using }));
  } finally {
    releaseClaim(build);
  }
});

test('invalid maintenance settings are explained in status rather than silently reported as off', async () => {
  process.env.STIM_MAINTENANCE_SWEEP_HOURS = 'bad';
  try {
    expect(maintenanceStatus()).toMatchObject({
      mode: 'off',
      invalid: expect.stringContaining('maintenance.sweepHours'),
    });
  } finally {
    delete process.env.STIM_MAINTENANCE_SWEEP_HOURS;
  }
});

test('an invalid cache cap falls back only that cap while report mode remains enabled', async () => {
  process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = '-1';
  try {
    expect(resolveMaintenanceSettings()).toMatchObject({
      mode: 'report',
      buildCacheMaxGb: 10,
      invalid: expect.stringContaining('caches.buildCacheMaxGb'),
    });
    expect(maintenanceStatus()).toMatchObject({
      mode: 'report',
      invalid: expect.stringContaining('caches.buildCacheMaxGb'),
    });
  } finally {
    delete process.env.STIM_CACHES_BUILD_CACHE_MAX_GB;
  }
});
