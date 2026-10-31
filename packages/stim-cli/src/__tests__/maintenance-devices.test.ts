import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { planDeviceDeletion } from '../maintenance/devices.ts';

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

function idlePass(mode: 'on' | 'report') {
  vi.stubEnv('STIM_MAINTENANCE', mode);
  vi.stubEnv('STIM_MAINTENANCE_SWEEP_HOURS', '0');
  vi.stubEnv('STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES', 'false');
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: 500 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
}

function idleDevice(name: string, minutes: number): gcIdle.OwnedDeviceActivity {
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
      lastActivityAt: new Date(Date.now() - minutes * MINUTE_MS).toISOString(),
    },
  };
}

test('a maintenance pass shuts down devices idle past their workspace devices.idleShutdownMinutes, and keeps the rest', async () => {
  idlePass('on');
  const quiet = idleDevice('quiet', 45);
  const optedOut = idleDevice('opted-out', 120);
  const longer = idleDevice('longer', 45);
  const locked = idleDevice('locked', 120);
  const current = idleDevice('current', 120);
  const devices = [
    quiet,
    idleDevice('recent', 10),
    optedOut,
    longer,
    locked,
    current,
    idleDevice('broken', 45),
    idleDevice('moved', 45),
  ];
  writeFileSync(join(optedOut.project, '.stim.json'), JSON.stringify({ devices: { idleShutdownMinutes: 0 } }));
  writeFileSync(join(longer.project, '.stim.json'), JSON.stringify({ devices: { idleShutdownMinutes: 60 } }));
  writeFileSync(join(current.project, 'package.json'), '{}');
  vi.spyOn(process, 'cwd').mockReturnValue(current.project);
  plantClaim(join(workspaceDir(locked.project), 'native-run.lock'), 'exclusive', liveClaimOwner());
  vi.spyOn(gcIdle, 'collectOwnedDeviceActivity').mockImplementation((config) =>
    devices.filter((device) => Boolean(config?.projects[device.project])),
  );
  const shutDown = vi
    .spyOn(teardown, 'teardownOwnedIosSim')
    .mockImplementation(async (id) =>
      id === 'UDID-broken'
        ? { status: 'failed', reason: 'simctl shutdown failed' }
        : id === 'UDID-moved'
          ? { status: 'skipped', kind: 'not-owned', reason: 'no longer owned' }
          : { status: 'torn-down', label: id },
    );

  await runMaintenance('test');

  expect(shutDown.mock.calls.map(([id]) => id).toSorted()).toEqual(['UDID-broken', 'UDID-moved', 'UDID-quiet']);
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
  expect(records.filter((record) => record.event === 'maintenance_failure').map((record) => record.target)).toEqual([
    'UDID-broken',
  ]);
});
