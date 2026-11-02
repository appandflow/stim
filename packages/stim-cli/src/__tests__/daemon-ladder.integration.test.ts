import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonPressure } from '@stim-cli/core/state';
import { readDormantStage, readIdleStage } from '@stim-cli/core/state';
import { collectOwnedDeviceActivityAsync } from '../commands/gc/idle.ts';
import { runIdlePass } from '../daemon/idle.ts';
import { runLadder } from '../daemon/ladder.ts';
import { runDormantPass } from '../daemon/stages.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import * as ios from '../devices/ios.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let home: string;
let projects: string;
let sims: IosSimRecord[];
let deleted: string[];
const log = vi.fn<(level: string, event: string, msg: string, fields?: Record<string, unknown>) => void>();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ladder-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ladder-projects-')));
  process.env.STIM_HOME = home;
  vi.stubEnv('HOME', home);
  const real = getExecutor();
  setExecutor({ ...real, runFileQuiet: (file) => (file === 'ps' ? '' : null) });
  saveConfig({ version: 2, projects: {}, repos: {} });
  sims = [];
  deleted = [];
  log.mockReset();
  vi.spyOn(ios, 'listAllIosSimsAsync').mockImplementation(async () => sims);
  vi.spyOn(teardown, 'teardownOwnedIosSim').mockImplementation(async (udid, options) => {
    if (options?.del) deleted.push(udid);
    const sim = sims.find((entry) => entry.udid === udid);
    if (sim) sim.state = 'Shutdown';
    if (options?.del) sims = sims.filter((entry) => entry.udid !== udid);
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

function workspace(name: string, usedAgoMs: number, state: 'Booted' | 'Shutdown') {
  const root = join(projects, name);
  const udid = `UDID-${name}`;
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  ensureWorkspaceStorage(root);
  upsertProject(root, { metroPort: 59123, platforms: { ios: { deviceUdid: udid, owned: true } } });
  recordCreatedDevice('ios', udid);
  recordWorkspaceUse(root, new Date(Date.now() - usedAgoMs));
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');
  sims.push({
    udid,
    name: `stim-${name} (iPhone 17 26.0)`,
    state,
    runtime: 'iOS 26.0',
    deviceTypeIdentifier: 'iPhone',
    available: true,
  });
  return { root, udid };
}

const pressure = (level: DaemonPressure['level'], cause: 'disk' | 'memory' = 'disk'): DaemonPressure => ({
  level,
  disk: cause === 'disk' ? level : 'normal',
  memory: cause === 'memory' ? level : 'normal',
  reasons: [`fixture ${cause} ${level}`],
  memoryWarningSince: null,
});

const devicesNow = () => collectOwnedDeviceActivityAsync(loadConfig(), sims, Date.now());

describe('the idle stage under pressure (rung 1)', () => {
  test('takes a workspace idle 2 minutes at high pressure, which idle.minutes keeps running at normal', async () => {
    const { root } = workspace('recent', 5 * MINUTE_MS, 'Booted');
    const input = { config: loadConfig(), now: Date.now(), sims, simsError: null, act: true, log };
    expect(await runIdlePass({ ...input, devices: await devicesNow() })).toEqual([
      expect.objectContaining({ path: root, outcome: 'active' }),
    ]);
    const decisions = await runIdlePass({
      ...input,
      devices: await devicesNow(),
      pressure: { level: 'high', reasons: ['fixture'] },
    });
    expect(decisions).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
    expect(readIdleStage(readWorkspaceState(root))).toMatchObject({ idleMinutes: 2 });
  });
});

describe('the dormant stage', () => {
  const dormant = (simsFailed = false) =>
    runDormantPass({ config: loadConfig(), act: true, log, devices: [], simsFailed });

  test('after idle.dormantDays it deletes the owned devices, keeps node_modules and the parked pool, and records the stage', async () => {
    const { root, udid } = workspace('old', 4 * DAY_MS, 'Shutdown');
    const parked = { udid: 'PARKED', name: 'stim-parked', parkedAt: new Date(0).toISOString() };
    saveConfig({ ...loadConfig()!, parked: { ios: [parked] } });

    const actions = await dormant();

    expect(actions).toEqual([
      expect.objectContaining({ rung: 4, kind: 'dormant-stage', target: root, outcome: 'done' }),
    ]);
    expect(deleted).toEqual([udid]);
    expect(getProject(root)?.platforms?.ios?.deviceUdid).toBeUndefined();
    expect(loadConfig()?.parked).toEqual({ ios: [parked] });
    expect(existsSync(join(root, 'node_modules'))).toBe(true);
    expect(readDormantStage(readWorkspaceState(root))).toMatchObject({
      dormantDays: 3,
      deletedDevices: ['stim-old (iPhone 17 26.0)'],
    });
    expect(log).toHaveBeenCalledWith('info', 'workspace_dormant', expect.stringContaining(root), expect.anything());

    deleted = [];
    expect(await dormant()).toEqual([]);
  });

  test('a fraction of a day shortens the clock, and a Stim command since restarts it', async () => {
    saveConfig({ ...loadConfig()!, idle: { dormantDays: 0.01 } });
    const { root } = workspace('short', 20 * MINUTE_MS, 'Shutdown');
    recordWorkspaceUse(root, new Date(Date.now() - 10 * MINUTE_MS));
    expect(await dormant()).toEqual([]);
    recordWorkspaceUse(root, new Date(Date.now() - 20 * MINUTE_MS));
    expect(await dormant()).toEqual([expect.objectContaining({ target: root, outcome: 'done' })]);
  });

  test('a booted device, maintenance.keep, or a failed simulator listing keeps a workspace out of it', async () => {
    const booted = workspace('booted', 4 * DAY_MS, 'Booted');
    const pinned = workspace('pinned', 4 * DAY_MS, 'Shutdown');
    writeFileSync(join(pinned.root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    expect(
      await runDormantPass({ config: loadConfig(), act: true, log, devices: await devicesNow(), simsFailed: false }),
    ).toEqual([]);
    const listed = workspace('unlisted', 4 * DAY_MS, 'Shutdown');
    expect(await dormant(true)).toEqual([]);
    expect(deleted).toEqual([]);
    expect([booted, pinned, listed].every(({ root }) => readDormantStage(readWorkspaceState(root)) === null)).toBe(
      true,
    );
  });
});

describe('the pressure ladder', () => {
  const buildCache = () => join(home, 'build-cache');
  const metroCache = () => join(home, 'metro-cache');
  const memo = () => join(home, 'fingerprint-memo');
  const old = (path: string) => {
    const at = (Date.now() - 2 * 60 * MINUTE_MS) / 1000;
    utimesSync(path, at, at);
  };

  function caches(protectedKey: string) {
    for (const key of [protectedKey, 'unused']) {
      const entry = join(buildCache(), 'ios', key);
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, 'App.app'), 'x'.repeat(1024));
      old(entry);
    }
    const transform = join(metroCache(), 'other-app', 'transform', 'aa');
    mkdirSync(transform, { recursive: true });
    writeFileSync(join(transform, 'file'), 'x');
    old(transform);
    mkdirSync(join(memo(), 'ios'), { recursive: true });
    writeFileSync(join(memo(), 'ios', 'digest.json'), '{}');
  }

  const input = (act = true, remeasure = async () => pressure('normal')) => ({
    config: loadConfig()!,
    act,
    log,
    devices: [],
    simsFailed: false,
    remeasure,
  });

  test('at critical it trims caches in rung order and stops once the level clears, before the dormant rung', async () => {
    const { root } = workspace('idle-hour', 60 * MINUTE_MS, 'Shutdown');
    writeWorkspaceState(root, { lastBuild: { cacheKey: 'kept-key' } });
    caches('kept-key');
    const remeasure = async () =>
      existsSync(join(metroCache(), 'other-app', 'transform', 'aa')) ? pressure('critical') : pressure('normal');

    const { actions } = await runLadder(input(true, remeasure), pressure('critical'));

    expect(existsSync(join(buildCache(), 'ios', 'kept-key'))).toBe(true);
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(false);
    expect(existsSync(join(metroCache(), 'other-app', 'transform', 'aa'))).toBe(false);
    expect(existsSync(memo())).toBe(true);
    expect(actions.map((action) => [action.rung, action.kind, action.outcome])).toEqual([
      [3, 'empty-cache', 'done'],
      [3, 'empty-cache', 'done'],
    ]);
    expect(deleted).toEqual([]);
  });

  test('at high disk pressure rung 1 deletes the outputs of a stopped workspace idle 2 minutes, not of one used since', async () => {
    const outputs = (name: string, usedAgoMs: number) => {
      const { root } = workspace(name, usedAgoMs, 'Shutdown');
      const dir = join(workspaceDir(root), 'derived-data');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'Build.o'), 'x'.repeat(4096));
      return dir;
    };
    const idle = outputs('idle-five', 5 * MINUTE_MS);
    const recent = outputs('recent', MINUTE_MS);
    const { actions } = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(actions).toContainEqual(
      expect.objectContaining({ rung: 1, kind: 'delete-build-outputs', outcome: 'done', bytes: expect.any(Number) }),
    );
    expect(deleted).toEqual([]);
  });

  test('a memory-only level never trims a cache or deletes a device', async () => {
    workspace('idle-hour', 60 * MINUTE_MS, 'Shutdown');
    caches('kept-key');
    const { actions } = await runLadder(
      input(true, async () => pressure('critical', 'memory')),
      pressure('critical', 'memory'),
    );
    expect(actions).toEqual([]);
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(true);
    expect(deleted).toEqual([]);
  });

  test('daemon.mode report plans each rung and deletes nothing', async () => {
    const { udid } = workspace('idle-hour', 60 * MINUTE_MS, 'Shutdown');
    caches('kept-key');
    const { actions } = await runLadder(
      input(false, async () => pressure('critical')),
      pressure('critical'),
    );
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(true);
    expect(existsSync(join(metroCache(), 'other-app', 'transform', 'aa'))).toBe(true);
    expect(existsSync(memo())).toBe(true);
    expect(sims.some((sim) => sim.udid === udid)).toBe(true);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.outcome === 'would')).toBe(true);
    expect(actions.map((action) => action.rung)).toEqual([...actions.map((action) => action.rung)].sort());
    expect(actions.some((action) => action.rung === 4 && action.kind === 'dormant-stage')).toBe(true);
  });
});
