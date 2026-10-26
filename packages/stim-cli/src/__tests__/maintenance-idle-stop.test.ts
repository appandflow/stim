import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceViewersDir, type DeviceActivity } from '@stim-cli/core/state';
import { collectOwnedDeviceActivity, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import * as teardown from '../devices/teardown.ts';
import { deviceLeasePath, takeLease } from '../engine/device-lease.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { planIdleStop, stopIdleWorkspace } from '../maintenance/idle-stop.ts';
import { loadConfig, saveConfig, upsertProject, writeConfigSetting } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceAgentDeviceDir, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { liveClaimOwner } from './_factories.ts';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const PROTECTED = '/nowhere/protected';

let home: string;
let projects: string;
let sims: IosSimRecord[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-idle-stop-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-idle-stop-projects-')));
  process.env.STIM_HOME = home;
  vi.stubEnv('HOME', home);
  vi.stubEnv('STIM_MAINTENANCE_IDLE_STOP_HOURS', '');
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: () => '',
    runFileQuiet: (file) => (file === 'ps' ? '' : null),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  sims = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function bootedWorkspace(name: string, usedAgoMs: number) {
  const root = join(projects, name);
  const udid = `UDID-${name}`;
  mkdirSync(root, { recursive: true });
  ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: null, platforms: { ios: { deviceUdid: udid, owned: true } } });
  recordWorkspaceUse(root, new Date(Date.now() - usedAgoMs));
  sims.push({
    udid,
    name: `stim-${name} (iPhone 17 26.0)`,
    state: 'Booted',
    runtime: 'iOS 26.0',
    deviceTypeIdentifier: 'iPhone',
    available: true,
  });
  return { root, udid };
}

const realDevices = () => collectOwnedDeviceActivity(loadConfig(), sims, Date.now());

function appendLog(root: string, file: string, records: Record<string, unknown>[]) {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), file), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

async function plan(devices: (withSims: boolean) => OwnedDeviceActivity[] = realDevices) {
  return planIdleStop({ protectedRoot: PROTECTED, now: Date.now(), devices });
}

test('device, app and dev server log lines alone do not keep a workspace past maintenance.idleStopHours', async () => {
  const { root } = bootedWorkspace('chatter', 7 * HOUR_MS);
  const now = Date.now();
  appendLog(root, 'device.ndjson', [
    {
      ts: now - 1000,
      src: 'device',
      platform: 'ios',
      level: 'info',
      msg: '[C120655 Hostname#4134285d:8082 tcp] dealloc',
    },
  ]);
  appendLog(root, 'client.ndjson', [{ ts: now - 1000, src: 'client', level: 'info', msg: 'tick' }]);
  appendLog(root, 'metro.ndjson', [
    { ts: now - 1000, src: 'metro', level: 'warn', event: 'expo_stdout', msg: 'WARN Sending onAnimatedValueUpdate' },
  ]);
  const teardownSession = join(workspaceAgentDeviceDir(root), 'sessions', 'stim-teardown-inventory');
  mkdirSync(teardownSession, { recursive: true });
  writeFileSync(join(teardownSession, 'events.ndjson'), '{}\n');

  const { actions, skips } = await plan();

  expect(skips).toEqual([]);
  expect(actions).toEqual([
    expect.objectContaining({ kind: 'would-stop-workspace', check: 'idle', workspace: root, target: root }),
  ]);
  expect(actions.map((action) => action.reason)).toEqual([
    expect.stringMatching(/no real activity for 7h.*maintenance\.idleStopHours 6/),
  ]);
});

function serving(name: string, port: number) {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: 8100, platforms: {} });
  recordWorkspaceUse(root, new Date(Date.now() - 7 * HOUR_MS));
  writeWorkspaceState(root, { supervisor: { ...liveClaimOwner(), port, mode: 'expo-child' } });
  return root;
}

test('a running dev server whose only recent records are its own output is stopped, an unverified one is kept', async () => {
  const idle = serving('serving', 8100);
  appendLog(idle, 'metro.ndjson', [
    { ts: Date.now() - 1000, src: 'metro', level: 'warn', event: 'expo_stdout', msg: 'WARN App Start Span' },
  ]);
  const unverified = serving('unverified', 9999);

  const { actions, skips } = await plan();

  expect(actions).toEqual([expect.objectContaining({ kind: 'would-stop-workspace', check: 'idle', target: idle })]);
  expect(skips).toEqual([
    expect.objectContaining({
      target: unverified,
      reason: expect.stringMatching(/^its dev server supervisor cannot be verified/),
    }),
  ]);
});

const recent = Date.now() - HOUR_MS;
test.each<[string, (root: string) => void]>([
  ['a Stim command', (root) => recordWorkspaceUse(root, new Date(recent))],
  [
    'a native run that finished within the window',
    (root) =>
      writeWorkspaceState(root, {
        lastBuild: { startedAt: new Date(Date.now() - 7 * HOUR_MS).toISOString(), durationMs: 6 * HOUR_MS },
      }),
  ],
  [
    'a Metro bundle request',
    (root) =>
      appendLog(root, 'metro.ndjson', [
        { ts: recent, src: 'metro', event: 'bundle_response_started', platform: 'ios', requestId: 'r1' },
        { ts: Date.now() - 2 * MINUTE_MS, src: 'metro', event: 'expo_stdout', msg: 'later chatter' },
      ]),
  ],
  [
    'an HMR update',
    (root) => appendLog(root, 'metro.ndjson', [{ ts: recent, src: 'metro', event: 'hmr_update', msg: 'HMR update' }]),
  ],
  [
    'an agent-device command in the workspace',
    (root) => {
      const dir = join(workspaceAgentDeviceDir(root), 'sessions', 'cwd_1234_default');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.ndjson'), '{}\n');
      utimesSync(join(dir, 'events.ndjson'), new Date(recent), new Date(recent));
    },
  ],
])('%s within maintenance.idleStopHours keeps the workspace', async (_, act) => {
  const { root } = bootedWorkspace('active', 7 * HOUR_MS);
  act(root);

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([
    expect.objectContaining({
      target: root,
      reason: expect.stringMatching(/^its last .+ was 1h ago, within maintenance\.idleStopHours$/),
    }),
  ]);
});

test('a stim-server viewer streaming the simulator keeps the workspace', async () => {
  const { root, udid } = bootedWorkspace('watched', 7 * HOUR_MS);
  mkdirSync(deviceViewersDir(), { recursive: true });
  writeFileSync(
    join(deviceViewersDir(), 'server.json'),
    JSON.stringify({ ...liveClaimOwner(), devices: [{ platform: 'ios', id: udid }] }),
  );

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([expect.objectContaining({ target: root, reason: expect.stringMatching(/live view/) })]);
});

test('a held native-run claim keeps an idle workspace', async () => {
  const { root } = bootedWorkspace('building', 7 * HOUR_MS);

  const { actions, skips } = await withWorkspaceProcessLock(workspaceDir(root), 'native-run', () => plan(), {
    external: true,
    waitMs: 0,
    ownerPurpose: 'test',
  });

  expect(actions).toEqual([]);
  expect(skips).toEqual([expect.objectContaining({ target: root, reason: expect.stringMatching(/native-run/) })]);
});

test('maintenance.idleStopHours 0 turns idle stop off, and a machine value of 1 stops after an hour', async () => {
  const { root: early } = bootedWorkspace('early', 59 * MINUTE_MS);
  const { root: late } = bootedWorkspace('late', 61 * MINUTE_MS);
  writeConfigSetting({ scope: 'machine' }, 'maintenance.idleStopHours', 1);

  const hourly = await plan();
  expect(hourly.actions).toEqual([
    expect.objectContaining({ target: late, reason: expect.stringMatching(/over maintenance\.idleStopHours 1$/) }),
  ]);
  expect(hourly.skips.map((skip) => skip.target)).toEqual([early]);

  vi.stubEnv('STIM_MAINTENANCE_IDLE_STOP_HOURS', '0');
  expect(await plan()).toEqual({ actions: [], blocked: [], skips: [] });
});

const activity = (state: DeviceActivity['state'], basis: string[], tool: string): DeviceActivity => ({
  state,
  basis,
  driver: { tool, pid: 1, since: null },
  lastActivityAt: new Date(Date.now() - 7 * HOUR_MS).toISOString(),
});

test('an automation driver keeps the workspace, an agent-device session left open does not', async () => {
  const { root, udid } = bootedWorkspace('driven', 7 * HOUR_MS);
  const device = (state: DeviceActivity) => () => [
    { kind: 'ios' as const, id: udid, name: 'sim', project: root, slot: 'default', activity: state },
  ];

  const maestro = await plan(device(activity('driven', ['driver-process'], 'maestro')));
  expect(maestro.skips).toEqual([expect.objectContaining({ reason: 'its simulator sim is driven by maestro' })]);

  const unknown = await plan(device(activity('unknown', ['driver-process'], 'ps')));
  expect(unknown.skips).toEqual([expect.objectContaining({ reason: expect.stringMatching(/unknown activity/) })]);

  const agent = await plan(device(activity('driven', ['agent-device-claim'], 'agent-device')));
  expect(agent.actions.map((action) => action.target)).toEqual([root]);
});

test('the stop shuts the idle simulator down without deleting it and leaves device leases alone', async () => {
  const { root, udid } = bootedWorkspace('stopped', 7 * HOUR_MS);
  expect(takeLease({ root, platform: 'ios', id: 'PHONE-1', kind: 'declared', durationMs: 1 }).status).toBe('taken');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const shutdown = vi.spyOn(teardown, 'teardownOwnedIosSim').mockImplementation(async () => {
    for (const sim of sims) sim.state = 'Shutdown';
    return { status: 'torn-down' };
  });
  const { actions } = await plan();
  expect(actions).toHaveLength(1);

  const outcomes = await Promise.all(
    actions.map((action) => stopIdleWorkspace(action, { protectedRoot: PROTECTED, devices: () => realDevices })),
  );

  expect(outcomes).toEqual([expect.objectContaining({ status: 'done' })]);
  expect(shutdown.mock.calls).toEqual([[udid, expect.not.objectContaining({ del: true })]]);
  expect(existsSync(deviceLeasePath('ios', 'PHONE-1'))).toBe(true);
  expect((await plan()).actions).toEqual([]);
});
