import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import * as discovery from '../workspace/discovery.ts';
import { testContext } from './_context.ts';
import { LADDER_CLOCK_SLOTS } from '../daemon/disk-owner.ts';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as daemonMeasure from '../daemon/measure.ts';
import {
  diskUsageCacheFile,
  gcMarkFile,
  maintenanceStateFile,
  readDiskUsage,
  readGcMark,
  readMaintenanceState,
  type MaintenanceState,
  type DaemonPressure,
} from '@stim-cli/core/state';
import { writeCacheFile } from '../cache-file.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { planCargoTargetsAtPressure, trimCargoTargetAction } from '../stimd/passes/cargo-target.ts';
import { deferCheck } from '../stimd/passes/defer.ts';
import { due } from '../stimd/passes/due.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import * as budget from '../stimd/passes/budget.ts';
import * as fsUtil from '../fs-util.ts';
import * as privateSize from '../private-size.ts';
import * as daemonPasses from '../daemon/passes.ts';
import * as stages from '../daemon/stages.ts';
import { runMaintenanceAtLevel } from '../stimd/passes/level-run.ts';
import { runMaintenance } from '../stimd/passes/run.ts';
import * as measurements from '../stimd/passes/measure.ts';
import { maintenanceStatus } from '../stimd/passes/status.ts';
import * as marks from '../daemon/marks.ts';
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

test('a pass that measured no Cargo target plans no trim from its saved over-cap size', async () => {
  vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '1');
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
  const now = Date.now();
  const state: MaintenanceState = {
    version: 1,
    lastAt: { pressure: now, size: now, sweep: now, idle: now },
    capAt: now,
    pressure: null,
    sizes: [
      {
        name: 'Cargo target',
        category: 'other',
        dir: target,
        workspace: dirname(target),
        bytes: 2 * 1024 ** 3,
        measuredAt: now,
      },
    ],
    lastPass: null,
    recent: [],
    plan: [],
  };
  mkdirSync(dirname(maintenanceStateFile()), { recursive: true });
  writeFileSync(maintenanceStateFile(), JSON.stringify(state));

  await runMaintenance('test');

  expect(measurements.measureSizes).not.toHaveBeenCalled();
  expect(readMaintenanceState()?.lastAt.worktree).toBe(now);
  expect(readMaintenanceState()?.plan.filter((action) => action.target === target)).toEqual([]);
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
  const walk = privateSize.measureTree;
  vi.spyOn(privateSize, 'measureTree').mockImplementation(async (dir, options) => {
    order.push(dir.endsWith('target') ? 'walk' : 'other');
    return walk(dir, options);
  });

  await runMaintenance('test', { between: async () => void order.push('boundary') });

  const walks = order.flatMap((entry, at) => (entry === 'walk' ? [order[at - 1]] : []));
  expect(walks).toEqual(['boundary', 'boundary']);
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

test('the automatic Cargo cap keeps normal rules while its disk is critical', async () => {
  vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '100');
  rmSync(gcMarkFile(dirname(target)));
  vi.spyOn(budget, 'readVolumeSpaceAsync').mockResolvedValue([{ volume: '/', freeMb: 0 }]);
  await runMaintenance('test');
  expect(readMaintenanceState()?.plan.filter((action) => action.target === target)).toEqual([]);
  expect(existsSync(join(target, 'debug', 'incremental', 'data'))).toBe(true);
});

test('acting forced critical leaves an unmarked under-cap running target whole', async () => {
  vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '100');
  const root = dirname(target);
  rmSync(gcMarkFile(root));
  upsertProject(root, { supervisor: { pid: process.pid, port: 59998 } });
  const run = await runMaintenanceAtLevel({ level: 'critical', act: true });
  expect(existsSync(join(target, 'debug', 'incremental', 'data'))).toBe(true);
  expect(run.actions.filter((action) => action.kind === 'trim-cargo' && action.outcome === 'done')).toEqual([]);
});

test('saved Cargo order keeps individual refusals last, unknowns stable and action proof intact', async () => {
  const original = dirname(target);
  const roots = [original];
  for (const name of ['small', 'zero', 'unknown-one', 'unknown-two']) {
    const root = join(base, name);
    cpSync(original, root, { recursive: true });
    upsertProject(root, { metroPort: null });
    roots.push(root);
  }
  const config = loadConfig();
  if (!config) throw new Error('missing fixture config');
  for (const root of roots) await markWriter(config)({ path: root, at: Date.now(), lastActivityAt: null, kept: null });
  const plan = () =>
    planCargoTargetsAtPressure({
      settings: resolveMaintenanceSettings(),
      pinned: () => false,
      now: Date.now(),
      level: 'high',
    });
  const unknownOrder = (await plan()).actions
    .map((action) => action.target)
    .filter((path) => roots.slice(3).some((root) => path === join(root, 'target')));
  for (const [index, bytes] of [20 * 1024 ** 3, 1024 ** 3, 0].entries()) {
    const root = roots[index];
    if (!root) throw new Error('missing Cargo root');
    writeCacheFile(diskUsageCacheFile(join(root, 'target')), {
      path: join(root, 'target'),
      bytes,
      measuredAt: new Date().toISOString(),
    });
  }
  const mark = readGcMark(original);
  const candidate = mark?.candidates.find((entry) => entry.path === target);
  if (!mark || !candidate) throw new Error('missing Cargo candidate');
  marks.keepMarkCandidate(mark, candidate, 'a Cargo build held the target');
  const before = roots.map((root) => readGcMark(root));
  const walk = vi.spyOn(fsUtil, 'measuredDirectorySizeAsync');
  const ordered = await plan();
  expect(ordered.actions.map((action) => action.target)).toEqual([
    join(base, 'small', 'target'),
    join(base, 'zero', 'target'),
    ...unknownOrder,
    target,
  ]);
  expect(roots.map((root) => readGcMark(root))).toEqual(before);
  expect(walk).not.toHaveBeenCalled();
  const first = ordered.actions[0];
  if (!first?.workspace) throw new Error('missing first Cargo action');
  expect(await trimCargoTargetAction(first, undefined, false, undefined, first.workspace)).toMatchObject({
    status: 'kept',
    detail: 'the command that started this pass runs in it',
  });
  await markWriter(config)({ path: original, at: Date.parse(mark.markedAt) + 1, lastActivityAt: null, kept: null });
  expect((await plan()).actions[0]?.target).toBe(target);
  expect(readGcMark(original)?.candidates.find((entry) => entry.path === target)?.keep).toBeUndefined();
});

test('only acting evaluated Cargo refusals write a keep hint; healthy pressure does not', async () => {
  const root = dirname(target);
  const sibling = join(ensureWorkspaceStorage(root), 'derived-data');
  mkdirSync(sibling, { recursive: true });
  const config = loadConfig();
  if (!config) throw new Error('missing fixture config');
  await markWriter(config)({ path: root, at: Date.now(), lastActivityAt: null, kept: null });
  const before = readGcMark(root);
  if (!before) throw new Error('missing Cargo mark');
  const dirtyAt = new Date(Date.parse(before.markedAt) + 1000).toISOString();
  writeCacheFile(gcMarkFile(root), { ...before, dirtyAt });
  before.dirtyAt = dirtyAt;
  const plan = (recordKeeps: boolean, healthy = false) =>
    planCargoTargetsAtPressure({
      settings: resolveMaintenanceSettings(),
      pinned: () => true,
      now: Date.now(),
      recordKeeps,
      diskLevel: async () => (healthy ? 'normal' : 'high'),
    });
  expect((await plan(false)).skips).toContainEqual(
    expect.objectContaining({ target, reason: 'pinned by maintenance.keep' }),
  );
  expect(readGcMark(root)).toEqual(before);
  await plan(true, true);
  expect(readGcMark(root)).toEqual(before);
  await plan(true);
  const kept = readGcMark(root);
  expect(kept?.candidates.find((candidate) => candidate.path === target)?.keep?.reason).toBe(
    'pinned by maintenance.keep',
  );
  expect(kept?.markedAt).toBe(before.markedAt);
  expect(kept?.dirtyAt).toBe(dirtyAt);
  expect(kept?.candidates.find((candidate) => candidate.path === sibling)).toEqual(
    before.candidates.find((candidate) => candidate.path === sibling),
  );
});

test('per-path output reports keep the checkout grouping when the target is outside it', async () => {
  const root = dirname(target);
  const output = join(base, 'home', 'workspaces', 'app', 'derived-data');
  vi.spyOn(discovery, 'discoverCheckouts').mockResolvedValue([{ path: root, origin: 'root', from: base }]);
  vi.spyOn(discovery, 'discoveredOutside').mockResolvedValue([]);
  vi.spyOn(daemonPasses, 'runDormantReduction').mockResolvedValue([]);
  vi.spyOn(daemonPasses, 'runForcedLadder').mockResolvedValue({
    pressure: { level: 'normal', disk: 'normal', memory: 'normal', reasons: [], memoryWarningSince: null },
    running: [],
    levels: [
      {
        level: 'high',
        actions: [
          {
            rung: 1,
            kind: 'delete-build-outputs',
            target: output,
            workspace: root,
            outcome: 'would',
            bytes: 0,
            detail: 'saved output',
          },
        ],
      },
    ],
  });
  const run = await runMaintenanceAtLevel({ level: 'high', act: false });
  expect(run.discovered.find((entry) => entry.path === root)?.actions).toContainEqual(
    expect.objectContaining({ kind: 'delete-build-outputs', target: output, workspace: root }),
  );
});

test('Cargo planning authorizes one batch and execution reads only its selected mark', async () => {
  const first = dirname(target);
  const other = join(base, 'other-cargo');
  cpSync(first, other, { recursive: true });
  upsertProject(other, { metroPort: null });
  const config = loadConfig();
  if (!config) throw new Error('missing fixture config');
  await markWriter(config)({ path: other, at: Date.now(), lastActivityAt: null, kept: null });
  const batch = vi.spyOn(marks, 'outputMarks');
  const selected = vi.spyOn(marks, 'outputMark');
  const plan = await planCargoTargetsAtPressure({
    settings: resolveMaintenanceSettings(),
    pinned: () => false,
    now: Date.now(),
    level: 'critical',
  });
  expect(plan.actions).toHaveLength(2);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(selected).not.toHaveBeenCalled();
  const action = plan.actions[0];
  if (!action) throw new Error('missing pressure action');
  await trimCargoTargetAction(action);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenCalledExactlyOnceWith(config, dirname(action.target), undefined);
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
    const observed = vi.fn<(device: number, at: number) => void>();
    const firstFree = { pending: () => true, observed };

    samples.mockResolvedValueOnce(volume(1000)).mockResolvedValueOnce([]);
    const missing = await trimCargoTargetAction(action, undefined, false, undefined, '', firstFree);
    expect(missing).toMatchObject({ status: 'done', bytes: 0 });
    expect(observed).not.toHaveBeenCalled();

    mkdirSync(join(target, 'debug', 'incremental'), { recursive: true });
    writeFileSync(join(target, 'debug', 'incremental', 'data'), 'x');
    samples.mockResolvedValueOnce(volume(1000)).mockResolvedValueOnce(volume(1005));
    const measured = await trimCargoTargetAction(action, undefined, false, undefined, '', firstFree);
    expect(measured).toMatchObject({ status: 'done', bytes: 5 * 1024 * 1024 });
    expect(observed).toHaveBeenCalledExactlyOnceWith(1, Date.now());
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

test.each(['measured healthy', 'new pressure pin', 'healthy renewed pin', 'forced healthy', 'new cap pin'] as const)(
  'manual Cargo admission rechecks the completed handoff: %s',
  async (change) => {
    vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', change === 'new cap pin' ? '0.000001' : '1');
    vi.spyOn(daemonPasses, 'runDormantReduction').mockResolvedValue([]);
    vi.spyOn(daemonPasses, 'runForcedLadder').mockResolvedValue(null);
    vi.spyOn(daemonMeasure, 'measureMemory').mockResolvedValue({
      level: 'normal',
      availableBytes: null,
      totalBytes: 0,
    });
    const device = statSync(target).dev;
    let freeMb = change === 'new cap pin' ? 100 * 1024 : 10 * 1024;
    vi.spyOn(budget, 'readVolumeSpaceAsync').mockImplementation(async (paths) =>
      paths.length === 1 && paths[0] === target
        ? [{ volume: target, freeMb, device }]
        : [
            { volume: target, freeMb, device },
            { volume: '/other-short-volume', freeMb: 1024, device: device + 1 },
          ],
    );
    const beforeMark = readGcMark(dirname(target));
    expect(beforeMark?.candidates).toContainEqual(expect.objectContaining({ kind: 'cargo-target', path: target }));
    let handoffs = 0;
    const run = await runMaintenanceAtLevel({
      act: true,
      ...(change === 'forced healthy'
        ? { level: 'critical' as const }
        : change === 'new cap pin'
          ? { level: 'normal' as const }
          : {}),
      between: async () => {
        handoffs++;
        if (change === 'new pressure pin' || change === 'new cap pin' || change === 'healthy renewed pin')
          writeFileSync(join(dirname(target), '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
        if (change !== 'new pressure pin' && change !== 'new cap pin') freeMb = 100 * 1024;
      },
    });
    expect(handoffs).toBeGreaterThan(0);
    expect(existsSync(join(target, 'debug', 'incremental', 'data'))).toBe(change !== 'forced healthy');
    expect(run.actions.some((action) => action.kind === 'trim-cargo' && action.outcome === 'done')).toBe(
      change === 'forced healthy',
    );
    const at = expect.any(String);
    const expected =
      change === 'new pressure pin'
        ? {
            ...beforeMark,
            candidates: beforeMark?.candidates.map((candidate) =>
              candidate.kind === 'cargo-target' && candidate.path === target
                ? { ...candidate, keep: { reason: 'pinned by maintenance.keep', at } }
                : candidate,
            ),
          }
        : beforeMark;
    expect(readGcMark(dirname(target))).toEqual(expected);
  },
);

test.each(['predictive', 'measured high'] as const)(
  'a predictive empty device does not suppress Cargo on another device: %s',
  async (kind) => {
    const device = statSync(target).dev;
    let freeMb = 100 * 1024;
    vi.spyOn(daemonMeasure, 'measureDisk').mockImplementation(async () => [
      { volume: '/cargo', device, freeMb },
      { volume: '/other', device: device + 1, freeMb: 100 * 1024 },
    ]);
    vi.spyOn(daemonMeasure, 'measureMemory').mockResolvedValue({
      level: 'normal',
      availableBytes: null,
      totalBytes: 0,
    });
    vi.spyOn(budget, 'readVolumeSpaceAsync').mockImplementation(async () => [{ volume: '/cargo', device, freeMb }]);
    const pressure: DaemonPressure = {
      level: 'normal',
      disk: 'normal',
      memory: 'normal',
      reasons: [],
      memoryWarningSince: null,
    };
    const clocks = new BigInt64Array(Object.keys(LADDER_CLOCK_SLOTS).length);
    const input = { act: true, pressure, devices: [], sims: [], requested: false };
    await daemonPasses.runDiskPass(
      { ...input, target: { device: device + 1, freeMb: 120 * 1024, observedAt: Date.now() } },
      () => {},
      testContext(),
      clocks,
    );
    if (kind === 'measured high') freeMb = 30 * 1024;
    await daemonPasses.runDiskPass(
      {
        ...input,
        ...(kind === 'predictive'
          ? { target: { device, freeMb: 120 * 1024, observedAt: Date.now() } }
          : { pressure: { ...pressure, level: 'high', disk: 'high' } }),
      },
      () => {},
      testContext(),
      clocks,
    );
    expect(existsSync(join(target, 'debug', 'incremental'))).toBe(false);
  },
);
