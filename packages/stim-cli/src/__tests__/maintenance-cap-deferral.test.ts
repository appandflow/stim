import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceStateFile, readMaintenanceState } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
