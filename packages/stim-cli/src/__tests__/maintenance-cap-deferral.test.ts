import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diskUsageCacheFile,
  maintenanceStateFile,
  readDiskUsage,
  readJsonObject,
  readMaintenanceState,
  type MaintenanceState,
} from '@stim-cli/core/state';
import { writeCacheFile } from '../cache-file.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { planCargoTargetsAtPressure, trimCargoTargetAction } from '../stimd/passes/cargo-target.ts';
import { deferCheck } from '../stimd/passes/defer.ts';
import { due } from '../stimd/passes/due.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import * as budget from '../stimd/passes/budget.ts';
import * as fsUtil from '../fs-util.ts';
import * as daemonPasses from '../daemon/passes.ts';
import * as stages from '../daemon/stages.ts';
import { runMaintenanceAtLevel } from '../stimd/passes/level-run.ts';
import { runMaintenance } from '../stimd/passes/run.ts';
import * as measurements from '../stimd/passes/measure.ts';
import { maintenanceStatus } from '../stimd/passes/status.ts';
import { markWriter } from '../daemon/marks.ts';
import { saveConfig, upsertProject, loadConfig } from '../workspace/config.ts';
import { scanSourceWrites } from '../workspace/discovered-activity.ts';
import * as gitCommands from '../workspace/git.ts';

let base: string;
let target: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

beforeEach(async () => {
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
  writeFileSync(join(target, 'debug', '.cargo-lock'), '');
  mkdirSync(join(target, 'debug', 'incremental'), { recursive: true });
  writeFileSync(join(target, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFileSync(join(target, 'debug', 'incremental', 'data'), 'x'.repeat(200_000));
  upsertProject(app, { metroPort: null });
  const config = loadConfig();
  if (!config) throw new Error('missing fixture config');
  await markWriter(config)({ path: app, at: Date.now(), lastActivityAt: null, kept: null });
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
  expect(readDiskUsage(target)?.bytes).toBe(state?.sizes[0]?.bytes);
  expect(state?.plan.map(({ kind, target: dir }) => [kind, dir])).toEqual([['would-clear-build-dirs', target]]);
  expect(maintenanceStatus().deferred).toContainEqual({ check: 'size', since: expect.any(Number) });
});

test('while host load defers the size scan, the cap gives the disk owner a unit boundary before each target walk', async () => {
  const other = join(base, 'other');
  mkdirSync(join(other, 'target', 'debug', 'incremental'), { recursive: true });
  writeFileSync(join(other, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  writeFileSync(join(other, '.gitignore'), 'target/\n');
  writeFileSync(join(other, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'init');
  upsertProject(other, { metroPort: null });
  const order: string[] = [];
  const walk = fsUtil.measuredDirectorySizeAsync;
  vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async (dir, options) => {
    order.push(dir.endsWith('target') ? 'walk' : 'other');
    return walk(dir, options);
  });

  await runMaintenance('test', { between: async () => void order.push('boundary') });

  const walks = order.flatMap((entry, at) => (entry === 'walk' ? [order[at - 1]] : []));
  expect(walks).toEqual(['boundary', 'boundary']);
});

test('the cap writes its Cargo size over an older disk-usage record, keeping its other fields but the private sizes, and leaves a newer one', async () => {
  const record = (at: number) => ({
    path: target,
    measuredAt: new Date(at).toISOString(),
    bytes: 1,
    walkMs: 5,
    privateBytes: 1,
    partial: true,
  });
  writeCacheFile(diskUsageCacheFile(target), record(Date.now() + 60_000));
  await runMaintenance('test');
  expect(readJsonObject(diskUsageCacheFile(target))).toMatchObject({ bytes: 1, walkMs: 5, privateBytes: 1 });

  writeCacheFile(diskUsageCacheFile(target), record(Date.now() - 2 * 3_600_000));
  writeFileSync(maintenanceStateFile(), '{}');
  await runMaintenance('test');
  const rewritten = readJsonObject(diskUsageCacheFile(target));
  expect(rewritten).toMatchObject({ bytes: readMaintenanceState()?.sizes[0]?.bytes, walkMs: 5 });
  expect(rewritten).not.toHaveProperty('privateBytes');
  expect(rewritten).not.toHaveProperty('partial');
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

test('pressure plans retain their local mark proof and keep a copied or superseded action', async () => {
  const plan = await planCargoTargetsAtPressure({
    settings: resolveMaintenanceSettings(),
    pinned: () => false,
    now: Date.now(),
    level: 'critical',
  });
  const action = plan.actions[0];
  if (!action) throw new Error('missing pressure plan');
  expect(await trimCargoTargetAction(structuredClone(action))).toMatchObject({
    status: 'kept',
    detail: 'its pressure mark proof is no longer available',
  });
  const root = join(target, '..');
  const config = loadConfig();
  if (!config) throw new Error('missing fixture config');
  await markWriter(config)({ path: root, at: Date.now() + 1_000, lastActivityAt: null, kept: null });
  expect(await trimCargoTargetAction(action)).toMatchObject({
    status: 'kept',
    detail: 'its checkout is no longer in a workspace or discovery scope',
  });
  expect(existsSync(join(target, 'debug', 'incremental', 'data'))).toBe(true);
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

test('a discovered checkout whose source scan ran out of time is listed as kept for this pass', async () => {
  vi.spyOn(daemonPasses, 'runDormantReduction').mockResolvedValue([]);
  vi.spyOn(daemonPasses, 'runForcedLadder').mockResolvedValue(null);
  saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [base] } });
  upsertProject(join(base, 'app'), { metroPort: null });
  const other = join(base, 'other');
  mkdirSync(join(other, 'ios', 'App.xcodeproj'), { recursive: true });
  writeFileSync(join(other, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  mkdirSync(join(other, 'build'));
  const probe = vi.spyOn(gitCommands, 'gitQuietAsync').mockImplementation(async () => {
    vi.advanceTimersByTime(20_000);
    return '';
  });
  const scan = await scanSourceWrites(other, Date.now() + 86_400_000);
  probe.mockRestore();
  if (!('unknown' in scan)) throw new Error('the scan did not run out of time');
  vi.spyOn(stages, 'discoveredKeepReason').mockResolvedValue(scan.unknown);

  const run = await runMaintenanceAtLevel({ act: false });

  expect(run.blocked).toContain(
    `Discovered checkout ${other}: ${scan.unknown}, so it is kept this pass and checked again on a later one`,
  );
});
