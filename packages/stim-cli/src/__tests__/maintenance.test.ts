import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatedLogPath } from '@stim-cli/core';
import {
  maintenanceRunClaims,
  maintenanceDir,
  maintenanceStateFile,
  maintenanceNdjsonFile,
  parseMaintenanceState,
  settingDefinition,
  settingValueError,
  coerceSettingText,
  queryLogs,
  workspaceLogsDir,
  type MaintenanceState,
  type MaintenanceSize,
} from '@stim-cli/core/state';
import { due } from '../maintenance/due.ts';
import { plan } from '../maintenance/plan.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { maintenanceLogger } from '../maintenance/log.ts';
import { maintenanceStatus, maintenanceLine } from '../maintenance/status.ts';
import { tryAcquireClaim, releaseClaim } from '../ownership-claim.ts';

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

const settings = resolveMaintenanceSettings(null, {})!;
const budget = {
  minFreeDiskMb: 20 * 1024,
  hardFloorDiskMb: 5 * 1024,
  maxCommittedMemoryMb: 0,
  maxLiveWorkspaces: 0,
};
const emptyState = (): MaintenanceState => ({
  version: 1,
  lastAt: {},
  pressure: null,
  sizes: [],
  lastPass: null,
  recent: [],
  plan: [],
});
const pressure = (freeMb = 30 * 1024, pressured = false) => ({
  disk: [{ volume: '/', freeMb }],
  memory: { level: 'normal' as const, availableBytes: null, pressured },
  warningSince: null,
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

test('corrupt state schedules fresh checks instead of postponing them', () => {
  expect(due(parseMaintenanceState({ version: 2 }), settings, 0)).toEqual(['pressure', 'size']);
  expect(due(null, settings, 0)).toEqual(['pressure', 'size']);
});

test('each check becomes due at its own interval and a missing stamp does not postpone it', () => {
  const state = { ...emptyState(), lastAt: { pressure: 0, size: 0 } };
  expect(due(state, settings, 59_999)).toEqual([]);
  expect(due(state, settings, 60_000)).toEqual(['pressure']);
  expect(due(state, settings, 3_600_000)).toEqual(['pressure', 'size']);
  expect(due({ ...state, lastAt: { pressure: 60_000 } }, settings, 60_000)).toEqual(['size']);
});

test('a deferred size scan is not retried by every command while the host stays loaded', () => {
  const state = { ...emptyState(), lastAt: { pressure: 0, size: 0 }, deferredAt: { size: 3_600_000 } };
  expect(due(state, settings, 3_600_000 + 299_999)).toEqual(['pressure']);
  expect(due(state, settings, 3_600_000 + 300_000)).toEqual(['pressure', 'size']);
});

test('maintenance settings reject acting mode and invalid ranges before they can trigger work', () => {
  for (const [key, bad, good] of [
    ['maintenance.mode', 'on', 'report'],
    ['maintenance.pressureCheckMinutes', 0, 1],
    ['maintenance.sizeCheckMinutes', 1.5, 1],
    ['maintenance.maxLoadPerCore', 0, 0.01],
    ['maintenance.logMaxMb', -1, 0.1],
    ['maintenance.logRetentionDays', 0, 1],
    ['maintenance.memoryWarningMinutes', -1, 0],
    ['maintenance.minAvailableMemoryGb', -1, 0],
    ['maintenance.capTargetPercent', 101, 10],
    ['caches.buildCacheMaxGb', -1, 0],
    ['maintenance.logChecks', 'yes', false],
    ['maintenance.memoryPressureLevel', 'normal', 'off'],
  ] as const) {
    const definition = settingDefinition(key)!;
    expect(settingValueError(definition, bad)).not.toBeNull();
    expect(settingValueError(definition, good)).toBeNull();
  }
  expect(coerceSettingText(settingDefinition('maintenance.logChecks')!, '1')).toBe(true);
  expect(resolveMaintenanceSettings(null, { STIM_HOME: home })?.mode).toBe('off');
  expect(resolveMaintenanceSettings(null, { CI: '1' })?.mode).toBe('off');
  expect(
    resolveMaintenanceSettings(null, {
      STIM_HOME: home,
      CI: '1',
      STIM_MAINTENANCE: 'report',
      STIM_MAINTENANCE_SIZE_CHECK_MINUTES: '2',
    }),
  ).toMatchObject({ mode: 'report', sizeCheckMinutes: 2 });
  expect(resolveMaintenanceSettings(null, { STIM_MAINTENANCE: 'on' })).toBeNull();
});

test('disk shortfall maps existing dry-run targets while excluding the triggering workspace and scoped devices', () => {
  const input = {
    pressure: pressure(4 * 1024),
    sizes: [],
    settings,
    budget,
    protectedRoot: '/self',
    projects: ['/self', '/idle'],
    diskSteps: [
      {
        step: 'idle-devices' as const,
        targets: ['ios sim in /idle'],
        failures: 0,
      },
      {
        step: 'idle-dev-servers' as const,
        targets: ['/self', '/idle'],
        failures: 0,
      },
      { step: 'workspace-outputs' as const, targets: ['/idle'], failures: 0 },
      {
        step: 'stale-cache-entries' as const,
        targets: ['cache /cache'],
        failures: 0,
      },
    ],
  };
  expect(plan(input).actions.map((action) => action.kind)).toEqual([
    'would-shutdown-device',
    'would-stop-workspace',
    'would-clear-outputs',
    'would-trim-cache',
  ]);
  expect(plan({ ...input, scoped: true }).actions.map((action) => action.kind)).not.toContain('would-shutdown-device');
  expect(
    plan(input).actions.every((action) => action.workspace !== '/self' && action.reason.includes('20.0G floor')),
  ).toBe(true);
  expect(plan({ ...input, diskSteps: [] }).blocked).toEqual([expect.stringContaining('no reclaimable disk targets')]);
});

test('caps aggregate Metro stores, target 80 percent and empty Swift CAS whole while retaining busy outputs', () => {
  const result = plan({
    pressure: pressure(),
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
    settings,
    budget,
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
      expect.objectContaining({
        kind: 'would-empty-cache',
        bytes: 16 * 1024 ** 3,
      }),
    ]),
  );
  expect(result.actions.some((action) => action.workspace === '/busy')).toBe(false);
  expect(result.skips).toContainEqual({
    target: '/workspace-outputs',
    workspace: '/busy',
    reason: 'in use: native run claim',
  });
  expect(result.blocked).toContainEqual(expect.stringContaining('eligible targets cannot reach'));
});

test('healthy resources plan nothing; memory pressure records a skip without a stop plan', () => {
  const input = {
    pressure: pressure(),
    sizes: [],
    settings,
    budget,
    protectedRoot: '/self',
  };
  expect(plan(input)).toEqual({ actions: [], blocked: [], skips: [] });
  expect(plan({ ...input, pressure: pressure(30 * 1024, true) })).toEqual({
    actions: [],
    blocked: [],
    skips: [expect.objectContaining({ target: 'memory' })],
  });
  expect(
    plan({
      ...input,
      sizes: [size('build-cache', 99 * 1024 ** 3)],
      settings: { ...settings, buildCacheMaxGb: 0 },
    }).actions,
  ).toEqual([]);
});

test('maintenance records stay parseable, mirror named workspace actions and rotate with retention', () => {
  const file = maintenanceNdjsonFile();
  mkdirSync(maintenanceDir());
  writeFileSync(rotatedLogPath(file), 'expired\n');
  const past = new Date(Date.now() - 31 * 86_400_000);
  utimesSync(rotatedLogPath(file), past, past);
  const logger = maintenanceLogger({ ...settings, logChecks: true }, 'pass-1', 'status');
  const workspace = join(home, 'app');
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

test('maintenance failures remain visible with errors filtering, even before an unrelated launch marker', () => {
  const records = [
    {
      ts: 1,
      src: 'maintenance',
      level: 'error',
      msg: 'failed',
      event: 'maintenance_failure',
    },
    {
      ts: 2,
      src: 'maintenance',
      level: 'error',
      msg: 'not a failure',
      event: 'maintenance_check',
    },
    {
      ts: 3,
      src: 'maintenance',
      level: 'info',
      msg: 'would clear',
      event: 'maintenance_action',
    },
    { ts: 4, src: 'device', level: 'info', marker: true },
    { ts: 5, src: 'metro', level: 'error', msg: 'bundle error' },
  ];
  expect(queryLogs({ records, sources: ['maintenance'] }).map((record) => record.msg)).toEqual([
    'failed',
    'not a failure',
    'would clear',
  ]);
  expect(queryLogs({ records, errorsOnly: true }).map((record) => record.msg)).toEqual(['failed', 'bundle error']);
  expect(queryLogs({ records, errorsOnly: true, sources: ['maintenance'] }).map((record) => record.msg)).toEqual([
    'failed',
  ]);
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
