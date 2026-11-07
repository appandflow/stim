import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonPressure } from '@stim-cli/core/state';
import { diskUsageCacheFile, IDLE_STOP_KEY, readDormantStage, readIdleStage } from '@stim-cli/core/state';
import * as gcDevices from '../commands/gc/devices.ts';
import { collectOwnedDeviceActivityAsync } from '../commands/gc/idle.ts';
import { REAL_BYTES_THRESHOLD, runDormantDependencies } from '../daemon/dependencies.ts';
import { runIdlePass } from '../daemon/idle.ts';
import { runLadder } from '../daemon/ladder.ts';
import { dormantCandidates, pendingDormant, runDormantPass } from '../daemon/stages.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { parkSim } from '../devices/sim-pool.ts';
import * as android from '../devices/android.ts';
import * as ios from '../devices/ios.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as fsUtil from '../fs-util.ts';
import { treeSignature } from '../private-size.ts';
import { writeCacheFile } from '../cache-file.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import * as lightened from '../workspace/lightened.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { serveShareList, shareRow } from './_share-list-server.ts';
import * as archive from '../archive.ts';
import { testContext } from './_context.ts';
import * as settings from '../workspace/settings.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

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

function workspace(name: string, usedAgoMs: number, state: 'Booted' | 'Shutdown', dataPathSize?: number) {
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
    ...(dataPathSize === undefined ? {} : { dataPathSize }),
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

  test.each(['plain', 'workspace'])(
    'candidate selection preserves %s settings cleanup over cancellation',
    async (kind) => {
      const root = join(projects, 'candidate-cleanup');
      mkdirSync(root);
      ensureWorkspaceStorage(root);
      upsertProject(root, {});
      recordWorkspaceUse(root, new Date(Date.now() - 4 * DAY_MS));
      mkdirSync(workspaceLogsDir(root), { recursive: true });
      writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), '{}\n');
      const failure =
        kind === 'plain'
          ? Object.assign(new Error('unverified cleanup'), { code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true })
          : new WorkspaceProcessCleanupError([], 'unverified cleanup', 'Inspect the child.');
      const controller = new AbortController();
      vi.spyOn(settings, 'resolveProjectSettingsAsync').mockImplementation(async () => {
        controller.abort();
        throw failure;
      });
      const config = loadConfig();
      if (!config) throw new Error('missing fixture config');
      await expect(
        dormantCandidates(
          config,
          { devices: [], simsFailed: false, operation: testContext({ signal: controller.signal }) },
          3 * DAY_MS,
        ),
      ).rejects.toBe(failure);
    },
  );

  test('candidate selection preserves unverified adb cleanup over cancellation', async () => {
    const root = join(projects, 'candidate-adb-cleanup');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    upsertProject(root, { platforms: { android: { owned: true, avdName: 'stim-candidate' } } });
    recordWorkspaceUse(root, new Date(Date.now() - 4 * DAY_MS));
    const failure = Object.assign(new Error('unverified cleanup'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const controller = new AbortController();
    vi.spyOn(android, 'listAdbDevicesAsync').mockImplementation(async () => {
      controller.abort();
      throw failure;
    });
    const config = loadConfig();
    if (!config) throw new Error('missing fixture config');
    await expect(
      dormantCandidates(
        config,
        { devices: [], simsFailed: false, operation: testContext({ signal: controller.signal }) },
        3 * DAY_MS,
      ),
    ).rejects.toBe(failure);
  });

  test('pending dormant check passes its operation and preserves cleanup refusal', async () => {
    const root = join(projects, 'pending-cleanup');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    upsertProject(root, {});
    recordWorkspaceUse(root, new Date());
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), '{}\n');
    const failure = Object.assign(new Error('unverified cleanup'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const controller = new AbortController();
    const operation = testContext({ signal: controller.signal });
    const probe = vi.spyOn(settings, 'resolveProjectSettingsAsync').mockImplementation(async () => {
      controller.abort();
      throw failure;
    });
    await expect(pendingDormant(loadConfig(), { simsFailed: false }, { graceMs: 0, operation })).rejects.toBe(failure);
    expect(probe).toHaveBeenCalledWith(root, { env: operation.env, signal: operation.signal, declareFor: operation });
  });

  test('passes the operation into archive and preserves cleanup refusal', async () => {
    const root = join(projects, 'archive-cleanup');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    upsertProject(root, {});
    recordWorkspaceUse(root, new Date(Date.now() - 4 * DAY_MS));
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), '{}\n');
    const operation = testContext();
    const failure = Object.assign(new Error('unverified archive cleanup'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const write = vi.spyOn(archive, 'archiveWorkspace').mockRejectedValue(failure);
    await expect(
      runDormantPass({ config: loadConfig(), act: true, log, devices: [], simsFailed: false, operation }),
    ).rejects.toBe(failure);
    expect(write).toHaveBeenCalledWith(root, 'maintenance', expect.anything(), operation);
  });

  test.skipIf(process.platform !== 'darwin')(
    'after idle.dormantDays it deletes the owned simulators, keeps node_modules and the parked pool, and records the stage',
    async () => {
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
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'it reports the data size of each device it deletes as freed, and says which size it could not count',
    async () => {
      const sized = workspace('sized', 4 * DAY_MS, 'Shutdown', 3_000_000_000);
      const unsized = workspace('unsized', 4 * DAY_MS, 'Shutdown');

      const actions = await dormant();

      const byTarget = (root: string) => actions.find((action) => action.target === root);
      expect(byTarget(sized.root)).toMatchObject({ outcome: 'done', bytes: 3_000_000_000 });
      expect(byTarget(sized.root)?.detail).not.toContain('not counted');
      expect(byTarget(unsized.root)).toMatchObject({ outcome: 'done', bytes: 0 });
      expect(byTarget(unsized.root)?.detail).toContain('freed size not counted for stim-unsized');
      expect(log).toHaveBeenCalledWith(
        'info',
        'workspace_dormant',
        expect.stringContaining(sized.root),
        expect.objectContaining({ bytes: 3_000_000_000 }),
      );
    },
  );

  test('it reports the size of an owned emulator directory measured before teardown deletes it', async () => {
    const root = join(projects, 'android');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    const avdRoot = join(home, 'avds');
    const avdDir = join(avdRoot, 'stim-droid.avd');
    mkdirSync(avdDir, { recursive: true });
    writeFileSync(join(avdRoot, 'stim-droid.ini'), `path=${avdDir}\n`);
    writeFileSync(join(avdDir, 'userdata-qemu.img'), Buffer.alloc(256 * 1024, 1));
    vi.stubEnv('ANDROID_AVD_HOME', avdRoot);
    upsertProject(root, { metroPort: 59127, platforms: { android: { avdName: 'stim-droid', owned: true } } });
    recordWorkspaceUse(root, new Date(Date.now() - 4 * DAY_MS));
    vi.spyOn(android, 'listAvdsAsync').mockResolvedValue(['stim-droid']);
    vi.spyOn(android, 'listAdbDevices').mockReturnValue({ emulators: [], physical: [], unhealthy: [] });
    recordCreatedDevice('android', 'stim-droid');
    vi.spyOn(teardown, 'teardownOwnedAvd').mockImplementation(async (name, options) => {
      rmSync(avdDir, { recursive: true, force: true });
      await options?.onRemoved?.();
      return { status: 'torn-down', label: name };
    });

    const actions = await dormant();

    expect(actions).toEqual([expect.objectContaining({ target: root, outcome: 'done' })]);
    expect(actions[0]?.bytes).toBeGreaterThanOrEqual(256 * 1024);
  });

  test('the restore hint names stim revive while the idle stop survives and no device was deleted', async () => {
    const root = join(projects, 'revivable');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    upsertProject(root, { metroPort: 59126 });
    recordWorkspaceUse(root, new Date(Date.now() - 4 * DAY_MS));
    writeWorkspaceState(root, {
      [IDLE_STOP_KEY]: { reason: 'idle', at: new Date(Date.now() - 4 * DAY_MS).toISOString(), idleMinutes: 15 },
    });
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), '{}\n');
    const other = join(projects, 'never-served');
    mkdirSync(other);
    ensureWorkspaceStorage(other);
    upsertProject(other, {});
    recordWorkspaceUse(other, new Date(Date.now() - 4 * DAY_MS));
    mkdirSync(workspaceLogsDir(other), { recursive: true });
    writeFileSync(join(workspaceLogsDir(other), 'metro.ndjson'), '{}\n');

    const actions = await dormant();

    expect(actions.map(({ target, restore }) => [target, restore])).toEqual(
      expect.arrayContaining([
        [root, 'stim revive'],
        [other, 'stim ios or stim android'],
      ]),
    );
    expect(actions.find(({ target }) => target === root)?.detail).toMatch(/stim revive resumes it\.$/);
  });

  test('a fraction of a day shortens the clock, and a Stim command since restarts it', async () => {
    saveConfig({ ...loadConfig()!, idle: { dormantDays: 0.01 } });
    const { root } = workspace('short', 20 * MINUTE_MS, 'Shutdown');
    recordWorkspaceUse(root, new Date(Date.now() - 10 * MINUTE_MS));
    expect(await dormant()).toEqual([]);
    recordWorkspaceUse(root, new Date(Date.now() - 20 * MINUTE_MS));
    expect(await dormant()).toEqual([expect.objectContaining({ target: root, outcome: 'done' })]);
  });

  test('a booted device, maintenance.keep, a live web share, or a failed simulator listing keeps a workspace out of it', async () => {
    const booted = workspace('booted', 4 * DAY_MS, 'Booted');
    const pinned = workspace('pinned', 4 * DAY_MS, 'Shutdown');
    writeFileSync(join(pinned.root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    const shared = process.platform === 'win32' ? null : workspace('shared', 4 * DAY_MS, 'Shutdown');
    if (shared) {
      const server = await serveShareList(() => ({ shares: [shareRow(shared.root, '2099-01-01T00:00:00.000Z')] }));
      onTestFinished(() => server.close());
    }
    expect(
      await runDormantPass({ config: loadConfig(), act: true, log, devices: await devicesNow(), simsFailed: false }),
    ).toEqual([]);
    const listed = workspace('unlisted', 4 * DAY_MS, 'Shutdown');
    expect(await dormant(true)).toEqual([]);
    expect(deleted).toEqual([]);
    expect(
      [booted, pinned, ...(shared ? [shared] : []), listed].every(
        ({ root }) => readDormantStage(readWorkspaceState(root)) === null,
      ),
    ).toBe(true);
  });

  test('idle.dormantDays 0 turns the dormant stage off, and idle.minutes 0 keeps a workspace out of it', async () => {
    const { root } = workspace('off', 4 * DAY_MS, 'Shutdown');
    saveConfig({ ...loadConfig()!, idle: { dormantDays: 0 } });
    expect(await dormant()).toEqual([]);
    saveConfig({ ...loadConfig()!, idle: { dormantDays: 3 } });
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ idle: { minutes: 0 } }));
    expect(await dormant()).toEqual([]);
    expect(deleted).toEqual([]);
    expect(readDormantStage(readWorkspaceState(root))).toBeNull();
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

  test('rung 1 records nothing for a stopped workspace whose only output is a Metro store a running dev server shares', async () => {
    workspace('stopped', 5 * MINUTE_MS, 'Shutdown');
    const sharer = join(projects, 'sharer');
    mkdirSync(sharer);
    upsertProject(sharer, { metroPort: 59124, supervisor: { pid: process.pid, port: 59999 } });
    const store = join(metroCache(), 'app');
    mkdirSync(store, { recursive: true });
    const { actions } = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(existsSync(store)).toBe(true);
    expect(actions.filter((action) => action.rung === 1)).toEqual([]);
  });

  test.each([
    { level: 'high' as const, kept: ['NEWER'] },
    { level: 'critical' as const, kept: [] },
  ])(
    'rung 2 at $level takes the oldest parked devices: until the level clears at high, all at critical',
    async ({ level, kept }) => {
      const sim = { deviceTypeIdentifier: 'iPhone', runtimeIdentifier: 'iOS-26-0', simslimManaged: false };
      vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
      const parked = [
        { ...sim, udid: 'NEWER', name: 'stim-newer', parkedAt: new Date(Date.now() - DAY_MS).toISOString() },
        { ...sim, udid: 'OLDER', name: 'stim-older', parkedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() },
      ];
      saveConfig({ ...loadConfig()!, parked: { ios: parked } });
      const rung2 = () =>
        log.mock.calls.filter(([, event, , fields]) => event === 'pressure_action' && fields?.rung === 2);
      const remeasure = async () => (level === 'high' && rung2().length >= 1 ? pressure('normal') : pressure(level));
      const { actions } = await runLadder(input(false, remeasure), pressure(level));
      const taken = actions.filter((action) => action.rung === 2).map((action) => action.target);
      expect(taken[0]).toBe('OLDER');
      expect(parked.map((device) => device.udid).filter((udid) => !taken.includes(udid))).toEqual(kept);
    },
  );

  test('rung 3 at high trims a cache over half its cap down to half, keeping protected entries', async () => {
    const { root } = workspace('idle-hour', 60 * MINUTE_MS, 'Shutdown');
    writeWorkspaceState(root, { lastBuild: { cacheKey: 'kept-key' } });
    for (const key of ['kept-key', 'unused']) {
      const entry = join(buildCache(), 'ios', key);
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, 'App.app'), 'x');
      const at = (Date.now() - 3 * 60 * MINUTE_MS) / 1000;
      utimesSync(entry, at, at);
    }
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
    vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockResolvedValue(10 * 1024 ** 3);
    const { actions } = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(actions).toContainEqual(expect.objectContaining({ rung: 3, kind: 'trim-cache', target: buildCache() }));
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(false);
    expect(existsSync(join(buildCache(), 'ios', 'kept-key'))).toBe(true);
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

  test('under memory pressure rung 0 shuts down a parked simulator kept booted, and touches no workspace device', async () => {
    const { udid } = workspace('in-use', 60 * MINUTE_MS, 'Booted');
    sims.push({
      udid: 'PARKED',
      name: 'stim-parked (iPhone 17 26.0) park',
      state: 'Booted',
      runtime: 'iOS 26.0',
      deviceTypeIdentifier: 'iPhone',
      available: true,
    });
    saveConfig({
      ...(loadConfig() ?? { version: 2, projects: {}, repos: {} }),
      parked: {
        ios: [
          {
            udid: 'PARKED',
            name: 'stim-parked (iPhone 17 26.0) park',
            deviceTypeIdentifier: 'iPhone',
            runtimeIdentifier: 'iOS 26.0',
            parkedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
            bootedUntil: new Date(Date.now() + 10 * MINUTE_MS).toISOString(),
            simslimManaged: false,
          },
        ],
      },
    });
    const shutDown = vi
      .spyOn(teardown, 'shutDownBootedParkedIosSim')
      .mockResolvedValue({ status: 'torn-down', label: 'stim-parked' });
    const { actions } = await runLadder(
      { ...input(true, async () => pressure('high', 'memory')), sims },
      pressure('high', 'memory'),
    );
    expect(actions).toEqual([
      expect.objectContaining({ rung: 0, kind: 'shut-down-parked-device', target: 'PARKED', outcome: 'done' }),
    ]);
    expect(shutDown).toHaveBeenCalledTimes(1);
    expect(teardown.teardownOwnedIosSim).not.toHaveBeenCalledWith(udid, expect.anything());
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
    const rungs = actions.map((action) => action.rung);
    expect(rungs).toEqual(rungs.toSorted((a, b) => a - b));
    expect(actions.some((action) => action.rung === 4 && action.kind === 'dormant-stage')).toBe(true);
  });
});

describe('the ladder stim gc forces', () => {
  test('runs every rung at the forced level whatever the measured level, and gc --older-than limits rung 2 to devices parked that long', async () => {
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    for (const [udid, days] of [
      ['OLD-PARKED', 10],
      ['NEW-PARKED', 1],
    ] as const) {
      const source = join(projects, `source-${udid}`);
      mkdirSync(source, { recursive: true });
      upsertProject(source, { platforms: { ios: { deviceUdid: udid, deviceName: `stim-${udid}`, owned: true } } });
      parkSim({
        platform: 'ios',
        projectPath: source,
        max: 3,
        record: {
          udid,
          name: `stim-${udid}`,
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
          deviceTypeIdentifier: 'iphone',
          simslimManaged: false,
          parkedAt: new Date(Date.now() - days * DAY_MS).toISOString(),
        },
      });
    }
    const parkedTargets = async (parkedOlderThanDays?: number) =>
      (
        await runLadder(
          {
            config: loadConfig()!,
            act: false,
            log,
            devices: [],
            simsFailed: false,
            remeasure: async () => pressure('normal'),
            force: { level: 'high', why: 'stim gc --delete', ...(parkedOlderThanDays ? { parkedOlderThanDays } : {}) },
            fromRung: 2,
          },
          pressure('normal'),
        )
      ).actions.flatMap((action) => (action.kind === 'delete-parked-device' ? [action.target] : []));

    expect(await parkedTargets()).toEqual(['OLD-PARKED', 'NEW-PARKED']);
    expect(await parkedTargets(5)).toEqual(['OLD-PARKED']);
  });
});

describe('rung 5', () => {
  const HOUR_MS = 60 * MINUTE_MS;

  beforeEach(() => {
    resetExecutor();
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileQuiet: (file, args, opts) =>
        file === 'git' ? real.runFileQuiet(file, args, opts) : file === 'ps' ? '' : null,
      runFileQuietAsync: async (file, args, opts) =>
        file === 'ps'
          ? `${process.pid} node\n`
          : file === 'lsof'
            ? `p${process.pid}\nn${tmpdir()}\n`
            : real.runFileQuietAsync(file, args, opts),
    });
  });

  function linkedWorktrees<const N extends string>(names: readonly N[]): Record<N, string> {
    const repo = join(projects, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (args: string, cwd = repo) =>
      execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
    git('init -q -b main');
    git('config user.email test@example.com');
    git('config user.name test');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nios/Pods/\n');
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    mkdirSync(join(repo, 'ios'));
    writeFileSync(join(repo, 'ios', 'Podfile.lock'), 'PODFILE CHECKSUM: 1\n');
    git('add -A');
    git('commit -q -m init');
    for (const root of [repo]) {
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'pkg', 'file'), 'x');
      mkdirSync(join(root, 'ios', 'Pods'), { recursive: true });
      writeFileSync(join(root, 'ios', 'Pods', 'Manifest.lock'), 'PODFILE CHECKSUM: 1\n');
    }
    const roots = {} as Record<N, string>;
    for (const name of names) {
      git(`worktree add -q "${join(projects, name)}" -b ${name}`);
      const root = realpathSync.native(join(projects, name));
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'pkg', 'file'), 'x');
      mkdirSync(join(root, 'ios', 'Pods'), { recursive: true });
      writeFileSync(join(root, 'ios', 'Pods', 'Manifest.lock'), 'PODFILE CHECKSUM: 1\n');
      roots[name] = root;
    }
    return roots;
  }

  function register(root: string, record: Parameters<typeof upsertProject>[1] = { metroPort: null }) {
    upsertProject(root, record);
    ensureWorkspaceStorage(root);
    recordWorkspaceUse(root, new Date(Date.now() - HOUR_MS));
  }

  const ladder = (level: 'high' | 'critical', protectedRoot?: string) =>
    runLadder(
      {
        config: loadConfig()!,
        act: true,
        log,
        devices: [],
        simsFailed: false,
        remeasure: async () => pressure(level),
        fromRung: 5,
        ...(protectedRoot ? { protectedRoot } : {}),
      },
      pressure(level),
    );

  test('at critical it keeps node_modules and Pods of an idle linked worktree while the running processes cannot be listed, as on win32', async () => {
    const listed = getExecutor();
    setExecutor({
      ...listed,
      runFileQuietAsync: async (file, args, opts) =>
        file === 'ps' ? null : listed.runFileQuietAsync(file, args, opts),
    });
    const { idle } = linkedWorktrees(['idle']);
    register(idle);
    const { actions } = await ladder('critical');
    expect(existsSync(join(idle, 'node_modules'))).toBe(true);
    expect(existsSync(join(idle, 'ios', 'Pods'))).toBe(true);
    expect(actions.filter((action) => action.rung === 5)).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')(
    'with the running processes listed (skipped on win32, where Stim cannot list them)',
    () => {
      test('at critical it deletes node_modules and Pods of an idle linked worktree in one tick, and nothing at high', async () => {
        const { idle } = linkedWorktrees(['idle']);
        register(idle);
        await ladder('high');
        expect(existsSync(join(idle, 'node_modules'))).toBe(true);
        const { actions } = await ladder('critical');
        expect(existsSync(join(idle, 'node_modules'))).toBe(false);
        expect(existsSync(join(idle, 'ios', 'Pods'))).toBe(false);
        expect(actions.filter((action) => action.rung === 5).map((action) => action.outcome)).toEqual(['done', 'done']);
      });

      test('it keeps a worktree used a minute ago, and one used between selection and deletion', async () => {
        const { recent, late } = linkedWorktrees(['recent', 'late']);
        register(recent);
        recordWorkspaceUse(recent, new Date(Date.now() - MINUTE_MS));
        register(late);
        const restoreProblem = lightened.restoreProblem;
        vi.spyOn(lightened, 'restoreProblem').mockImplementation(async (candidate, ...rest) => {
          if (candidate.worktree === late) recordWorkspaceUse(late);
          return restoreProblem(candidate, ...rest);
        });
        const { actions } = await ladder('critical');
        for (const root of [recent, late]) expect(existsSync(join(root, 'node_modules'))).toBe(true);
        const rung5 = actions.filter((action) => action.rung === 5);
        expect(rung5.filter((action) => action.workspace === recent)).toEqual([]);
        expect(rung5.find((action) => action.workspace === late)).toMatchObject({
          outcome: 'kept',
          detail: 'it is no longer idle',
        });
      });

      function measured(path: string, privateBytes: number, signature = treeSignature(path)) {
        writeCacheFile(diskUsageCacheFile(path), {
          path,
          measuredAt: new Date().toISOString(),
          bytes: 2 * 1024 ** 3,
          privateBytes,
          signature,
        });
      }

      test('at critical it keeps a clone under the private-bytes threshold and deletes the rest, most private first, unknown last', async () => {
        const { clone, reinstalled, unknown } = linkedWorktrees(['clone', 'reinstalled', 'unknown']);
        for (const root of [clone, reinstalled, unknown]) register(root);
        measured(join(clone, 'node_modules'), REAL_BYTES_THRESHOLD - 1);
        measured(join(clone, 'ios', 'Pods'), REAL_BYTES_THRESHOLD);
        measured(join(reinstalled, 'node_modules'), 2 * REAL_BYTES_THRESHOLD);
        measured(join(reinstalled, 'ios', 'Pods'), 3 * REAL_BYTES_THRESHOLD, 'an older install');

        const rung5 = (await ladder('critical')).actions.filter((action) => action.rung === 5);

        expect(existsSync(join(clone, 'node_modules'))).toBe(true);
        const outcomes = rung5.map(({ target, outcome }) => [target, outcome]);
        expect(outcomes.slice(0, 3)).toEqual([
          [join(clone, 'node_modules'), 'kept'],
          [join(reinstalled, 'node_modules'), 'done'],
          [join(clone, 'ios', 'Pods'), 'done'],
        ]);
        expect(outcomes.slice(3).toSorted()).toEqual(
          [join(reinstalled, 'ios', 'Pods'), join(unknown, 'ios', 'Pods'), join(unknown, 'node_modules')].map(
            (target) => [target, 'done'],
          ),
        );
      }, 20_000);

      test("it skips a worktree with no workspace in this home, the command's own workspace and one whose dev server runs", async () => {
        const { stranger, own, serving } = linkedWorktrees(['stranger', 'own', 'serving']);
        register(realpathSync.native(join(projects, 'repo')));
        register(own);
        register(serving, { metroPort: 59125, supervisor: { pid: process.pid, port: 59999 } });
        const { actions } = await ladder('critical', own);
        for (const root of [stranger, own, serving]) expect(existsSync(join(root, 'node_modules'))).toBe(true);
        expect(actions.filter((action) => action.rung === 5)).toEqual([]);
      });
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'the dormant stage for dependencies (skipped on win32, where Stim cannot list the running processes)',
  () => {
    test('after idle.dormantDays it deletes a tree holding its own bytes and keeps a tree of unknown size and a workspace idle less long', async () => {
      vi.setSystemTime(Date.now() + 2 * DAY_MS);
      resetExecutor();
      const real = getExecutor();
      setExecutor({
        ...real,
        runFileQuiet: (file, args, opts) =>
          file === 'git' ? real.runFileQuiet(file, args, opts) : file === 'ps' ? '' : null,
        runFileQuietAsync: async (file, args, opts) =>
          file === 'ps' ? `${process.pid} node\n` : real.runFileQuietAsync(file, args, opts),
      });
      const repo = join(projects, 'repo');
      mkdirSync(join(repo, 'ios'), { recursive: true });
      const git = (args: string) => execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8', timeout: 15_000 });
      git('init -q -b main');
      git('config user.email test@example.com');
      git('config user.name test');
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\nios/Pods/\n');
      writeFileSync(join(repo, 'package.json'), '{}');
      writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      writeFileSync(join(repo, 'ios', 'Podfile.lock'), 'PODFILE CHECKSUM: 1\n');
      git('add -A');
      git('commit -q -m init');
      const trees = (root: string) => [join(root, 'node_modules'), join(root, 'ios', 'Pods')];
      for (const tree of trees(repo)) mkdirSync(join(tree, 'pkg'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', 'pkg', 'file'), 'x');
      writeFileSync(join(repo, 'ios', 'Pods', 'Manifest.lock'), 'PODFILE CHECKSUM: 1\n');
      const worktree = (name: string) => {
        git(`worktree add -q "${join(projects, name)}" -b ${name}`);
        const root = realpathSync.native(join(projects, name));
        for (const tree of trees(root)) mkdirSync(join(tree, 'pkg'), { recursive: true });
        writeFileSync(join(root, 'node_modules', 'pkg', 'file'), 'x');
        writeFileSync(join(root, 'ios', 'Pods', 'Manifest.lock'), 'PODFILE CHECKSUM: 1\n');
        upsertProject(root, { metroPort: null });
        ensureWorkspaceStorage(root);
        return root;
      };
      const old = worktree('old');
      const recent = worktree('recent');
      recordWorkspaceUse(old, new Date(Date.now() - 4 * DAY_MS));
      recordWorkspaceUse(recent, new Date(Date.now() - DAY_MS));
      const cache = (path: string, privateBytes: number) =>
        writeCacheFile(diskUsageCacheFile(path), {
          path,
          measuredAt: new Date().toISOString(),
          bytes: 2 * 1024 ** 3,
          privateBytes,
          signature: treeSignature(path),
        });
      cache(join(old, 'node_modules'), 2 * REAL_BYTES_THRESHOLD);
      cache(join(recent, 'node_modules'), 2 * REAL_BYTES_THRESHOLD);

      const actions = await runDormantDependencies({
        config: loadConfig(),
        act: true,
        log,
        devices: [],
        simsFailed: false,
      });

      expect(actions).toEqual([
        expect.objectContaining({
          rung: 4,
          kind: 'delete-dependencies',
          target: join(old, 'node_modules'),
          outcome: 'done',
          restore: 'stim worktree warm',
        }),
      ]);
      expect(existsSync(join(old, 'node_modules'))).toBe(false);
      expect(existsSync(join(old, 'ios', 'Pods'))).toBe(true);
      expect(existsSync(join(recent, 'node_modules'))).toBe(true);
    }, 20_000);
  },
);
