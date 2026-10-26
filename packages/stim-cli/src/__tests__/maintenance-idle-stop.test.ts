import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deviceViewersDir, readMaintenanceState, type DeviceActivity } from '@stim-cli/core/state';
import * as gcDevices from '../commands/gc/devices.ts';
import { collectOwnedDeviceActivity, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import * as ios from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { resolveBudget } from '../budget.ts';
import { stopIdleWorkspaces } from '../commands/gc/idle-workspaces.ts';
import type { GcOutput } from '../commands/gc/results.ts';
import { executeAction } from '../maintenance/act.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { deviceLeasePath, takeLease } from '../engine/device-lease.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { planIdleStop, stopIdleWorkspace } from '../maintenance/idle-stop.ts';
import { loadConfig, saveConfig, upsertProject, writeConfigSetting } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceAgentDeviceDir, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const PROTECTED = '/nowhere/protected';
const posixModes = process.getuid?.() !== 0 && process.platform !== 'win32';

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
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
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

function serving(name: string, port: number, mode = 'expo-child') {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: 8100, platforms: {} });
  recordWorkspaceUse(root, new Date(Date.now() - 7 * HOUR_MS));
  writeWorkspaceState(root, { supervisor: { ...liveClaimOwner(), port, mode } });
  return root;
}

test('a running dev server whose only recent records are its own output is stopped, an unverified one is kept', async () => {
  const idle = serving('serving', 8100);
  appendLog(idle, 'metro.ndjson', [
    { ts: Date.now() - 1000, src: 'metro', level: 'warn', event: 'expo_stdout', msg: 'WARN App Start Span' },
  ]);
  const unverified = serving('unverified', 9999);
  const command = serving('command', 8100, 'command-child');

  const { actions, skips } = await plan();

  expect(actions).toEqual([expect.objectContaining({ kind: 'would-stop-workspace', check: 'idle', target: idle })]);
  expect(skips).toEqual([
    expect.objectContaining({
      target: unverified,
      reason: expect.stringMatching(/^its dev server supervisor cannot be verified/),
    }),
    expect.objectContaining({ target: command, reason: expect.stringMatching(/metro\.command/) }),
  ]);
});

test('a Metro log rotated within the window keeps the workspace, since an older request may be gone', async () => {
  const root = serving('rotated', 8100);
  appendLog(root, 'metro.ndjson.1', [{ ts: Date.now() - HOUR_MS, src: 'metro', event: 'expo_stdout', msg: 'spam' }]);
  appendLog(root, 'metro.ndjson', [{ ts: Date.now() - 1000, src: 'metro', event: 'expo_stdout', msg: 'spam' }]);

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([
    expect.objectContaining({ target: root, reason: expect.stringMatching(/rotated Metro log/) }),
  ]);
});

test('an unexpired device lease held by the workspace keeps it', async () => {
  const { root } = bootedWorkspace('leased', 7 * HOUR_MS);
  expect(takeLease({ root, platform: 'ios', id: 'PHONE-2', kind: 'declared' }).status).toBe('taken');

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([expect.objectContaining({ target: root, reason: expect.stringMatching(/device lease on/) })]);
});

test('activity after the plan keeps the workspace when the stop runs', async () => {
  const { root } = bootedWorkspace('resumed', 7 * HOUR_MS);
  const shutdown = vi.spyOn(teardown, 'teardownOwnedIosSim');
  const { actions } = await plan();
  expect(actions).toHaveLength(1);
  recordWorkspaceUse(root);

  const outcomes = await Promise.all(
    actions.map((action) => stopIdleWorkspace(action, { protectedRoot: PROTECTED, devices: () => realDevices })),
  );

  expect(outcomes).toEqual([
    expect.objectContaining({ status: 'kept', detail: expect.stringMatching(/stim command/) }),
  ]);
  expect(shutdown).not.toHaveBeenCalled();
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
])('%s within maintenance.idleStopHours keeps the workspace without a skip record', async (_, act) => {
  const { root } = bootedWorkspace('active', 7 * HOUR_MS);
  act(root);

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([]);
});

test('a stim-server viewer streaming the simulator keeps the workspace', async () => {
  const { udid } = bootedWorkspace('watched', 7 * HOUR_MS);
  mkdirSync(deviceViewersDir(), { recursive: true });
  writeFileSync(
    join(deviceViewersDir(), 'server.json'),
    JSON.stringify({ ...liveClaimOwner(), devices: [{ platform: 'ios', id: udid }] }),
  );

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([]);
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
  expect(hourly.skips).toEqual([]);
  expect(early).not.toBe(late);

  vi.stubEnv('STIM_MAINTENANCE_IDLE_STOP_HOURS', '0');
  expect(await plan()).toEqual({ actions: [], blocked: [], skips: [] });

  vi.stubEnv('STIM_MAINTENANCE_IDLE_STOP_HOURS', '-1');
  const invalid = await plan();
  expect(invalid.actions).toEqual([]);
  expect(invalid.skips.map((skip) => skip.reason)).toEqual([
    'STIM_MAINTENANCE_IDLE_STOP_HOURS is invalid: expected a number, 0 or more',
    'STIM_MAINTENANCE_IDLE_STOP_HOURS is invalid: expected a number, 0 or more',
  ]);
});

const activity = (state: DeviceActivity['state'], basis: string[], tool: string): DeviceActivity => ({
  state,
  basis,
  driver: { tool, pid: 1, since: null },
  lastActivityAt: new Date(Date.now() - 7 * HOUR_MS).toISOString(),
});

test('an automation driver keeps the workspace, an agent-device session left open is judged by its last command', async () => {
  const { root, udid } = bootedWorkspace('driven', 7 * HOUR_MS);
  const device = (state: DeviceActivity) => () => [
    { kind: 'ios' as const, id: udid, name: 'sim', project: root, slot: 'default', activity: state },
  ];

  const maestro = await plan(device(activity('driven', ['driver-process'], 'maestro')));
  expect(maestro.skips).toEqual([expect.objectContaining({ reason: 'its simulator sim is driven by maestro' })]);

  const unknown = await plan(device(activity('unknown', ['driver-process'], 'ps')));
  expect(unknown.skips).toEqual([expect.objectContaining({ reason: expect.stringMatching(/unknown activity/) })]);

  const claimed = activity('driven', ['agent-device-claim'], 'agent-device');
  const unseen = await plan(device(claimed));
  expect(unseen.skips).toEqual([expect.objectContaining({ reason: expect.stringMatching(/agent-device claim/) })]);

  const old = new Date(Date.now() - 7 * HOUR_MS).toISOString();
  const agent = await plan(device({ ...claimed, recent: { 'agent-action': old } }));
  expect(agent.actions.map((action) => action.target)).toEqual([root]);

  const unprobed = await plan(device({ ...claimed, recent: { 'agent-action': old }, unknown: ['driver-process'] }));
  expect(unprobed.skips).toEqual([expect.objectContaining({ reason: expect.stringMatching(/unknown activity/) })]);
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

test('a STIM_HOME-scoped home plans and runs no idle stop, since its devices are machine-wide', async () => {
  const { root } = bootedWorkspace('scoped', 7 * HOUR_MS);
  vi.mocked(gcDevices.deviceSweepIsScoped).mockReturnValue(true);
  const shutdown = vi.spyOn(teardown, 'teardownOwnedIosSim');

  expect(await plan()).toEqual({ actions: [], blocked: [], skips: [] });
  expect(
    await stopIdleWorkspace(
      { target: root, workspace: root, reason: 'idle' },
      { protectedRoot: PROTECTED, devices: () => realDevices },
    ),
  ).toMatchObject({ status: 'kept', detail: expect.stringMatching(/STIM_HOME/) });
  expect(shutdown).not.toHaveBeenCalled();
});

test.skipIf(!posixModes)('an unreadable Metro log keeps the workspace', async () => {
  const root = serving('unreadable', 8100);
  appendLog(root, 'metro.ndjson', [{ ts: Date.now() - 1000, src: 'metro', event: 'expo_stdout', msg: 'spam' }]);
  chmodSync(join(workspaceLogsDir(root), 'metro.ndjson'), 0o000);

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([
    expect.objectContaining({ target: root, reason: expect.stringMatching(/Metro log cannot be read/) }),
  ]);
});

test('a maintenance pass routes a planned idle stop to the stim stop path', async () => {
  const { udid } = bootedWorkspace('routed', 7 * HOUR_MS);
  const shutdown = vi.spyOn(teardown, 'teardownOwnedIosSim').mockResolvedValue({ status: 'torn-down' });
  vi.spyOn(ios, 'listAllIosSims').mockImplementation(() => sims);
  const { actions } = await plan();
  const context = { settings: resolveMaintenanceSettings(), budget: resolveBudget().budget, protectedRoot: PROTECTED };

  const outcomes = await Promise.all(actions.map((action) => executeAction(action, context)));

  expect(outcomes).toEqual([expect.objectContaining({ status: 'done' })]);
  expect(shutdown.mock.calls).toEqual([[udid, expect.not.objectContaining({ del: true })]]);
});

test('a timer-started pass may stop the workspace it started in, a command-started one may not', async () => {
  const { root } = bootedWorkspace('timer', 7 * HOUR_MS);
  vi.spyOn(teardown, 'teardownOwnedIosSim').mockResolvedValue({ status: 'torn-down' });
  vi.spyOn(ios, 'listAllIosSims').mockImplementation(() => sims);
  const { actions } = await plan();
  const context = { settings: resolveMaintenanceSettings(), budget: resolveBudget().budget, protectedRoot: root };

  expect(await Promise.all(actions.map((action) => executeAction(action, context)))).toEqual([
    expect.objectContaining({ status: 'kept', detail: expect.stringMatching(/command that started this pass/) }),
  ]);
  expect(await Promise.all(actions.map((action) => executeAction(action, { ...context, background: true })))).toEqual([
    expect.objectContaining({ status: 'done' }),
  ]);
});

test('gc --delete stops idle workspaces only while maintenance is not off, and counts a failed stop', async () => {
  const { root } = bootedWorkspace('failing', 7 * HOUR_MS);
  vi.spyOn(teardown, 'teardownOwnedIosSim').mockRejectedValue(new Error('simctl refused'));
  vi.spyOn(ios, 'listAllIosSims').mockImplementation(() => sims);
  const record = vi.fn<GcOutput['record']>();
  const output = { log: () => {}, error: () => {}, record, fail: () => {} };

  expect(await stopIdleWorkspaces(output)).toBe(0);
  expect(record).not.toHaveBeenCalled();

  vi.stubEnv('STIM_MAINTENANCE', 'on');
  expect(await stopIdleWorkspaces(output)).toBe(1);
  expect(record).toHaveBeenCalledWith('devServer', 'failed', root, expect.anything());
});

test('a running dev server whose emulators cannot be listed is kept', async () => {
  const root = serving('emulators', 8100);
  upsertProject(root, { platforms: { android: { avdName: 'stim-emulators', owned: true } } });
  appendLog(root, 'metro.ndjson', [{ ts: Date.now() - 7 * HOUR_MS, src: 'metro', event: 'expo_stdout', msg: 'x' }]);
  const real = getExecutor();
  setExecutor({
    ...real,
    runFile: (file, args, options) => {
      if (file.endsWith('emulator')) throw new Error('emulator -list-avds timed out');
      return real.runFile(file, args, options);
    },
  });

  const { actions, skips } = await plan(() => []);

  expect(actions).toEqual([]);
  expect(skips).toEqual([
    expect.objectContaining({ target: root, reason: expect.stringMatching(/emulators cannot be listed.*timed out/) }),
  ]);
});

test.each<[string, (root: string) => void]>([
  [
    'an unreadable state.json',
    (root) => {
      const session = join(workspaceAgentDeviceDir(root), 'sessions', 'cwd_old_default');
      mkdirSync(session, { recursive: true });
      writeFileSync(join(session, 'events.ndjson'), '{}\n');
      const old = new Date(Date.now() - 7 * HOUR_MS);
      utimesSync(join(session, 'events.ndjson'), old, old);
      writeFileSync(join(workspaceDir(root), 'state.json'), '{ not json');
    },
  ],
  [
    'an unreadable device lease file',
    () => {
      mkdirSync(dirname(deviceLeasePath('ios', 'PHONE-9')), { recursive: true });
      writeFileSync(deviceLeasePath('ios', 'PHONE-9'), '{ not json');
    },
  ],
  [
    'a stim-server viewer record that cannot be read',
    () => {
      mkdirSync(deviceViewersDir(), { recursive: true });
      writeFileSync(join(deviceViewersDir(), 'server.json'), '{ not json');
    },
  ],
  [
    'a build in progress',
    (root) => {
      const claims = join(home, 'build-claims');
      plantClaim(claims, 'exclusive', liveClaimOwner(), { claimId: 'build-1' });
      const at = new Date().toISOString();
      writeWorkspaceState(root, {
        activeBuild: {
          platform: 'ios',
          phase: 'prepare',
          startedAt: at,
          phaseStartedAt: at,
          claim: { root: claims, claimId: 'build-1' },
        },
      });
    },
  ],
  ['a remote device session', (root) => writeWorkspaceState(root, { remoteDevice: { sessionId: 'remote-1' } })],
])('%s keeps the workspace', async (_, act) => {
  const { root } = bootedWorkspace('unknown', 7 * HOUR_MS);
  act(root);

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([expect.objectContaining({ target: root })]);
});

test('a running dev server with no Metro log keeps the workspace', async () => {
  const root = serving('silent', 8100);

  const { actions, skips } = await plan();

  expect(actions).toEqual([]);
  expect(skips).toEqual([
    expect.objectContaining({ target: root, reason: expect.stringMatching(/Metro log is missing/) }),
  ]);
});

test.skipIf(!posixModes)('agent-device sessions that cannot be read keep the workspace', async () => {
  const { root } = bootedWorkspace('sessions', 7 * HOUR_MS);
  const sessions = join(workspaceAgentDeviceDir(root), 'sessions');
  mkdirSync(join(sessions, 'cwd_1234_default'), { recursive: true });
  chmodSync(sessions, 0o000);
  let result;
  try {
    result = await plan();
  } finally {
    chmodSync(sessions, 0o700);
  }

  expect(result.actions).toEqual([]);
  expect(result.skips).toEqual([
    expect.objectContaining({ target: root, reason: expect.stringMatching(/agent-device sessions cannot be read/) }),
  ]);
});

test('a stray file in the agent-device sessions directory does not keep the workspace forever', async () => {
  const { root } = bootedWorkspace('stray', 7 * HOUR_MS);
  const sessions = join(workspaceAgentDeviceDir(root), 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, '.DS_Store'), '');

  expect((await plan()).actions.map((action) => action.target)).toEqual([root]);
});

test.each([
  ['supervisor', true],
  ['command', false],
])('a %s-triggered pass in an idle workspace plans its stop: %s', async (trigger, planned) => {
  const { root } = bootedWorkspace('self', 7 * HOUR_MS);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'self' }));
  vi.spyOn(ios, 'listAllIosSims').mockImplementation(() => sims);
  vi.stubEnv('STIM_MAINTENANCE', 'report');
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await runMaintenance(trigger);
  } finally {
    process.chdir(cwd);
  }

  const stops = (readMaintenanceState()?.plan ?? []).filter((action) => action.check === 'idle');
  expect(stops.map((action) => action.target)).toEqual(planned ? [root] : []);
});
