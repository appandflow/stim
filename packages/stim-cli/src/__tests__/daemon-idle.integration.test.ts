import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  daemonNdjsonFile,
  DEVICE_METRO_IDLE_STOP_REASON,
  INTERACTIONS_KEY,
  readDeferredShutdowns,
  readDeviceIdleShutdowns,
  readIdleStage,
} from '@stim-cli/core/state';
import { collectOwnedDeviceActivityAsync, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import * as stopCommand from '../commands/stop.ts';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { recordDeferredShutdown } from '../devices/deferred-shutdown.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from '../daemon/passes-guard-env.ts';
import { runBootedParkedPass, shutDownDeferredIosSim } from '../daemon/booted-parked.ts';
import { runIdlePass } from '../daemon/idle.ts';
import * as measure from '../daemon/measure.ts';
import { runPassesInProcess } from '../daemon/passes.ts';
import * as maintenanceRun from '../stimd/passes/run.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { liveClaimOwner, writeDerivedData } from './_factories.ts';
import { serveShareList, shareRow, type ShareListAnswer } from './_share-list-server.ts';

const MINUTE_MS = 60_000;

let home: string;
let projects: string;
let sims: IosSimRecord[];
let tornDown: string[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-daemon-idle-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-daemon-idle-projects-')));
  process.env.STIM_HOME = home;
  vi.stubEnv('HOME', home);
  const real = getExecutor();
  setExecutor({ ...real, runFileQuiet: (file) => (file === 'ps' ? '' : null) });
  saveConfig({ version: 2, projects: {}, repos: {} });
  sims = [];
  tornDown = [];
  vi.spyOn(teardown, 'teardownOwnedIosSim').mockImplementation(async (udid) => {
    tornDown.push(udid);
    return { status: 'torn-down', label: `stim-${udid}` };
  });
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
  upsertProject(root, { metroPort: 59123, platforms: { ios: { deviceUdid: udid, owned: true } } });
  recordCreatedDevice('ios', udid);
  recordWorkspaceUse(root, new Date(Date.now() - usedAgoMs));
  const launch = {
    appId: 'com.example.app',
    deviceId: udid,
    metroPort: 59123,
    release: false,
    launchedAt: '',
    artifact: { configuration: 'Debug', fingerprint: 'f', cacheKey: 'key', cacheHit: 'local' },
  };
  writeWorkspaceState(root, { launches: { ios: launch } });
  const derivedData = join(workspaceDir(root), 'derived-data');
  mkdirSync(derivedData, { recursive: true });
  writeFileSync(join(derivedData, 'Build.o'), 'x'.repeat(4096));
  sims.push({
    udid,
    name: `stim-${name} (iPhone 17 26.0)`,
    state: 'Booted',
    runtime: 'iOS 26.0',
    deviceTypeIdentifier: 'iPhone',
    available: true,
  });
  return { root, udid, derivedData, launch };
}

function writeLog(root: string, file: string, record: Record<string, unknown>) {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), file), `${JSON.stringify({ ts: Date.now(), ...record })}\n`);
}

async function pass(act = true, drive: (device: OwnedDeviceActivity) => OwnedDeviceActivity = (device) => device) {
  const config = loadConfig();
  const devices = (await collectOwnedDeviceActivityAsync(config, sims, Date.now())).map(drive);
  return runIdlePass({ config, now: Date.now(), sims, simsError: null, devices, act, log: () => {} });
}

test('a workspace idle past idle.minutes, whatever its device and app logs, enters the idle stage in one pass', async () => {
  const { root, udid, derivedData, launch } = bootedWorkspace('quiet', 20 * MINUTE_MS);
  writeLog(root, 'device.ndjson', { src: 'device', platform: 'ios', msg: 'nw_connection retry' });
  writeLog(root, 'client.ndjson', { src: 'client', platform: 'ios', msg: 'tick' });

  expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);

  expect(tornDown).toEqual([udid]);
  expect(existsSync(derivedData)).toBe(false);
  const state = readWorkspaceState(root);
  expect(readIdleStage(state)).toMatchObject({ idleMinutes: 15, freedBytes: expect.any(Number) });
  expect(readDeviceIdleShutdowns(state).ios).toMatchObject({ idleMinutes: 15, reason: DEVICE_METRO_IDLE_STOP_REASON });
  expect(state?.launches).toEqual({ ios: launch });
  expect(getProject(root)?.metroPort).toBe(59123);
  const timeline = readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf8');
  expect(timeline).toContain('"event":"workspace_idle"');
  expect(timeline).toContain('Run stim ios or stim android to resume it.');
});

test('the idle stage deletes the git-ignored .dd and CMake output of a workspace and leaves other-named xcodebuild output', async () => {
  const { root } = bootedWorkspace('outputs', 20 * MINUTE_MS);
  execSync('git init -q', { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.dd/\nandroid/\nbuild-device/\n');
  writeDerivedData(join(root, '.dd'));
  writeDerivedData(join(root, 'build-device'));
  mkdirSync(join(root, 'android', 'app', '.cxx'), { recursive: true });
  writeFileSync(join(root, 'android', 'app', '.cxx', 'blob'), 'cmake');

  expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);

  expect(existsSync(join(root, '.dd'))).toBe(false);
  expect(existsSync(join(root, 'android', 'app', '.cxx'))).toBe(false);
  expect(existsSync(join(root, 'build-device', 'Build'))).toBe(true);
});

test('the idle stage keeps a .dd that git does not ignore', async () => {
  const { root } = bootedWorkspace('unignored', 20 * MINUTE_MS);
  execSync('git init -q', { cwd: root });
  writeDerivedData(join(root, '.dd'));

  const [result] = await pass();

  expect(result).toMatchObject({
    path: root,
    outcome: 'idle',
    detail: expect.stringContaining(`${sep}.dd: it holds files git does not ignore`),
  });
  expect(existsSync(join(root, '.dd', 'Build'))).toBe(true);
});

test('a live agent-device session keeps the workspace however old its last command, naming the driver', async () => {
  const { root, derivedData } = bootedWorkspace('agent', 20 * MINUTE_MS);
  const old = new Date(Date.now() - 20 * MINUTE_MS).toISOString();

  const decisions = await pass(true, (device) => ({
    ...device,
    activity: {
      state: 'driven',
      basis: ['agent-device-claim'],
      driver: { tool: 'agent-device', pid: 1, since: null },
      lastActivityAt: old,
      recent: { 'agent-action': old },
    },
  }));

  expect(decisions).toEqual([
    expect.objectContaining({
      path: root,
      outcome: 'kept',
      detail: 'its simulator stim-agent (iPhone 17 26.0) is driven by agent-device',
    }),
  ]);
  expect(tornDown).toEqual([]);
  expect(existsSync(derivedData)).toBe(true);
});

test('a serving workspace whose simulators cannot be listed is kept, not stopped', async () => {
  const { root, derivedData } = bootedWorkspace('unlisted', 20 * MINUTE_MS);
  writeWorkspaceState(root, { supervisor: { ...liveClaimOwner(), port: 59123, mode: 'expo-child', hmrUpdates: true } });
  writeLog(root, 'metro.ndjson', {
    ts: Date.now() - 20 * MINUTE_MS,
    src: 'metro',
    event: 'bundle_response_finished',
    platform: 'ios',
    requestId: 'r1',
  });
  const stopped = vi.spyOn(stopCommand, 'runIdleStop').mockRejectedValue(new Error('unexpected idle stop'));
  const config = loadConfig();

  const decisions = await runIdlePass({
    config,
    now: Date.now(),
    sims: null,
    simsError: 'simctl list timed out',
    devices: [],
    act: true,
    log: () => {},
  });

  expect(decisions).toEqual([
    expect.objectContaining({
      path: root,
      outcome: 'kept',
      detail: 'its simulators cannot be listed (simctl list timed out)',
    }),
  ]);
  expect(stopped).not.toHaveBeenCalled();
  expect(existsSync(derivedData)).toBe(true);
});

test('a booted device this home did not create is reported once as kept and never enters the idle stage', async () => {
  const { root, udid, derivedData } = bootedWorkspace('foreign', 20 * MINUTE_MS);
  forgetCreatedDevice('ios', udid);
  const stopped = vi.spyOn(stopCommand, 'runIdleStop').mockRejectedValue(new Error('unexpected idle stop'));

  for (let tick = 0; tick < 2; tick++)
    expect(await pass()).toEqual([
      expect.objectContaining({
        path: root,
        outcome: 'kept',
        detail:
          "stim-foreign (iPhone 17 26.0) not in this Stim home's created-devices ledger, so the idle stage leaves it",
      }),
    ]);
  expect(stopped).not.toHaveBeenCalled();
  expect(tornDown).not.toContain(udid);
  expect(existsSync(derivedData)).toBe(true);
  expect(readIdleStage(readWorkspaceState(root))).toBe(null);
});

test('use of its focused Simulator window within idle.minutes keeps the workspace running', async () => {
  const { root, derivedData } = bootedWorkspace('watched', 20 * MINUTE_MS);
  writeWorkspaceState(root, { [INTERACTIONS_KEY]: { ios: new Date(Date.now() - MINUTE_MS).toISOString() } });

  expect(await pass()).toEqual([
    expect.objectContaining({
      outcome: 'active',
      lastActivity: expect.objectContaining({ basis: 'Simulator or emulator window' }),
    }),
  ]);
  expect(tornDown).toEqual([]);
  expect(existsSync(derivedData)).toBe(true);
});

test('report mode decides and acts on nothing', async () => {
  const { derivedData } = bootedWorkspace('report', 20 * MINUTE_MS);

  expect(await pass(false)).toEqual([expect.objectContaining({ outcome: 'would-idle' })]);
  expect(tornDown).toEqual([]);
  expect(existsSync(derivedData)).toBe(true);
});

test('a pass for workspaces with no dev server leaves a serving workspace to its supervisor and the command workspace alone', async () => {
  const left = bootedWorkspace('left', 20 * MINUTE_MS);
  const serving = bootedWorkspace('serving', 20 * MINUTE_MS);
  const own = bootedWorkspace('own', 20 * MINUTE_MS);
  writeWorkspaceState(serving.root, {
    ...readWorkspaceState(serving.root),
    supervisor: { ...liveClaimOwner(), port: 59123, mode: 'expo-child', hmrUpdates: true },
  });
  const config = loadConfig();
  const devices = await collectOwnedDeviceActivityAsync(config, sims, Date.now());

  const decisions = await runIdlePass({
    config,
    now: Date.now(),
    sims,
    simsError: null,
    devices,
    act: true,
    unsupervised: true,
    protectedRoot: own.root,
    log: () => {},
  });

  expect(decisions).toEqual([expect.objectContaining({ path: left.root, outcome: 'idle' })]);
  expect(tornDown).toEqual([left.udid]);
  expect(existsSync(serving.derivedData)).toBe(true);
  expect(existsSync(own.derivedData)).toBe(true);
});

describe('the in-process passes of a command with no daemon holding the home', () => {
  const run = (act: 'on' | 'report', root: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, STIM_DAEMON: act };
    delete env[HOME_PASSES_TEST_GUARD_ENV];
    return runPassesInProcess('logs', env, root);
  };

  beforeEach(() => {
    vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();
    vi.spyOn(measure, 'measureDisk').mockResolvedValue([{ volume: '/', freeMb: 10_000_000 }]);
    vi.spyOn(measure, 'measureMemory').mockResolvedValue({ level: 'normal', availableBytes: 1e12, totalBytes: 1e12 });
    vi.spyOn(measure, 'measureTick').mockImplementation(async (config, now) => ({
      sims,
      simsError: null,
      devices: await collectOwnedDeviceActivityAsync(config, sims, now),
      measurement: {
        disk: [],
        memory: { level: 'normal', availableBytes: null, totalBytes: 0 },
        load1: 0,
        cores: 1,
        bootedSimulators: sims.length,
        runningEmulators: null,
        interaction: null,
      },
    }));
  });

  test('shut down an owned device with no dev server once it is idle, and never the command workspace', async () => {
    const left = bootedWorkspace('left', 20 * MINUTE_MS);
    const own = bootedWorkspace('own', 20 * MINUTE_MS);

    await run('on', own.root);

    expect(tornDown).toEqual([left.udid]);
    expect(existsSync(left.derivedData)).toBe(false);
    expect(existsSync(own.derivedData)).toBe(true);
    expect(readFileSync(join(workspaceLogsDir(left.root), 'metro.ndjson'), 'utf8')).toContain(
      '"event":"workspace_idle"',
    );
  });

  test('only log what they would do in report mode', async () => {
    const left = bootedWorkspace('left', 20 * MINUTE_MS);

    await run('report', join(projects, 'elsewhere'));

    expect(tornDown).toEqual([]);
    expect(existsSync(left.derivedData)).toBe(true);
    expect(readFileSync(daemonNdjsonFile(), 'utf8')).toContain('"event":"workspace_would_idle"');
  });
});

test('maintenance.keep keeps an idle workspace out of the idle stage', async () => {
  const { root } = bootedWorkspace('pinned', 20 * MINUTE_MS);
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));

  expect(await pass()).toEqual([expect.objectContaining({ outcome: 'kept', detail: 'pinned by maintenance.keep' })]);
  expect(tornDown).toEqual([]);
});

describe.skipIf(process.platform === 'win32')('a web share', () => {
  let answer: ShareListAnswer;
  let server: { close: () => Promise<void> };
  beforeEach(async () => {
    answer = { shares: [] };
    server = await serveShareList(() => answer);
  });
  afterEach(() => server.close());

  test('keeps an idle workspace, naming it, until stim share stop ends it', async () => {
    const { root, udid, derivedData } = bootedWorkspace('shared', 20 * MINUTE_MS);
    const expiresAt = new Date(Date.now() + 30 * MINUTE_MS).toISOString();
    answer = { shares: [shareRow(root, expiresAt)] };

    expect(await pass()).toEqual([
      expect.objectContaining({
        path: root,
        outcome: 'kept',
        detail: `it has a live web share (ios until ${expiresAt}); stim share stop ends it`,
      }),
    ]);
    expect(tornDown).toEqual([]);
    expect(existsSync(derivedData)).toBe(true);

    answer = { shares: [] };
    expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
    expect(tornDown).toEqual([udid]);
  });

  test('past its expiry keeps nothing, even while stim-server still lists it', async () => {
    const { root, udid } = bootedWorkspace('expiring', 20 * MINUTE_MS);
    const other = join(projects, 'other');
    mkdirSync(other);
    answer = {
      shares: [
        shareRow(root, new Date(Date.now() + MINUTE_MS).toISOString()),
        shareRow(other, '2099-01-01T00:00:00.000Z'),
      ],
    };
    expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'kept' })]);

    answer = {
      shares: [shareRow(root, new Date(Date.now() - 1000).toISOString()), shareRow(other, '2099-01-01T00:00:00.000Z')],
    };
    expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
    expect(tornDown).toEqual([udid]);
  });

  test('a stim-server without share.list, from before 1.39, holds no share and keeps nothing', async () => {
    const { root, udid } = bootedWorkspace('older-server', 20 * MINUTE_MS);
    answer = { error: { code: 'unknown-method', message: 'Unknown method share.list.' } };

    expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
    expect(tornDown).toEqual([udid]);
  });

  test('a share list stim-server cannot give keeps the workspace', async () => {
    const { root, derivedData } = bootedWorkspace('unreadable', 20 * MINUTE_MS);
    answer = { error: { code: 'internal', message: 'The share hub is closing.' } };

    expect(await pass()).toEqual([
      expect.objectContaining({
        path: root,
        outcome: 'kept',
        detail: 'its web shares cannot be listed (The share hub is closing)',
      }),
    ]);
    expect(tornDown).toEqual([]);
    expect(existsSync(derivedData)).toBe(true);
  });
});

describe('a simulator that stop left booted', () => {
  const FUTURE = () => new Date(Date.now() + 10 * MINUTE_MS).toISOString();
  const PAST = () => new Date(Date.now() - MINUTE_MS).toISOString();
  const defer = (root: string, udid: string, until: string) => recordDeferredShutdown(root, 'default', { udid, until });
  const deferred = (root: string) => Object.keys(readDeferredShutdowns(readWorkspaceState(root)));
  const run = (memory: 'normal' | 'warning' = 'normal') =>
    runBootedParkedPass({ sims, memory, act: true, log: () => {} });

  test('is left to its deferral: the idle stage does not take the stopped workspace before the deferral passes', async () => {
    const { root, udid, derivedData } = bootedWorkspace('stopped', 20 * MINUTE_MS);
    await defer(root, udid, FUTURE());
    expect(await pass()).toEqual([]);
    expect(tornDown).toEqual([]);
    expect(existsSync(derivedData)).toBe(true);
  });

  test('goes back to the idle stage once the deferral has passed without the daemon ending it', async () => {
    const { root, udid } = bootedWorkspace('overdue', 20 * MINUTE_MS);
    await defer(root, udid, PAST());
    expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
  });

  test('is shut down through teardown once its deferral passes, and forgets the deferral', async () => {
    const { root, udid } = bootedWorkspace('expired', 20 * MINUTE_MS);
    await defer(root, udid, PAST());
    const actions = await run();
    expect(tornDown).toEqual([udid]);
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'shut-down-deferred-device', target: udid, workspace: root, outcome: 'done' }),
    ]);
    expect(deferred(root)).toEqual([]);
  });

  test('stays booted before its deferral passes while memory is normal', async () => {
    const { root, udid } = bootedWorkspace('waiting', 20 * MINUTE_MS);
    await defer(root, udid, FUTURE());
    expect(await run()).toEqual([]);
    expect(tornDown).toEqual([]);
    expect(deferred(root)).toEqual(['ios']);
  });

  test('is shut down before its deferral passes under memory pressure', async () => {
    const { root, udid } = bootedWorkspace('pressured', 20 * MINUTE_MS);
    await defer(root, udid, FUTURE());
    await run('warning');
    expect(tornDown).toEqual([udid]);
    expect(deferred(root)).toEqual([]);
  });

  test('is kept when its workspace serves again, and only loses the deferral', async () => {
    const { root, udid } = bootedWorkspace('restarted', 20 * MINUTE_MS);
    writeWorkspaceState(root, {
      ...readWorkspaceState(root),
      supervisor: { ...liveClaimOwner(), port: 59123, mode: 'expo-child', hmrUpdates: true },
    });
    await defer(root, udid, PAST());
    await run('warning');
    expect(tornDown).toEqual([]);
    expect(deferred(root)).toEqual([]);
  });

  test('is not shut down by a pass that read an older deferral than the one a newer stop recorded', async () => {
    const { root, udid } = bootedWorkspace('redeferred', 20 * MINUTE_MS);
    const stale = { root, slot: 'default', udid, name: 'stim-redeferred', until: PAST() };
    await defer(root, udid, FUTURE());
    expect(await shutDownDeferredIosSim(stale, undefined)).toBeNull();
    expect(tornDown).toEqual([]);
    expect(deferred(root)).toEqual(['ios']);
  });

  test('only loses the deferral when the simulator is no longer booted', async () => {
    const { root, udid } = bootedWorkspace('down', 20 * MINUTE_MS);
    for (const sim of sims) sim.state = 'Shutdown';
    await defer(root, udid, FUTURE());
    expect(await run()).toEqual([]);
    expect(tornDown).toEqual([]);
    expect(deferred(root)).toEqual([]);
  });

  test('is not a deferral of the workspace once another simulator is assigned to it', async () => {
    const { root } = bootedWorkspace('replaced', 20 * MINUTE_MS);
    await defer(root, 'SOMEONE-ELSE', PAST());
    expect(await run('warning')).toEqual([]);
    expect(tornDown).toEqual([]);
  });
});
