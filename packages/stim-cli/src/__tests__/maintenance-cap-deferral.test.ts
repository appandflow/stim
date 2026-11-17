import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceStateFile, readMaintenanceState, type MaintenanceState } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { planCargoTargetsAtPressure, trimCargoTargetAction } from '../stimd/passes/cargo-target.ts';
import { deferCheck } from '../stimd/passes/defer.ts';
import { due } from '../stimd/passes/due.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import * as budget from '../stimd/passes/budget.ts';
import * as fsUtil from '../fs-util.ts';
import * as daemonPasses from '../daemon/passes.ts';
import { runMaintenanceAtLevel } from '../stimd/passes/level-run.ts';
import { runMaintenance } from '../stimd/passes/run.ts';
import * as measurements from '../stimd/passes/measure.ts';
import { maintenanceStatus } from '../stimd/passes/status.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';

let base: string;
let target: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cap-deferral-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('STIM_DAEMON', 'report');
  vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '0.000001');
  saveConfig({ version: 2, projects: {}, repos: {} });
  const app = join(base, 'app');
  mkdirSync(join(app, 'ios', 'App.xcodeproj'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  writeFileSync(join(app, '.gitignore'), 'target/\n');
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'init');
  target = join(app, 'target');
  mkdirSync(join(target, 'debug', '.fingerprint'), { recursive: true });
  mkdirSync(join(target, 'debug', 'incremental'), { recursive: true });
  writeFileSync(join(target, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFileSync(join(target, 'debug', 'incremental', 'data'), 'x'.repeat(200_000));
  upsertProject(app, { metroPort: null });
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: 500 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(true);
  vi.spyOn(measurements, 'measureSizes').mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test('while host load defers the size scan, the cap still measures and plans an over-cap target, and status says since when', async () => {
  await runMaintenance('test');

  const state = readMaintenanceState();
  expect(measurements.measureSizes).not.toHaveBeenCalled();
  expect(state?.lastAt.size).toBeUndefined();
  expect(state?.sizes.map(({ name, dir }) => [name, dir])).toEqual([['Cargo target', target]]);
  expect(state?.plan.map(({ kind, target: dir }) => [kind, dir])).toEqual([['would-clear-build-dirs', target]]);
  expect(maintenanceStatus().deferred).toContainEqual({ check: 'size', since: expect.any(Number) });
});

test('a size scan deferred for the ceiling runs anyway, and the status field clears', async () => {
  await runMaintenance('test');
  const state = readMaintenanceState();
  if (!state) throw new Error('no state');
  state.deferredSince = { size: Date.now() - 4 * 3_600_000 };
  state.deferredAt = {};
  writeFileSync(maintenanceStateFile(), JSON.stringify(state));

  await runMaintenance('test');

  expect(measurements.measureSizes).toHaveBeenCalledTimes(1);
  expect(maintenanceStatus().deferred?.map(({ check }) => check) ?? []).not.toContain('size');
});

test('host load defers a check at the normal disk level and at no other', () => {
  const state: MaintenanceState = {
    version: 1,
    lastAt: {},
    pressure: null,
    sizes: [],
    lastPass: null,
    recent: [],
    plan: [],
  };
  for (const check of ['size', 'idle', 'worktree', 'sweep'] as const) {
    expect(deferCheck(state, check, Date.now(), true, 'normal')).toBe(true);
    expect(deferCheck(state, check, Date.now(), true, 'high')).toBe(false);
    expect(deferCheck(state, check, Date.now(), true, 'critical')).toBe(false);
    expect(deferCheck(state, check, Date.now(), false, 'normal')).toBe(false);
  }
});

test('at the high disk level the size scan runs under the same load that defers it at normal', async () => {
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: 30 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });

  await runMaintenance('test');

  expect(measurements.measureSizes).toHaveBeenCalledTimes(1);
  expect(readMaintenanceState()?.lastAt.size).toEqual(expect.any(Number));
  expect(maintenanceStatus().deferred?.map(({ check }) => check) ?? []).not.toContain('size');
});

test('a target on a volume at high is planned for trimming from its structure, with no size and no walk', async () => {
  const walk = vi.spyOn(fsUtil, 'measuredDirectorySizeAsync');
  const plan = (level: 'normal' | 'high', settings = resolveMaintenanceSettings()) =>
    planCargoTargetsAtPressure({
      settings,
      pinned: () => false,
      now: Date.now(),
      diskLevel: async () => level,
    });

  expect((await plan('high')).actions).toMatchObject([{ kind: 'would-clear-build-dirs', target, level: 2, bytes: 0 }]);
  expect((await plan('normal')).actions).toEqual([]);
  expect((await plan('high', { ...resolveMaintenanceSettings(), cargoTargetMaxGb: 0 })).actions).toEqual([]);
  expect(walk).not.toHaveBeenCalled();
});

test.skipIf(process.platform === 'win32')(
  'an acting run at high trims a Cargo target before it measures any size, and a dry run trims nothing',
  async () => {
    vi.spyOn(daemonPasses, 'runDormantReduction').mockResolvedValue([]);
    vi.spyOn(daemonPasses, 'runForcedLadder').mockResolvedValue(null);
    const incremental = join(target, 'debug', 'incremental');
    let presentAtMeasure: boolean | undefined;
    vi.spyOn(measurements, 'measureSizes').mockImplementation(async () => {
      presentAtMeasure ??= existsSync(incremental);
      return [];
    });

    await runMaintenanceAtLevel({ level: 'high', act: false });
    expect(presentAtMeasure).toBe(true);
    expect(existsSync(incremental)).toBe(true);

    presentAtMeasure = undefined;
    const run = await runMaintenanceAtLevel({ level: 'high', act: true });

    expect(presentAtMeasure).toBe(false);
    expect(existsSync(incremental)).toBe(false);
    expect(run.actions).toContainEqual(expect.objectContaining({ kind: 'trim-cargo', target, outcome: 'done' }));
  },
);

test('a check deferred at normal is due at once once the disk level is above normal', () => {
  const state: MaintenanceState = {
    version: 1,
    lastAt: {},
    deferredAt: { size: Date.now() - 1000 },
    pressure: null,
    sizes: [],
    lastPass: null,
    recent: [],
    plan: [],
  };
  const settings = { worktreeCheckMinutes: 10, sweepHours: 24, removeFinishedWorktrees: true };
  expect(due(state, settings, Date.now(), 'normal')).not.toContain('size');
  expect(due(state, settings, Date.now(), 'high')).toContain('size');
});

test.skipIf(process.platform === 'win32')(
  'a pressure trim reports the free-space gain of its own volume, and 0 when a sample is missing',
  async () => {
    const volume = (freeMb: number) => [{ volume: '/', freeMb, device: 1 }];
    const action = {
      kind: 'would-clear-build-dirs',
      target,
      workspace: join(target, '..'),
      bytes: 0,
      level: 2,
      olderThanDays: 1,
      reason: 'test',
    } as const;
    const samples = vi.spyOn(budget, 'readVolumeSpaceAsync');

    samples.mockResolvedValueOnce(volume(1000)).mockResolvedValueOnce([]);
    const missing = await trimCargoTargetAction(action);
    expect(missing).toMatchObject({ status: 'done', bytes: 0 });

    mkdirSync(join(target, 'debug', 'incremental'), { recursive: true });
    writeFileSync(join(target, 'debug', 'incremental', 'data'), 'x');
    samples.mockResolvedValueOnce(volume(1000)).mockResolvedValueOnce(volume(1005));
    const measured = await trimCargoTargetAction(action);
    expect(measured).toMatchObject({ status: 'done', bytes: 5 * 1024 * 1024 });
  },
);
