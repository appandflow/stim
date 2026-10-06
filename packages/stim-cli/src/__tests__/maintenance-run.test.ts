import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  maintenanceChildLogFile,
  maintenanceDir,
  maintenanceStateFile,
  maintenanceNdjsonFile,
  maintenanceRunClaims,
  readMaintenanceState,
  readMaintenanceAttempt,
  workspaceLogsDir,
  sharedCompilationCache,
} from '@stim-cli/core/state';
import { runMaintenance } from '../maintenance/run.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import * as measurements from '../maintenance/measure.ts';
import * as budget from '../budget.ts';
import * as preview from '../maintenance/preview.ts';
import * as log from '../maintenance/log.ts';
import * as buildLocks from '../engine/build-lock.ts';
import { maintenanceStatus } from '../maintenance/status.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { runGc } from '../commands/gc.ts';
import statusCommand from '../commands/status.ts';
import { triggerMaintenance } from '../maintenance/trigger.ts';
import { resetExecutor, setExecutor, type Executor } from '../exec.ts';
import { makeChildProcess } from './_factories.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-maintenance-run-'));
  process.env.STIM_HOME = home;
  process.env.STIM_MAINTENANCE = 'report';
  process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '20';
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
  vi.spyOn(measurements, 'measureSizes').mockReturnValue([]);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const key of ['STIM_HOME', 'STIM_MAINTENANCE', 'STIM_BUDGET_MIN_FREE_DISK_GB']) delete process.env[key];
  process.exitCode = 0;
});

test('report-only child passes dryRun to every budget step and stamps checks before running them', async () => {
  const original = budget.enforceBudget;
  const seen: boolean[] = [];
  vi.spyOn(budget, 'enforceBudget').mockImplementation((args, overrides) =>
    original(args, {
      ...overrides,
      step: async (step, context) => {
        seen.push(context.dryRun);
        expect(readMaintenanceState()?.lastAt.pressure).toEqual(expect.any(Number));
        return { targets: step === 'workspace-outputs' ? ['/idle'] : [], failures: 0 };
      },
    }),
  );
  await runMaintenance('status');
  expect(seen).toEqual([true, true, true, true]);
  const state = readMaintenanceState()!;
  expect(state.lastPass).toMatchObject({ mode: 'report', freedBytes: 0, stopped: 0, actions: 1 });
  expect(state.plan).toContainEqual(expect.objectContaining({ kind: 'would-clear-outputs', target: '/idle' }));
  expect(readFileSync(maintenanceNdjsonFile(), 'utf8')).not.toContain('maintenance_check');
  await runMaintenance('status');
  expect(seen).toHaveLength(4);
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

test('an already held pass makes the child exit silently and gc refuse with the holder', async () => {
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
    await runMaintenance('second-pass');
    expect(readMaintenanceState()).toBeNull();
    expect(measurements.measurePressure).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    await runGc({ delete: true, json: true });
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

test('an unresolved claim produces only one child crash-log line', async () => {
  mkdirSync(join(maintenanceRunClaims(), 'exclusive'), { recursive: true });
  writeFileSync(join(maintenanceRunClaims(), 'exclusive', 'bad.claim'), '{');
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  writeFileSync(maintenanceChildLogFile(), 'x'.repeat(65 * 1024));
  await runMaintenance('status');
  expect(readMaintenanceAttempt()).toEqual(expect.any(Number));
  expect(maintenanceStatus().claim).toMatchObject({
    unresolved: expect.stringContaining('bad.claim'),
    removeCommand: expect.stringContaining('bad.claim'),
  });
  expect(readFileSync(maintenanceChildLogFile(), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readMaintenanceState()).toBeNull();
  expect(err).not.toHaveBeenCalled();
});

test('status and gc JSON remain a single payload while their preAction hook starts a detached child', async () => {
  const spawn = vi.fn<Executor['spawn']>(() => makeChildProcess());
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    runFile: () => '',
    runFileQuiet: () => null,
    findExecutable: () => null,
    spawn,
  });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const program = new Command();
  statusCommand(program);
  program.hook('preAction', () => triggerMaintenance('status', { argv: ['status', '--json'] }));
  await program.parseAsync(['status', '--json'], { from: 'user' });
  expect(out).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({
    environments: [],
    maintenance: { mode: 'report', running: null },
  });
  out.mockClear();
  triggerMaintenance('gc', { argv: ['gc', '--json'] });
  await runGc({ json: true, cache: 'recordings' });
  expect(out).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({
    mode: 'dry-run',
    maintenance: { note: expect.stringContaining('no pass has run yet') },
  });
  expect(spawn).toHaveBeenCalledTimes(2);
  for (const call of spawn.mock.calls)
    expect(call[2]).toMatchObject({ detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] });
});

test('GC maintenance preview uses cached sizes and never calls du for a size scan', async () => {
  mkdirSync(maintenanceDir());
  writeFileSync(
    maintenanceStateFile(),
    JSON.stringify({
      version: 1,
      lastAt: { size: 1 },
      pressure: null,
      sizes: [
        {
          name: 'build cache',
          dir: join(home, 'build-cache'),
          category: 'build-cache',
          bytes: 12 * 1024 ** 3,
          measuredAt: 1,
        },
      ],
      lastPass: null,
      recent: [],
      plan: [],
    }),
  );
  const { previewMaintenance } = await import('../maintenance/preview.ts');
  vi.spyOn(budget, 'enforceBudget').mockResolvedValue({
    status: 'ok',
    reclaimed: [],
    budget: budget.resolveBudget().budget,
    measure: { volumes: [], memory: null },
    short: { disk: [], hardFloor: [], memory: false, workspaces: false },
  });
  const result = await previewMaintenance();
  expect(result.actions).toContainEqual(expect.objectContaining({ kind: 'would-trim-cache', bytes: 4 * 1024 ** 3 }));
  expect(measurements.measureSizes).not.toHaveBeenCalled();
  expect(resolveMaintenanceSettings()?.mode).toBe('report');
});

test.each([
  ['two consecutive identical passes produce one set of action and skip records and one pass record', false],
  ['a changed plan logs only newly planned actions and skips', true],
] as const)('%s', async (_name, changed) => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const workspace = join(home, 'idle');
  const action = {
    kind: 'would-clear-outputs' as const,
    target: workspace,
    workspace,
    bytes: 1024,
    reason: 'low disk',
  };
  const skip = { target: 'busy', workspace, reason: 'build in progress' };
  const planned = vi
    .spyOn(preview, 'plannedMaintenance')
    .mockResolvedValue({ actions: [action], skips: [skip], blocked: ['busy'] });
  await runMaintenance('status');
  now += 60_000;
  if (changed)
    planned.mockResolvedValue({
      actions: [action, { ...action, target: 'new-output' }],
      skips: [skip, { ...skip, target: 'new-busy' }],
      blocked: ['busy'],
    });
  await runMaintenance('status');
  const records = readFileSync(maintenanceNdjsonFile(), 'utf8')
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

test('failure before the first check stamp backs off child spawns for one minute', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(log, 'maintenanceLogger').mockImplementation(() => {
    throw new Error('log lock blocked');
  });
  await runMaintenance('status');
  expect(readMaintenanceState()).toBeNull();
  expect(readMaintenanceAttempt()).toBe(now);
  const spawn = vi.fn<Executor['spawn']>(() => makeChildProcess());
  setExecutor({ spawn });
  triggerMaintenance('status', { argv: ['status'] });
  now += 59_999;
  triggerMaintenance('status', { argv: ['status'] });
  expect(spawn).not.toHaveBeenCalled();
  now++;
  triggerMaintenance('status', { argv: ['status'] });
  expect(spawn).toHaveBeenCalledTimes(1);
});

test('cached Swift CAS observations refresh build protection before each plan', async () => {
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  const locks = vi.spyOn(buildLocks, 'listBuildLocks').mockReturnValue([]);
  mkdirSync(sharedCompilationCache());
  const sizes = [
    {
      name: 'Swift compilation cache',
      dir: sharedCompilationCache(),
      category: 'compilation-cache' as const,
      bytes: 16 * 1024 ** 3,
      measuredAt: 1,
      blocked: 'a build lock or slot is live or unresolved',
    },
  ];
  const settings = { ...resolveMaintenanceSettings(), swiftCompilationCacheMaxGb: 15 };
  expect((await preview.plannedMaintenance(null, sizes, settings)).actions).toContainEqual(
    expect.objectContaining({ kind: 'would-empty-cache' }),
  );
  locks.mockReturnValue([{ alive: true } as ReturnType<typeof buildLocks.listBuildLocks>[number]]);
  const busy = await preview.plannedMaintenance(null, sizes, settings);
  expect(busy.actions).toEqual([]);
  expect(busy.skips).toContainEqual(
    expect.objectContaining({ target: sharedCompilationCache(), reason: 'a build lock or slot is live or unresolved' }),
  );
});

test('invalid maintenance settings are explained in status and gc rather than silently reported as off', async () => {
  process.env.STIM_MAINTENANCE_SIZE_CHECK_MINUTES = 'bad';
  try {
    expect(maintenanceStatus()).toMatchObject({
      mode: 'off',
      invalid: expect.stringContaining('maintenance.sizeCheckMinutes'),
    });
    expect(await preview.previewMaintenance()).toMatchObject({
      mode: 'off',
      invalid: expect.stringContaining('maintenance.sizeCheckMinutes'),
      note: expect.stringContaining('maintenance.sizeCheckMinutes'),
    });
  } finally {
    delete process.env.STIM_MAINTENANCE_SIZE_CHECK_MINUTES;
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
    expect(await preview.previewMaintenance()).toMatchObject({
      mode: 'report',
      invalid: expect.stringContaining('caches.buildCacheMaxGb'),
    });
  } finally {
    delete process.env.STIM_CACHES_BUILD_CACHE_MAX_GB;
  }
});
