import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatedLogPath } from '@stim-cli/core';
import {
  maintenanceRunClaims,
  maintenanceDir,
  maintenanceStateFile,
  maintenanceNdjsonFile,
  parseMaintenanceState,
  workspaceLogsDir,
  type MaintenanceState,
  type MaintenanceSize,
} from '@stim-cli/core/state';
import { plan } from '../maintenance/plan.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { maintenanceLogger } from '../maintenance/log.ts';
import { maintenanceStatus, maintenanceLine } from '../maintenance/status.ts';
import { tryAcquireClaim, releaseClaim } from '../ownership-claim.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-maintenance-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  vi.restoreAllMocks();
});

const settings = resolveMaintenanceSettings(null, { STIM_DAEMON: 'report' })!;
const emptyState = (): MaintenanceState => ({
  version: 1,
  lastAt: {},
  pressure: null,
  sizes: [],
  lastPass: null,
  recent: [],
  plan: [],
});
const size = (
  category: MaintenanceSize['category'],
  bytes: number,
  extra: Partial<MaintenanceSize> = {},
): MaintenanceSize => ({
  name: category,
  category,
  bytes,
  dir: `/${category}`,
  measuredAt: 1,
  ...extra,
});

describe('the Swift compilation cache cap', () => {
  const planFor = (bytes: number, capGb: number, extra: Partial<MaintenanceSize> = {}) =>
    plan({
      sizes: [size('compilation-cache', bytes, extra)],
      settings: { ...settings, swiftCompilationCacheMaxGb: capGb },
      protectedRoot: '/self',
    });

  test('is emptied whole above the cap with plenty of free disk', () => {
    expect(planFor(16 * 1024 ** 3, 15).actions).toEqual([
      expect.objectContaining({ kind: 'would-empty-cache', dir: '/compilation-cache', bytes: 16 * 1024 ** 3 }),
    ]);
  });

  test('is kept, with the build named, while a build may be using it', () => {
    const result = planFor(16 * 1024 ** 3, 15, { blocked: 'the ios build (pid 42 in /w/app) may be using it' });
    expect(result.actions).toEqual([]);
    expect(result.skips).toContainEqual({
      target: '/compilation-cache',
      reason: 'the ios build (pid 42 in /w/app) may be using it',
    });
    expect(result.blocked).toEqual([expect.stringContaining('compilation-cache 16.0G over the 15G cap')]);
  });

  test('is kept at or under the cap', () => {
    expect(planFor(15 * 1024 ** 3, 15).actions).toEqual([]);
    expect(planFor(1024 ** 3, 15).actions).toEqual([]);
  });

  test('is kept when the cap is 0', () => {
    const result = planFor(40 * 1024 ** 3, 0);
    expect(result.actions).toEqual([]);
    expect(result.skips).toEqual([]);
  });
});

test('caps aggregate Metro stores and target 80 percent while retaining busy outputs', () => {
  const result = plan({
    sizes: [
      size('build-cache', 12 * 1024 ** 3),
      size('metro-cache', 3 * 1024 ** 3, { dir: '/metro/a' }),
      size('metro-cache', 3 * 1024 ** 3, { dir: '/metro/b' }),
      size('compilation-cache', 16 * 1024 ** 3),
      size('workspace-outputs', 25 * 1024 ** 3, {
        workspace: '/busy',
        blocked: 'in use: native run claim',
      }),
    ],
    settings: { ...settings, swiftCompilationCacheMaxGb: 15 },
    protectedRoot: '/self',
  });
  expect(result.actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'would-trim-cache',
        target: '/build-cache',
        bytes: 4 * 1024 ** 3,
      }),
      expect.objectContaining({
        kind: 'would-trim-cache',
        target: '/metro/a',
        bytes: 2 * 1024 ** 3,
      }),
    ]),
  );
  expect(result.actions).toContainEqual(
    expect.objectContaining({ kind: 'would-empty-cache', target: '/compilation-cache', bytes: 16 * 1024 ** 3 }),
  );
  expect(result.actions.some((action) => action.workspace === '/busy')).toBe(false);
  expect(result.skips).toContainEqual({
    target: '/workspace-outputs',
    workspace: '/busy',
    reason: 'in use: native run claim',
  });
  expect(result.blocked).toContainEqual(expect.stringContaining('eligible targets cannot reach'));
});

test('maintenance records stay parseable, mirror named workspace actions and rotate with retention', () => {
  const file = maintenanceNdjsonFile();
  mkdirSync(maintenanceDir());
  writeFileSync(rotatedLogPath(file), 'expired\n');
  const past = new Date(Date.now() - 31 * 86_400_000);
  utimesSync(rotatedLogPath(file), past, past);
  const logger = maintenanceLogger({ ...settings, logChecks: true }, 'pass-1', 'status');
  const workspace = join(home, 'app');
  ensureWorkspaceStorage(workspace);
  const events = [
    'maintenance_action',
    'maintenance_skip',
    'maintenance_failure',
    'maintenance_check',
    'maintenance_pass',
  ] as const;
  for (const event of events)
    logger.write(
      event,
      event === 'maintenance_failure' ? 'error' : event === 'maintenance_check' ? 'debug' : 'info',
      event,
      { workspace, target: workspace },
    );
  logger.close();
  expect(() => readFileSync(rotatedLogPath(file))).toThrow(/ENOENT/);
  const records = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.map((record) => record.event)).toEqual(events);
  for (const record of records)
    expect(record).toMatchObject({
      ts: expect.any(Number),
      src: 'maintenance',
      pass: 'pass-1',
      trigger: 'status',
      mode: 'report',
      msg: record.event,
    });
  expect(
    readFileSync(join(workspaceLogsDir(workspace), 'maintenance.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event),
  ).toEqual(events.slice(0, 3));
  const rotate = maintenanceLogger({ ...settings, logMaxMb: 0.0001 }, 'pass-2', 'gc');
  rotate.write('maintenance_pass', 'info', 'next pass');
  rotate.close();
  expect(readFileSync(rotatedLogPath(file), 'utf8')).toContain('pass-1');
  const silent = maintenanceLogger(settings, 'pass-3', 'status');
  expect(silent.write('maintenance_check', 'debug', 'routine')).toBeNull();
  silent.close();
});

test('maintenance records about a removed workspace do not recreate its directory', () => {
  const logger = maintenanceLogger(settings, 'pass-1', 'status');
  const removed = join(home, 'removed');
  const record = logger.write('maintenance_skip', 'info', 'Kept it', { workspace: removed, target: removed });
  logger.close();
  expect(record?.event).toBe('maintenance_skip');
  expect(readFileSync(maintenanceNdjsonFile(), 'utf8')).toContain('Kept it');
  expect(existsSync(workspaceDir(removed))).toBe(false);
});

test('status does not infer a live pass from a check stamp', () => {
  mkdirSync(maintenanceDir());
  writeFileSync(maintenanceStateFile(), JSON.stringify({ ...emptyState(), lastAt: { pressure: Date.now() } }));
  expect(maintenanceStatus().running).toBeNull();
  expect(maintenanceLine(maintenanceStatus())).toBeNull();
  const attempt = tryAcquireClaim({
    root: maintenanceRunClaims(),
    mode: 'exclusive',
    label: 'maintenance',
    details: { trigger: 'status' },
  });
  expect(attempt.acquired).toBeDefined();
  try {
    expect(maintenanceStatus().running).toEqual({
      startedAt: attempt.acquired!.startedAt,
      trigger: 'status',
    });
  } finally {
    releaseClaim(attempt.acquired!);
  }
  expect(parseMaintenanceState({ ...emptyState(), lastPass: { stopped: 1 } })).toBeNull();
});
