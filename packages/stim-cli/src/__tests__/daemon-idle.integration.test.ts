import { expect, test } from 'vitest';
import { acquireDisk, LADDER, CRITICAL, requestGcItem } from '../daemon/disk-owner.ts';
import { runLadder } from '../daemon/ladder.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { testContext } from './_context.ts';
import * as iosApi from '../devices/ios.ts';
import { parkSim, readParked, dropParked, keepParkedAfter } from '../devices/sim-pool.ts';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  DEVICE_METRO_IDLE_STOP_REASON,
  INTERACTIONS_KEY,
  readDeferredShutdowns,
  readDeviceIdleShutdowns,
  readIdleStage,
  type DaemonPressure,
} from '@stim-cli/core/state';
import { collectOwnedDeviceActivityAsync, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import * as stopCommand from '../commands/stop.ts';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { recordDeferredShutdown } from '../devices/deferred-shutdown.ts';
import { clearDeviceIdleShutdown } from '../devices/idle-shutdown.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runBootedParkedPass, shutDownDeferredIosSim } from '../daemon/booted-parked.ts';
import { runIdlePass } from '../daemon/idle.ts';
import type { DaemonLog } from '../daemon/step-timing.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { liveClaimOwner, writeDerivedData } from './_factories.ts';
import { serveShareList, shareRow, type ShareListAnswer } from './_share-list-server.ts';

vi.mock('../integrations/exact-clean.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    exactClean: vi.fn<typeof import('../integrations/exact-clean.ts').exactClean>(
      async (app, { dryRun = false } = {}) => {
        const remove = [path.join(app, 'target', 'debug')];
        if (!dryRun) for (const entry of remove) fs.rmSync(entry, { recursive: true, force: true });
        return { status: 'ok', remove, kept: [], held: [] };
      },
    ),
  };
});

const MINUTE_MS = 60_000;

const volume = vi.hoisted((): { short: { root: string; dev: number } | null } => ({ short: null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const statSync = new Proxy(fs.statSync, {
    apply(target, self, args: Parameters<typeof fs.statSync>) {
      const stat: unknown = Reflect.apply(target, self, args);
      const short = volume.short;
      if (stat instanceof fs.Stats && short && String(args[0]).startsWith(short.root))
        return Object.assign(Object.create(fs.Stats.prototype), stat, { dev: short.dev });
      return stat;
    },
  });
  return { ...fs, statSync };
});

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
  vi.useRealTimers();
  volume.short = null;
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

async function pass(
  act = true,
  drive: (device: OwnedDeviceActivity) => OwnedDeviceActivity = (device) => device,
  log: DaemonLog = () => {},
) {
  const config = loadConfig();
  const devices = (await collectOwnedDeviceActivityAsync(config, sims, Date.now())).map(drive);
  return runIdlePass({ config, now: Date.now(), sims, simsError: null, devices, act, log });
}

test('a device booted again after idle shutdown gets one activity window without repeated logs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { root, udid } = bootedWorkspace('booted-again', 20 * MINUTE_MS);
  const log = vi.fn<DaemonLog>();
  expect(await pass()).toEqual([expect.objectContaining({ outcome: 'idle' })]);
  expect(tornDown).toEqual([udid]);
  expect(readDeviceIdleShutdowns(readWorkspaceState(root)).ios).toMatchObject({ idleMinutes: 15 });
  expect(readDeviceIdleShutdowns(readWorkspaceState(root)).ios?.bootedAgainAt).toBeUndefined();

  vi.setSystemTime(Date.now() + MINUTE_MS);
  await pass(false);
  expect(readDeviceIdleShutdowns(readWorkspaceState(root)).ios?.bootedAgainAt).toBeUndefined();
  expect(tornDown).toHaveLength(1);
  expect(await pass(true, undefined, log)).toEqual([
    expect.objectContaining({
      outcome: 'active',
      lastActivity: expect.objectContaining({ basis: 'device booted again' }),
    }),
  ]);
  const bootedAgainAt = readDeviceIdleShutdowns(readWorkspaceState(root)).ios?.bootedAgainAt;
  expect(bootedAgainAt).toBe(new Date().toISOString());
  expect(readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf8')).toContain('device_booted_after_idle');
  expect(await pass(true, undefined, log)).toEqual([expect.objectContaining({ outcome: 'active' })]);
  expect(tornDown).toHaveLength(1);
  expect(log.mock.calls.filter((call) => call[1] === 'device_booted_after_idle')).toHaveLength(1);

  vi.setSystemTime(Date.now() + 16 * MINUTE_MS);
  expect(await pass()).toEqual([expect.objectContaining({ outcome: 'idle' })]);
  expect(tornDown).toEqual([udid, udid]);
  expect(readDeviceIdleShutdowns(readWorkspaceState(root)).ios?.bootedAgainAt).toBeUndefined();
});

test.each([
  ['memory pressure', { pressure: { level: 'high' as const, reasons: ['memory'] } }],
  ['disk pressure', { disk: {} }],
])('under %s a device booted again after idle shutdown gets no activity window', async (_name, pressure) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { root, udid } = bootedWorkspace('booted-again-pressure', 20 * MINUTE_MS);
  expect(await pass()).toEqual([expect.objectContaining({ outcome: 'idle' })]);

  vi.setSystemTime(Date.now() + MINUTE_MS);
  expect(await pass()).toEqual([expect.objectContaining({ outcome: 'active' })]);
  expect(readDeviceIdleShutdowns(readWorkspaceState(root)).ios?.bootedAgainAt).toBe(new Date().toISOString());

  vi.setSystemTime(Date.now() + MINUTE_MS);
  const config = loadConfig();
  const devices = await collectOwnedDeviceActivityAsync(config, sims, Date.now());
  const decisions = await runIdlePass({
    config,
    now: Date.now(),
    sims,
    simsError: null,
    devices,
    act: true,
    log: () => {},
    ...pressure,
  });
  expect(decisions).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
  expect(tornDown).toEqual([udid, udid]);
});

test('a timed-out idle cleanup persists its partial size', async () => {
  const { root, derivedData } = bootedWorkspace('partial', 20 * MINUTE_MS);
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) => {
      if (file === 'du') throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stdout: '' });
      return real.runFileAsync(file, args, options);
    },
  });
  expect(await pass()).toEqual([expect.objectContaining({ path: root, outcome: 'idle', freedPartial: true })]);
  expect(existsSync(derivedData)).toBe(false);
  expect(readIdleStage(readWorkspaceState(root))).toMatchObject({ freedBytes: 0, freedPartial: true });
});

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

test('under disk pressure on another volume only, a workspace stopped at idle.minutes loses all its outputs', async () => {
  const { root, udid, derivedData } = bootedWorkspace('elsewhere', 20 * MINUTE_MS);
  execSync('git init -q', { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.dd/\n');
  writeDerivedData(join(root, '.dd'));
  const config = loadConfig();
  const devices = await collectOwnedDeviceActivityAsync(config, sims, Date.now());

  const decisions = await runIdlePass({
    config,
    now: Date.now(),
    sims,
    simsError: null,
    devices,
    act: true,
    log: () => {},
    disk: { volumes: new Set([4_242_424]) },
  });

  expect(decisions).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
  expect(tornDown).toEqual([udid]);
  expect(readIdleStage(readWorkspaceState(root))).toMatchObject({ idleMinutes: 15 });
  expect(existsSync(join(root, '.dd'))).toBe(false);
  expect(existsSync(derivedData)).toBe(false);
});

test('under disk pressure alone a workspace stopped at idle.minutes loses only the outputs on the short volume', async () => {
  const { root, udid, derivedData } = bootedWorkspace('split', 20 * MINUTE_MS);
  execSync('git init -q', { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.dd/\n');
  writeDerivedData(join(root, '.dd'));
  volume.short = { root, dev: 4_242_424 };
  const config = loadConfig();
  const devices = await collectOwnedDeviceActivityAsync(config, sims, Date.now());

  const decisions = await runIdlePass({
    config,
    now: Date.now(),
    sims,
    simsError: null,
    devices,
    act: true,
    log: () => {},
    disk: { volumes: new Set([4_242_424]) },
  });

  expect(decisions).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
  expect(tornDown).toEqual([udid]);
  expect(readIdleStage(readWorkspaceState(root))).toMatchObject({ idleMinutes: 15 });
  expect(existsSync(join(root, '.dd'))).toBe(false);
  expect(existsSync(derivedData)).toBe(true);
});

test.skipIf(process.platform === 'win32')(
  "the idle stage hands an idle Exact app's Cargo target/ to Exact's cleaner, and keeps it while a process works in the app",
  async () => {
    const { root } = bootedWorkspace('exact', 20 * MINUTE_MS);
    execSync('git init -q', { cwd: root });
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    for (const name of ['exact.mjs', 'Cargo.toml']) writeFileSync(join(root, name), '');
    mkdirSync(join(root, 'target', 'debug'), { recursive: true });
    writeFileSync(join(root, 'target', 'debug', 'app'), 'binary');

    // A process outside this test's own process family: the shell exits and leaves its background sleep behind.
    const pid = Number(execSync('sleep 60 >/dev/null 2>&1 & echo $!', { cwd: root, encoding: 'utf8' }).trim());
    try {
      const [kept] = await pass();
      expect(kept).toMatchObject({
        path: root,
        detail: expect.stringContaining(`its app may be in use: process ${pid} works in its app`),
      });
      expect(existsSync(join(root, 'target', 'debug', 'app'))).toBe(true);
    } finally {
      process.kill(pid);
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (const deadline = Date.now() + 5_000; alive() && Date.now() < deadline;) await new Promise(setImmediate);
    }

    await clearDeviceIdleShutdown(root, 'ios');
    bootedWorkspace('exact', 20 * MINUTE_MS);
    await pass();
    expect(existsSync(join(root, 'target', 'debug'))).toBe(false);
  },
);

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

test('an agent-device session whose last command is older than the idle window no longer keeps the workspace', async () => {
  bootedWorkspace('agent', 20 * MINUTE_MS);
  const old = new Date(Date.now() - 20 * MINUTE_MS).toISOString();

  const [decision] = await pass(true, (device) => ({
    ...device,
    activity: {
      state: 'driven',
      basis: ['agent-device-claim', 'agent-device-runner'],
      driver: { tool: 'agent-device', pid: 1, since: null },
      lastActivityAt: old,
      recent: { 'agent-action': old },
    },
  }));

  expect(decision?.outcome).not.toBe('kept');
});

test('an agent-device session whose commands cannot be dated keeps the workspace', async () => {
  const { root, derivedData } = bootedWorkspace('agent-undated', 20 * MINUTE_MS);

  const decisions = await pass(true, (device) => ({
    ...device,
    activity: {
      state: 'driven',
      basis: ['agent-device-claim'],
      driver: { tool: 'agent-device', pid: 1, since: null },
    },
  }));

  expect(decisions).toEqual([
    expect.objectContaining({
      path: root,
      outcome: 'kept',
      detail:
        'its simulator stim-agent-undated (iPhone 17 26.0) has a live agent-device claim whose last command cannot be dated',
    }),
  ]);
  expect(tornDown).toEqual([]);
  expect(existsSync(derivedData)).toBe(true);
});

test('another driver keeps the workspace however old its last command, naming the driver', async () => {
  const { root } = bootedWorkspace('maestro', 20 * MINUTE_MS);
  const old = new Date(Date.now() - 20 * MINUTE_MS).toISOString();

  const decisions = await pass(true, (device) => ({
    ...device,
    activity: {
      state: 'driven',
      basis: ['agent-device-claim', 'driver-process'],
      driver: { tool: 'maestro', pid: 1, since: null },
      recent: { 'agent-action': old },
    },
  }));

  expect(decisions).toEqual([
    expect.objectContaining({
      path: root,
      outcome: 'kept',
      detail: 'its simulator stim-maestro (iPhone 17 26.0) is driven by maestro',
    }),
  ]);
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

test('a pass leaves the command workspace alone', async () => {
  const left = bootedWorkspace('left', 20 * MINUTE_MS);
  const own = bootedWorkspace('own', 20 * MINUTE_MS);
  const config = loadConfig();
  const devices = await collectOwnedDeviceActivityAsync(config, sims, Date.now());

  const decisions = await runIdlePass({
    config,
    now: Date.now(),
    sims,
    simsError: null,
    devices,
    act: true,
    protectedRoot: own.root,
    log: () => {},
  });

  expect(decisions).toEqual([expect.objectContaining({ path: left.root, outcome: 'idle' })]);
  expect(tornDown).toEqual([left.udid]);
  expect(existsSync(own.derivedData)).toBe(true);
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

  test('keeps a new deferral when a handoff invalidates the stopped simulator inventory', async () => {
    const { root, udid } = bootedWorkspace('booted-during-handoff', 20 * MINUTE_MS);
    const captured = sims.map((sim) => ({ ...sim, state: 'Shutdown' as const }));
    let deferredNow = false;
    const actions = await runBootedParkedPass({
      sims: captured,
      memory: 'normal',
      all: true,
      act: true,
      log: () => {},
      operation: testContext(),
      between: async () => {
        if (deferredNow) return;
        deferredNow = true;
        await defer(root, udid, FUTURE());
      },
    });
    expect(actions).toEqual([]);
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
  test('report mode preserves deferred state without calling an owned-turn hook', async () => {
    const { root, udid } = bootedWorkspace('report-deferred', 20 * MINUTE_MS);
    await defer(root, udid, FUTURE());
    const before = readDeferredShutdowns(readWorkspaceState(root));
    const between = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const result = await runBootedParkedPass({ sims, memory: 'normal', all: true, act: false, log: () => {}, between });
    expect(result).toEqual([expect.objectContaining({ target: udid, outcome: 'would' })]);
    expect(between).not.toHaveBeenCalled();
    expect(tornDown).toEqual([]);
    expect(readDeferredShutdowns(readWorkspaceState(root))).toEqual(before);
  });

  test.skipIf(process.platform !== 'darwin').each(['new deferral', 'new server', 'abort', 'last only'] as const)(
    'a completed deferred shutdown releases its workspace before the next boundary: %s',
    async (change) => {
      const first = bootedWorkspace('first-deferred', 20 * MINUTE_MS);
      const next = change === 'last only' ? null : bootedWorkspace('next-deferred', 20 * MINUTE_MS);
      await defer(first.root, first.udid, PAST());
      if (next) await defer(next.root, next.udid, PAST());
      let finish = () => {};
      const held = new Promise<void>((done) => {
        finish = done;
      });
      const order: string[] = [];
      vi.mocked(teardown.teardownOwnedIosSim).mockImplementation(async (udid) => {
        order.push(udid);
        tornDown.push(udid);
        if (udid === first.udid) await held;
        return { status: 'torn-down', label: udid };
      });
      const controller = new AbortController();
      const reason = new Error('cancel between deferred devices');
      const owner = await acquireDisk(LADDER);
      const running = runBootedParkedPass({
        sims,
        memory: 'normal',
        all: true,
        act: true,
        log: () => {},
        operation: testContext({ signal: controller.signal }),
        between: async () => {
          await owner.boundary();
          controller.signal.throwIfAborted();
        },
      });
      const outcome = running.then(
        () => undefined,
        (error: unknown) => error,
      );
      let higher: ReturnType<typeof requestGcItem> | undefined;
      try {
        await vi.waitFor(() => expect(order).toEqual([first.udid]));
        higher = requestGcItem(async () => {
          order.push('critical');
          expect(deferred(first.root)).toEqual([]);
          expect(
            await withWorkspaceProcessLock(workspaceDir(first.root), 'native-run', async () => 'free', {
              external: true,
              waitMs: 0,
            }),
          ).toBe('free');
          if (change === 'abort') controller.abort(reason);
          else if (next && change === 'new deferral') await defer(next.root, next.udid, FUTURE());
          else if (next) upsertProject(next.root, { supervisor: { pid: process.pid, port: 59123 } });
        }, CRITICAL);
        await Promise.resolve();
        expect(order).toEqual([first.udid]);
        finish();
        expect(await outcome).toBe(change === 'abort' ? reason : undefined);
        expect(order).toEqual([first.udid, 'critical']);
        expect(tornDown).toEqual([first.udid]);
        expect(next ? deferred(next.root) : []).toEqual(change === 'new deferral' || change === 'abort' ? ['ios'] : []);
      } finally {
        finish();
        owner.release();
        await outcome;
        await higher?.result;
      }
    },
  );
});

test.skipIf(process.platform !== 'darwin')(
  'parked shutdown hands off only after its pool claim settles and rechecks adoption before the next device',
  async () => {
    const ids = ['PARKED-FIRST', 'PARKED-NEXT'];
    const real = getExecutor();
    setExecutor({ ...real, findExecutable: (name) => (name === 'agent-device' ? null : real.findExecutable(name)) });
    for (const udid of ids) {
      recordCreatedDevice('ios', udid);
      sims.push({
        udid,
        name: `stim-parked ${udid}`,
        state: 'Booted',
        runtime: 'iOS 26.0',
        deviceTypeIdentifier: 'iPhone',
        available: true,
      });
      const projectPath = join(projects, udid);
      mkdirSync(projectPath);
      upsertProject(projectPath, { platforms: { ios: { owned: true, deviceUdid: udid } } });
      parkSim({
        platform: 'ios',
        projectPath,
        max: 3,
        record: {
          udid,
          name: `stim-parked ${udid}`,
          parkedAt: new Date().toISOString(),
          bootedUntil: new Date(Date.now() + 10 * MINUTE_MS).toISOString(),
          deviceTypeIdentifier: 'iPhone',
          runtimeIdentifier: 'iOS-26-0',
          simslimManaged: false,
        },
      });
    }
    vi.spyOn(iosApi, 'listAllIosSimsAsync').mockImplementation(async () => sims);
    let finish = () => {};
    const held = new Promise<void>((done) => {
      finish = done;
    });
    const order: string[] = [];
    vi.spyOn(iosApi, 'shutdownIosSim').mockImplementation(async (udid) => {
      order.push(udid);
      if (udid === ids[0]) await held;
      const sim = sims.find((entry) => entry.udid === udid);
      if (sim) sim.state = 'Shutdown';
    });
    const config = loadConfig();
    if (!config) throw new Error('missing parked fixture config');
    const normal: DaemonPressure = {
      level: 'normal',
      disk: 'normal',
      memory: 'normal',
      reasons: [],
      memoryWarningSince: null,
    };
    const owner = await acquireDisk(LADDER);
    const run = runLadder(
      {
        config,
        sims,
        devices: [],
        simsFailed: false,
        act: true,
        log: () => {},
        operation: testContext(),
        between: owner.boundary,
        force: { level: 'high', why: 'explicit high at measured normal' },
        fromRung: 0,
        lastRung: 0,
        remeasure: async () => normal,
      },
      normal,
    );
    let higher: ReturnType<typeof requestGcItem> | undefined;
    try {
      await vi.waitFor(() => expect(order).toEqual([ids[0]]));
      higher = requestGcItem(async () => {
        order.push('critical');
        const first = ids[0];
        const next = ids[1];
        if (!first || !next) throw new Error('missing parked fixtures');
        expect(
          (
            await keepParkedAfter(
              'ios',
              first,
              async () => {},
              (record) => record,
            )
          )?.udid,
        ).toBe(first);
        expect(readParked('ios').find((record) => record.udid === first)?.bootedUntil).toBeUndefined();
        await dropParked('ios', next);
      }, CRITICAL);
      await Promise.resolve();
      expect(order).toEqual([ids[0]]);
      finish();
      const result = await run;
      expect(order).toEqual([ids[0], 'critical']);
      expect(result.actions).toEqual([expect.objectContaining({ target: ids[0], outcome: 'done' })]);
    } finally {
      finish();
      owner.release();
      await run;
      await higher?.result;
    }
  },
);
