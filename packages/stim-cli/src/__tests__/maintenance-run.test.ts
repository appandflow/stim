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
} from '@stim-cli/core/state';
import { runMaintenance } from '../maintenance/run.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import * as measurements from '../maintenance/measure.ts';
import * as budget from '../budget.ts';
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
  await runMaintenance('status');
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
    sections: { maintenance: { note: expect.stringContaining('no pass has run yet') } },
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
