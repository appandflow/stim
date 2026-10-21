import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maintenanceNdjsonFile,
  readDeviceIdleShutdowns,
  type MaintenanceRecord,
  type MaintenanceSize,
} from '@stim-cli/core/state';
import * as gcDevices from '../commands/gc/devices.ts';
import { collectFinishedDevices, deleteFinishedDevices } from '../commands/gc/finished-devices.ts';
import type { WorktreeSkipCode, WorktreeSweep } from '../commands/gc/worktrees.ts';
import * as gcIdle from '../commands/gc/idle.ts';
import * as ios from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import * as measurements from '../maintenance/measure.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { ownedDeviceUsage, planDeviceDeletion } from '../maintenance/devices.ts';
import { planPressureLevels } from '../maintenance/levels.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { maintenanceLine } from '../maintenance/status.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { takeLease } from '../engine/device-lease.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';

const MINUTE_MS = 60_000;

let home: string;
let projects: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-devices-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-devices-projects-')));
  process.env.STIM_HOME = home;
  vi.stubEnv('HOME', home);
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: () => '',
    runFileQuiet: () => null,
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  vi.spyOn(ios, 'listAllIosSims').mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = 0;
});

function workspaceWithSim(name: string, usedMinutesAgo: number, udid = `UDID-${name}`) {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: 8100, platforms: { ios: { deviceUdid: udid, owned: true } } });
  recordWorkspaceUse(root, new Date(Date.now() - usedMinutesAgo * MINUTE_MS));
  return root;
}

const deviceSize = (workspace: string, bytes: number): MaintenanceSize => ({
  name: 'owned simulator',
  category: 'owned-devices',
  dir: `${workspace}/sim`,
  bytes,
  measuredAt: 0,
  workspace,
});

function plan(
  roots: string[],
  {
    protectedRoot = '',
    pinned = (_root: string): boolean => false,
  }: { protectedRoot?: string; pinned?: (root: string) => boolean } = {},
) {
  return planDeviceDeletion({
    roots: roots.map((root) => ({ root })),
    windowMs: 10 * MINUTE_MS,
    reason: 'disk pressure level 2',
    protectedRoot,
    pinned,
    sizes: roots.map((root) => deviceSize(root, 1024)),
    now: Date.now(),
    extra: { level: 2 },
  });
}

test('owned devices of a workspace idle past the window are planned for deletion, with their measured disk', () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const idle = workspaceWithSim('idle', 30);
  const recent = workspaceWithSim('recent', 2);
  const pinned = workspaceWithSim('pinned', 30);
  const self = workspaceWithSim('self', 30);
  const bare = join(projects, 'no-devices');
  mkdirSync(bare);
  upsertProject(bare, { metroPort: 8101 });

  const result = plan([idle, recent, pinned, self, bare], {
    protectedRoot: self,
    pinned: (root) => root === pinned,
  });

  expect(result.actions).toEqual([
    expect.objectContaining({ kind: 'would-delete-devices', target: idle, workspace: idle, bytes: 1024, level: 2 }),
  ]);
  expect(result.skips).toEqual([
    expect.objectContaining({ target: recent, reason: 'used within the last 10 minutes' }),
    expect.objectContaining({ target: pinned, reason: 'pinned by maintenance.keep' }),
  ]);
});

test('a scoped Stim home plans no device deletion, because devices are machine-wide', () => {
  const idle = workspaceWithSim('idle', 30);
  expect(plan([idle])).toEqual({ actions: [], blocked: [], skips: [] });
});

test('a workspace with no recorded use is judged by when its workspace was created', () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const root = join(projects, 'never-used');
  mkdirSync(root);
  const dir = ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-never', owned: true } } });

  expect(plan([root]).skips).toEqual([
    expect.objectContaining({ target: root, reason: 'used within the last 10 minutes' }),
  ]);
  const created = new Date(Date.now() - 30 * MINUTE_MS);
  utimesSync(join(dir, 'workspace.json'), created, created);
  expect(plan([root]).actions).toEqual([expect.objectContaining({ kind: 'would-delete-devices', target: root })]);
});

function sweepOf(worktrees: Partial<WorktreeSweep['worktrees'][number]>[]): WorktreeSweep {
  return {
    idle: null,
    graceMs: 0,
    now: Date.now(),
    noOwnCommitsIdleMs: null,
    worktrees: worktrees.map((worktree) => ({
      activity: null,
      path: '',
      keys: [],
      idleDays: null,
      merge: null,
      head: null,
      pullRequest: null,
      skipCode: null,
      skipped: null,
      eligibleAt: null,
      ...worktree,
    })),
  };
}

const ended = (state: 'merged' | 'closed' | 'open', endedAt: number) => ({
  pullRequest: {
    pullRequest: { number: 7, state, draft: false, url: '', head: 'abc', containsHead: true, endedAt },
  },
});

test('gc lists the owned devices of a finished worktree it keeps once its grace has passed, and no other', () => {
  const names = ['dirty', 'clean', 'open', 'source', 'locked', 'recent', 'fresh'];
  const roots = new Map(names.map((name) => [name, workspaceWithSim(name, 300, `UDID-${name}`)]));
  const root = (name: string) => roots.get(name) ?? '';
  const sims = names.map((name): ios.IosSimRecord => ({
    udid: `UDID-${name}`,
    name: `stim-${name} (iPhone 17 26.5)`,
    state: 'Shutdown',
    runtime: 'iOS-26-5',
    deviceTypeIdentifier: 'iPhone-17',
    available: true,
    dataPathSize: 2048,
  }));
  const now = Date.now();
  const worktree = (
    name: string,
    skipCode: WorktreeSkipCode | null,
    state: 'merged' | 'closed' | 'open',
    at: number,
  ) => ({
    path: root(name),
    keys: [root(name)],
    skipCode,
    skipped: skipCode,
    ...ended(state, at),
  });
  const sweep = {
    ...sweepOf([
      worktree('dirty', 'dirty', 'closed', now - 180 * MINUTE_MS),
      worktree('clean', null, 'merged', 0),
      worktree('open', 'dirty', 'open', 0),
      worktree('source', 'source-checkout', 'merged', 0),
      worktree('locked', 'locked', 'merged', 0),
      worktree('recent', 'recent-activity', 'merged', 0),
      worktree('fresh', 'dirty', 'merged', now - MINUTE_MS),
    ]),
    graceMs: 120 * MINUTE_MS,
  };

  expect(collectFinishedDevices({ config: loadConfig(), sims, avds: [], sweep, now })).toEqual([
    {
      kind: 'ios',
      id: 'UDID-dirty',
      name: 'stim-dirty (iPhone 17 26.5)',
      project: root('dirty'),
      bytes: 2048,
      reason: 'its worktree is finished (PR #7 closed) but kept',
    },
  ]);
});

test('an Android-only workspace is judged without listing simulators', () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  vi.mocked(ios.listAllIosSims).mockImplementation(() => {
    throw new Error('xcrun: not found');
  });
  const root = join(projects, 'android-only');
  mkdirSync(root);
  ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: 8100, platforms: { android: { avdName: 'stim-android-only', owned: true } } });
  recordWorkspaceUse(root, new Date(Date.now() - 30 * MINUTE_MS));

  expect(plan([root]).actions).toEqual([expect.objectContaining({ kind: 'would-delete-devices', target: root })]);
});

test('a workspace holding a device lease or its native-run lock keeps its devices', () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const leased = workspaceWithSim('leased', 30);
  const running = workspaceWithSim('running', 30);
  expect(takeLease({ root: leased, platform: 'ios', id: 'PHONE-1', kind: 'declared' }).status).toBe('taken');
  plantClaim(join(workspaceDir(running), 'native-run.lock'), 'exclusive', liveClaimOwner());

  const result = plan([leased, running]);

  expect(result.actions).toEqual([]);
  expect(result.skips).toEqual([
    expect.objectContaining({ target: leased, reason: expect.stringContaining('device lease') }),
    expect.objectContaining({ target: running, reason: expect.stringContaining('in use') }),
  ]);
});

test('gc --delete keeps the devices of a finished worktree that is pinned by maintenance.keep', async () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const root = workspaceWithSim('dirty', 90);
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  takeGcResults();

  const failures = await deleteFinishedDevices({
    finishedDevices: [{ kind: 'ios', id: 'UDID-dirty', name: 'stim-dirty', project: root, reason: 'finished' }],
    worktreeSweep: sweepOf([]),
  });

  expect(failures).toBe(0);
  expect(takeGcResults()).toEqual([
    expect.objectContaining({ status: 'kept', label: root, detail: 'pinned by maintenance.keep' }),
  ]);
  expect(loadConfig()?.projects[root]?.platforms?.ios?.deviceUdid).toBe('UDID-dirty');
});

test('owned device disk counts listed owned devices and skips devices no longer listed', async () => {
  const owned = workspaceWithSim('owned', 90, 'UDID-owned');
  upsertProject(owned, {
    platforms: { ios: { deviceUdid: 'UDID-owned', owned: true }, android: { avdName: 'stim-owned', owned: true } },
  });
  workspaceWithSim('gone', 90, 'UDID-gone');
  const failures: string[] = [];

  const usage = await ownedDeviceUsage((target) => failures.push(target), {
    sims: () => [
      {
        udid: 'UDID-owned',
        name: 'stim-owned',
        state: 'Shutdown',
        runtime: 'iOS-26-5',
        deviceTypeIdentifier: 'iPhone-17',
        available: true,
        dataPath: '/sims/owned',
        dataPathSize: 5,
      },
    ],
    avds: () => ['stim-owned'],
    avdDirectory: (name) => `/avds/${name}.avd`,
    size: () => 7,
  });

  expect(usage).toEqual([
    { kind: 'ios', name: 'stim-owned', dir: '/sims/owned', bytes: 5, workspace: owned },
    { kind: 'android', name: 'stim-owned', dir: '/avds/stim-owned.avd', bytes: 7, workspace: owned },
  ]);
  expect(failures).toEqual([]);
});

test('the maintenance line reports owned device disk', () => {
  const line = maintenanceLine({
    mode: 'on',
    lastChecks: { pressure: null, size: null, worktree: null, sweep: null },
    pressure: null,
    sizes: [deviceSize('/a', 3 * 1024 ** 3), deviceSize('/b', 1024 ** 3)],
    lastPass: null,
    running: null,
    recent: [],
    plan: [],
  });
  expect(line).toContain('owned devices 4.0G');
});

test('at level 3 an idle workspace with no dev server loses its devices through level 2, not a level 3 stop', async () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const idle = workspaceWithSim('idle', 30);
  const settings = { ...resolveMaintenanceSettings(null, { STIM_MAINTENANCE: 'on' }), removeFinishedWorktrees: false };

  const result = await planPressureLevels(3, {
    settings,
    sizes: [],
    protectedRoot: '',
    pinned: () => false,
    now: Date.now(),
  });

  expect(result.actions.filter((action) => action.target === idle)).toEqual([
    expect.objectContaining({ kind: 'would-delete-devices', level: 2 }),
  ]);
});

test('a maintenance pass shuts down devices idle past devices.idleShutdownMinutes with no supervisor, and keeps the rest', async () => {
  process.env.STIM_MAINTENANCE = 'on';
  process.env.STIM_MAINTENANCE_SWEEP_HOURS = '0';
  process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES = 'false';
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: 500 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  const now = Date.now();
  const idle = (name: string, minutes: number): gcIdle.OwnedDeviceActivity => {
    const root = workspaceWithSim(name, minutes);
    return {
      kind: 'ios',
      id: `UDID-${name}`,
      name: `stim-${name}`,
      project: root,
      slot: 'default',
      activity: {
        state: 'idle',
        basis: ['workspace-use'],
        lastActivityAt: new Date(now - minutes * MINUTE_MS).toISOString(),
      },
    };
  };
  const quiet = idle('quiet', 45);
  const optedOut = idle('opted-out', 120);
  const locked = idle('locked', 120);
  const devices = [quiet, idle('recent', 10), optedOut, locked];
  writeFileSync(join(optedOut.project, '.stim.json'), JSON.stringify({ devices: { idleShutdownMinutes: 0 } }));
  plantClaim(join(workspaceDir(locked.project), 'native-run.lock'), 'exclusive', liveClaimOwner());
  vi.spyOn(gcIdle, 'collectOwnedDeviceActivity').mockImplementation((config) =>
    devices.filter((device) => Boolean(config?.projects[device.project])),
  );
  const shutDown = vi
    .spyOn(teardown, 'teardownOwnedIosSim')
    .mockImplementation(async (id) => ({ status: 'torn-down', label: id }));

  await runMaintenance('test');

  expect(shutDown.mock.calls.map(([id]) => id)).toEqual(['UDID-quiet']);
  expect(readDeviceIdleShutdowns(readWorkspaceState(quiet.project))).toEqual({
    ios: expect.objectContaining({ idleMinutes: 45 }),
  });
  expect(readFileSync(join(workspaceLogsDir(quiet.project), 'metro.ndjson'), 'utf8')).toContain('device_idle_shutdown');
  const records: MaintenanceRecord[] = readFileSync(maintenanceNdjsonFile(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.filter((record) => record.event === 'maintenance_action').map((record) => record.action)).toEqual([
    expect.objectContaining({ kind: 'shutdown-device', target: 'UDID-quiet' }),
  ]);
});
