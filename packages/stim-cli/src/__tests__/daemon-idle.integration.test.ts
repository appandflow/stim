import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_METRO_IDLE_STOP_REASON,
  INTERACTIONS_KEY,
  readDeviceIdleShutdowns,
  readIdleStage,
} from '@stim-cli/core/state';
import { collectOwnedDeviceActivityAsync } from '../commands/gc/idle.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runIdlePass } from '../daemon/idle.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';

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

async function pass(act = true) {
  const config = loadConfig();
  const devices = await collectOwnedDeviceActivityAsync(config, sims, Date.now());
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
  expect(readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf8')).toContain('"event":"workspace_idle"');
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

test('maintenance.keep keeps an idle workspace out of the idle stage', async () => {
  const { root } = bootedWorkspace('pinned', 20 * MINUTE_MS);
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));

  expect(await pass()).toEqual([expect.objectContaining({ outcome: 'kept', detail: 'pinned by maintenance.keep' })]);
  expect(tornDown).toEqual([]);
});
