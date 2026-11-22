import * as runningFrom from '../workspace/running-from.ts';
import * as inventory from '../commands/gc/inventory.ts';
import * as cargoLocks from '../workspace/cargo-lock.ts';
import { ladderRun } from '../stimd/passes/ladder-run.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { realpath as nativeRealpath } from 'node:fs/promises';
import * as protectedLocations from '../workspace/protected-locations.ts';
import type { MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { DaemonLadderAction, DaemonPressure } from '@stim-cli/core/state';
import {
  daemonNdjsonFile,
  diskUsageCacheFile,
  gcMarkFile,
  readGcMark,
  IDLE_STOP_KEY,
  readDormantStage,
  readIdleStage,
  readJsonObject,
  workspaceLightenedFile,
} from '@stim-cli/core/state';
import * as checkoutDiscovery from '../workspace/discovery.ts';
import * as artifactPasses from '../stimd/passes/artifacts.ts';
import * as cacheModule from '../cache/caches.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import { recordGcResult } from '../commands/gc/results.ts';
import { collectOwnedDeviceActivityAsync, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { REAL_BYTES_THRESHOLD, runDormantDependencies } from '../daemon/dependencies.ts';
import { runIdlePass } from '../daemon/idle.ts';
import { runLadder } from '../daemon/ladder.ts';
import * as acting from '../stimd/passes/act.ts';
import * as cargoTargetPasses from '../stimd/passes/cargo-target.ts';
import * as dependencies from '../daemon/dependencies.ts';
import * as sweep from '../stimd/passes/sweep.ts';
import * as unowned from '../stimd/passes/unowned.ts';
import { runDiskPass, runForcedLadder, runHomePasses, runLadderToFree, type LadderPass } from '../daemon/passes.ts';
import * as ladderModule from '../daemon/ladder.ts';
import * as bootedParked from '../daemon/booted-parked.ts';
import * as idlePass from '../daemon/idle.ts';
import * as stages from '../daemon/stages.ts';
import * as marks from '../daemon/marks.ts';
import { dormantCandidates, pendingDormant, runDormantPass } from '../daemon/stages.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { parkSim, readParked } from '../devices/sim-pool.ts';
import * as android from '../devices/android.ts';
import * as simPool from '../devices/sim-pool.ts';
import * as ios from '../devices/ios.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as fsUtil from '../fs-util.ts';
import { treeSignature } from '../private-size.ts';
import { writeCacheFile } from '../cache-file.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { serveShareList, shareRow } from './_share-list-server.ts';
import * as archive from '../archive.ts';
import { testContext } from './_context.ts';
import * as settings from '../workspace/settings.ts';
import { withWorkspaceProcessLock, WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import {
  acquireDisk,
  requestGcItem,
  requestGcPass,
  CRITICAL,
  HARD_FLOOR,
  LADDER,
  LADDER_CLOCK_SLOTS,
} from '../daemon/disk-owner.ts';
import * as daemonMeasure from '../daemon/measure.ts';
import * as diskBudget from '../stimd/passes/budget.ts';

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
  vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([{ volume: '/', freeMb: 1024, device: statSync(home).dev }]);
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

const GIB = 1024 ** 3;
const recordSize = (path: string, bytes: number, at = new Date()) =>
  writeCacheFile(diskUsageCacheFile(path), { path, measuredAt: at.toISOString(), bytes });

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

  function tick(
    cause: 'disk' | 'memory' | 'both',
    drive: (device: OwnedDeviceActivity) => OwnedDeviceActivity = (device) => device,
  ) {
    const disk = [{ volume: '/', freeMb: (cause === 'memory' ? 500 : 30) * 1024, device: statSync(home).dev }];
    const memory = {
      level: 'normal' as const,
      availableBytes: (cause === 'disk' ? 8 : 1) * 1024 ** 3,
      totalBytes: 16 * 1024 ** 3,
    };
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue(disk);
    vi.spyOn(daemonMeasure, 'measureMemory').mockResolvedValue(memory);
    vi.spyOn(daemonMeasure, 'measureTick').mockImplementation(async () => ({
      measurement: { disk, memory, load1: 0, cores: 8, bootedSimulators: 1, runningEmulators: null, interaction: null },
      sims,
      simsError: null,
      devices: (await devicesNow()).map(drive),
    }));
  }

  function withOutputs(name: string, usedAgoMs: number) {
    const { root, udid } = workspace(name, usedAgoMs, 'Booted');
    const outputs = join(workspaceDir(root), 'derived-data');
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(outputs, 'Build.o'), 'x'.repeat(4096));
    return { root, udid, outputs };
  }

  test.each([
    { cause: 'disk' as const, outcome: 'active', state: 'Booted', idleMinutes: null },
    { cause: 'memory' as const, outcome: 'idle', state: 'Shutdown', idleMinutes: 2 },
  ])('at high $cause pressure a workspace idle 3 minutes is stopped only for memory', async (row) => {
    const { root, udid, outputs } = withOutputs('running', 3 * MINUTE_MS);
    tick(row.cause);

    const passes = await runHomePasses({ act: true, log });

    expect(passes.workspaces).toEqual([expect.objectContaining({ path: root, outcome: row.outcome })]);
    expect(readIdleStage(readWorkspaceState(root))?.idleMinutes ?? null).toBe(row.idleMinutes);
    expect(sims.find((sim) => sim.udid === udid)?.state).toBe(row.state);
    expect(existsSync(outputs)).toBe(row.state === 'Booted');
  });

  test('a forced stim gc --pressure high with memory normal stops a workspace only past idle.minutes', async () => {
    const recent = withOutputs('recent', 3 * MINUTE_MS);
    const old = withOutputs('old', 20 * MINUTE_MS);
    tick('disk');

    const ladder = await runForcedLadder({ levels: ['high'], act: true, why: 'stim gc at high', trigger: 'gc' });

    expect(ladder?.levels[0]?.actions.filter((action) => action.kind === 'idle-stage')).toEqual([
      expect.objectContaining({ target: old.root, outcome: 'done' }),
    ]);
    expect(readIdleStage(readWorkspaceState(recent.root))).toBeNull();
    expect(sims.find((sim) => sim.udid === recent.udid)?.state).toBe('Booted');
    expect(existsSync(recent.outputs)).toBe(true);
    expect(readIdleStage(readWorkspaceState(old.root))).toMatchObject({ idleMinutes: 15 });
    expect(existsSync(old.outputs)).toBe(false);
  });

  test("a forced stim gc --pressure high keeps the caller's own idle workspace", async () => {
    const caller = withOutputs('caller', 20 * MINUTE_MS);
    tick('disk');

    const ladder = await runForcedLadder({
      levels: ['high'],
      act: true,
      why: 'stim gc at high',
      trigger: 'gc',
      protectedRoot: caller.root,
    });

    expect(ladder?.levels[0]?.actions.filter((action) => action.kind === 'idle-stage')).toEqual([]);
    expect(sims.find((sim) => sim.udid === caller.udid)?.state).toBe('Booted');
    expect(existsSync(caller.outputs)).toBe(true);
  });

  test.each(['the daemon tick', 'a forced stim gc'])(
    'under disk pressure alone with idle.minutes 5, %s keeps a workspace whose agent-device command was 6 minutes ago',
    async (path) => {
      const { root, udid } = withOutputs('agent', 20 * MINUTE_MS);
      writeFileSync(join(root, '.stim.json'), JSON.stringify({ idle: { minutes: 5 } }));
      const at = new Date(Date.now() - 6 * MINUTE_MS).toISOString();
      tick('disk', (device) => ({
        ...device,
        activity: { ...device.activity, recent: { ...device.activity.recent, 'agent-action': at } },
      }));

      if (path === 'the daemon tick') await runHomePasses({ act: true, log });
      else
        await runForcedLadder({ levels: ['high'], act: true, why: 'stim gc at high', trigger: 'gc', measured: true });

      expect(readIdleStage(readWorkspaceState(root))).toBeNull();
      expect(sims.find((sim) => sim.udid === udid)?.state).toBe('Booted');
    },
  );

  test('a stim gc --dry-run under memory and disk pressure counts a running workspace outputs once', async () => {
    const { root } = withOutputs('running', 3 * MINUTE_MS);
    tick('both');

    const ladder = await runForcedLadder({ levels: ['high'], act: false, why: 'stim gc at high', trigger: 'gc' });

    const mine = ladder?.levels[0]?.actions.filter((action) => action.target === root) ?? [];
    expect(mine).toEqual([expect.objectContaining({ kind: 'idle-stage', outcome: 'would' })]);
    expect(mine[0]?.bytes).toBeGreaterThanOrEqual(4096);
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
        dormantDays: 1,
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

  test('the restore hint names stim revive while the idle stop or a native-process launch survives and no device was deleted', async () => {
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

    const native = join(projects, 'native-process');
    mkdirSync(native);
    ensureWorkspaceStorage(native);
    upsertProject(native, {});
    recordWorkspaceUse(native, new Date(Date.now() - 4 * DAY_MS));
    writeWorkspaceState(native, {
      launches: {
        ios: {
          appId: 'com.example.exact',
          deviceId: 'U9',
          metroPort: null,
          release: false,
          runtime: 'process',
          launchedAt: new Date(Date.now() - 4 * DAY_MS).toISOString(),
        },
      },
    });
    mkdirSync(workspaceLogsDir(native), { recursive: true });
    writeFileSync(join(workspaceLogsDir(native), 'metro.ndjson'), '{}\n');

    const actions = await dormant();

    expect(actions.map(({ target, restore }) => [target, restore])).toEqual(
      expect.arrayContaining([
        [root, 'stim revive'],
        [other, 'stim ios or stim android'],
        [native, 'stim revive'],
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
  const memo = () => join(home, 'fingerprint');
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

  async function cargoApp(name = 'rust-app') {
    vi.stubEnv('STIM_DISK_MIN_FREE_GB', '100000000');
    vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '0');
    vi.stubEnv('STIM_DISK_HARD_FLOOR_GB', '0');
    const app = join(projects, name);
    mkdirSync(join(app, 'ios', 'App.xcodeproj'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(app, '.gitignore'), 'target/\n');
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['commit', '-q', '-m', 'init'],
    ])
      execSync(`git -C ${app} -c user.name=t -c user.email=t@t ${args.join(' ')}`);
    const target = join(app, 'target');
    const incremental = join(target, 'debug', 'incremental');
    const fill = () => {
      mkdirSync(join(target, 'debug', '.fingerprint'), { recursive: true });
      writeFileSync(join(target, 'debug', '.cargo-lock'), '');
      mkdirSync(incremental, { recursive: true });
      writeFileSync(join(incremental, 'data'), 'x'.repeat(50_000));
    };
    fill();
    writeFileSync(join(target, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    upsertProject(app, { metroPort: null });
    const config = loadConfig();
    if (!config) throw new Error('missing fixture config');
    await marks.markWriter(config)({ path: app, at: Date.now(), lastActivityAt: null, kept: null });
    return { app, target, incremental, fill };
  }

  test('critical Cargo pressure keeps unmarked targets without discovery or fresh marking', async () => {
    const { app, incremental } = await cargoApp();
    rmSync(gcMarkFile(app));
    const fullDiscovery = vi.spyOn(checkoutDiscovery, 'discoverCheckouts');
    const artifacts = vi.spyOn(artifactPasses, 'artifactCheckoutsAsync');
    const writer = vi.spyOn(marks, 'markWriter');
    await runLadder(
      { ...input(true, async () => pressure('critical')), fromRung: 3, lastRung: 3 },
      pressure('critical'),
    );
    expect(existsSync(incremental)).toBe(true);
    expect(fullDiscovery).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  test('a headroom deadline stops Cargo refresh before the next holder and next plan', async () => {
    const first = await cargoApp('a-cargo');
    const second = await cargoApp('b-cargo');
    rmSync(gcMarkFile(first.app));
    rmSync(gcMarkFile(second.app));
    const stop = new AbortController();
    const operation = testContext();
    const plan = vi.spyOn(cargoTargetPasses, 'planCargoTargetsAtPressure');
    const read = vi.spyOn(stages, 'readCheckout').mockImplementation(async (_path, _project, reading) => {
      stop.abort(new Error('headroom deadline'));
      expect(reading.operation?.signal.aborted).toBe(true);
      throw stop.signal.reason;
    });
    const { actions } = await runLadder(
      { ...input(true, async () => pressure('high')), operation, stop: stop.signal, fromRung: 3, lastRung: 3 },
      pressure('high'),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(operation.signal.aborted).toBe(false);
    expect(actions.filter((action) => action.outcome === 'failed')).toEqual([]);
    expect(readGcMark(first.app)).toBeNull();
    expect(readGcMark(second.app)).toBeNull();
  });

  test.skipIf(process.platform === 'win32')(
    'high Cargo pressure refreshes a missing mark after its known sweep',
    async () => {
      const { app, incremental } = await cargoApp();
      rmSync(gcMarkFile(app));
      const fullDiscovery = vi.spyOn(checkoutDiscovery, 'discoverCheckouts');
      await runLadder({ ...input(true, async () => pressure('high')), fromRung: 3, lastRung: 3 }, pressure('high'));
      expect(fullDiscovery).toHaveBeenCalled();
      expect(readGcMark(app)?.candidates.some(({ kind }) => kind === 'cargo-target')).toBe(true);
      expect(existsSync(incremental)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a Cargo candidate boundary releases its profile locks and rechecks a newly pinned target',
    async () => {
      const apps = [await cargoApp('first-cargo'), await cargoApp('second-cargo')];
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first: string | undefined;
      let selectedLocks: readonly string[] = [];
      let inside = false;
      const lock = cargoLocks.withCargoLocks;
      vi.spyOn(cargoLocks, 'withCargoLocks').mockImplementation(
        <T>(paths: readonly string[], body: () => Promise<T>, signal?: AbortSignal) =>
          lock(
            paths,
            async () => {
              const own = apps.find((app) => paths.some((path) => path.startsWith(app.target)));
              if (own && first === undefined) {
                first = own.target;
                selectedLocks = [...paths];
                inside = true;
                await held;
                try {
                  return await body();
                } finally {
                  inside = false;
                }
              }
              return body();
            },
            signal,
          ),
      );
      const high = requestGcPass(
        'high',
        'manual',
        async (_level, signal, _emit, found, turn) => {
          found('high');
          const done = await runLadder(
            {
              ...input(true, async () => pressure('high')),
              operation: testContext({ signal }),
              fromRung: 3,
              lastRung: 3,
              between: turn.boundary,
            },
            pressure('high'),
          );
          return { run: ladderRun('high', done.pressure, done.actions) };
        },
        () => {},
      );
      const outcome = high.result.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(first).toBeDefined(), { timeout: 5_000 });
        const selected = apps.find((app) => app.target === first);
        const remaining = apps.find((app) => app.target !== first);
        if (!selected || !remaining) throw new Error('the first Cargo target was not selected');
        const critical = requestGcItem(async () => {
          expect(inside).toBe(false);
          expect(selectedLocks.every((path) => existsSync(path))).toBe(true);
          expect(await lock(selectedLocks, async () => 'free')).toEqual({ value: 'free' });
          writeFileSync(join(remaining.app, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
        }, CRITICAL);
        expect(inside).toBe(true);
        release();
        await critical.result;
        expect(await outcome).not.toBeInstanceOf(Error);
        expect(existsSync(selected.incremental)).toBe(false);
        expect(existsSync(remaining.incremental)).toBe(true);
      } finally {
        release();
        await outcome;
      }
    },
    15_000,
  );

  test.each(['target met', 'abort'] as const)(
    'a resumed headroom Cargo candidate starts no deletion after %s',
    async (change) => {
      const app = await cargoApp('headroom-boundary');
      const device = statSync(app.target).dev;
      let freeMb = 10 * 1024;
      vi.spyOn(daemonMeasure, 'measureDisk').mockImplementation(async () => [{ volume: '/', device, freeMb }]);
      let boundaries = 0;
      const operation = testContext({ env: { ...process.env, CI: undefined, STIM_DAEMON: undefined } });
      const asked = requestGcItem(
        (signal, turn) =>
          runLadderToFree({
            operation,
            signal,
            device,
            freeMb: 24 * 1024,
            act: true,
            protectedRoot: join(projects, 'build'),
            between: async () => {
              boundaries++;
              const critical = requestGcItem(async () => {
                if (change === 'target met') freeMb = 30 * 1024;
                else asked.leave();
              }, CRITICAL);
              await turn.boundary();
              await critical.result;
            },
          }),
        LADDER,
      );
      await asked.result.catch((error: unknown) => {
        if (change !== 'abort') throw error;
      });
      expect(boundaries).toBeGreaterThan(0);
      expect(existsSync(app.incremental)).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'at high rung 3 trims the incremental data of a Cargo target first, again only after 10 minutes, with no size scan',
    async () => {
      const { target, incremental, fill } = await cargoApp();
      const remeasure = async () => pressure('high');

      const first = await runLadder(input(true, remeasure), pressure('high'));

      expect(existsSync(incremental)).toBe(false);
      expect(existsSync(join(target, 'debug', '.fingerprint'))).toBe(true);
      expect(first.actions.map((action) => [action.rung, action.kind, action.target, action.outcome])).toEqual([
        [3, 'trim-cargo', target, 'done'],
      ]);

      fill();
      await runLadder(input(true, remeasure), pressure('high'));
      expect(existsSync(incremental)).toBe(true);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * MINUTE_MS);
      await runLadder(input(true, remeasure), pressure('high'));
      expect(existsSync(incremental)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    "the stim-daemon's Cargo trims wait 10 minutes per level by the clocks its disk passes share, whichever thread runs them",
    async () => {
      const { incremental } = await cargoApp();
      const remeasure = async () => pressure('high');
      const slots = Object.keys(LADDER_CLOCK_SLOTS).length;

      const trimmedRecently = new BigInt64Array(slots);
      trimmedRecently[LADDER_CLOCK_SLOTS['cargo high']] = BigInt(Date.now() - 5 * MINUTE_MS);
      await runLadder({ ...input(true, remeasure), clocks: trimmedRecently }, pressure('high'));
      expect(existsSync(incremental)).toBe(true);

      const neverTrimmed = new BigInt64Array(slots);
      const before = Date.now();
      await runLadder({ ...input(true, remeasure), clocks: neverTrimmed }, pressure('high'));
      expect(existsSync(incremental)).toBe(false);
      expect(Number(neverTrimmed[LADDER_CLOCK_SLOTS['cargo high']])).toBeGreaterThanOrEqual(before);
      expect(neverTrimmed[LADDER_CLOCK_SLOTS['cargo critical']]).toBe(0n);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'at high rung 3 trims the shared caches before the Cargo targets, and the targets largest first by their last recorded size',
    async () => {
      const small = await cargoApp('small-app');
      const big = await cargoApp('big-app');
      for (const [target, gib] of [
        [small.target, 1],
        [big.target, 20],
      ] as const)
        writeCacheFile(diskUsageCacheFile(target), {
          path: target,
          measuredAt: new Date().toISOString(),
          bytes: gib * 1024 ** 3,
        });
      caches('kept-key');
      vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
      const real = getExecutor();
      setExecutor({
        ...real,
        runFileAsync: async (file, args, options) =>
          file === 'du' && args.at(-1) === buildCache()
            ? `${20 * 1024 * 1024}\t${buildCache()}\n`
            : real.runFileAsync(file, args, options),
      });

      const { actions } = await runLadder(
        input(true, async () => pressure('high')),
        pressure('high'),
      );

      expect(actions.filter((action) => action.rung === 3).map((action) => [action.kind, action.target])).toEqual([
        ['trim-cache', buildCache()],
        ['trim-cargo', big.target],
        ['trim-cargo', small.target],
      ]);
    },
  );

  const trimOrder = (actions: readonly DaemonLadderAction[]) =>
    actions.filter((action) => action.kind === 'trim-cargo').map((action) => action.target);

  test.skipIf(process.platform === 'win32')(
    'rung 3 orders Cargo targets by their recorded size, unsized ones last',
    async () => {
      const unsized = await cargoApp('unsized-app');
      const rescanned = await cargoApp('rescanned-app');
      const large = await cargoApp('large-app');
      recordSize(rescanned.target, GIB);
      recordSize(large.target, 5 * GIB);

      const { actions } = await runLadder(
        input(true, async () => pressure('high')),
        pressure('high'),
      );

      expect(trimOrder(actions)).toEqual([large.target, rescanned.target, unsized.target]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a Cargo target this process tried to trim goes after the sized ones until it is measured again',
    async () => {
      const small = await cargoApp('small-app');
      const big = await cargoApp('big-app');
      recordSize(small.target, GIB);
      recordSize(big.target, 20 * GIB);
      const ladder = () =>
        runLadder(
          input(true, async () => pressure('high')),
          pressure('high'),
        );
      expect(trimOrder((await ladder()).actions)).toEqual([big.target, small.target]);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * MINUTE_MS);
      small.fill();
      big.fill();
      recordSize(small.target, GIB);

      expect(trimOrder((await ladder()).actions)).toEqual([small.target, big.target]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rung 3 skips a Cargo target whose own volume is no longer short when its turn comes',
    async () => {
      const recovered = await cargoApp('recovered-app');
      const short = await cargoApp('short-app');
      vi.spyOn(cargoTargetPasses, 'measuredDiskLevel').mockImplementation(async (dir) =>
        dir === recovered.target ? 'normal' : 'high',
      );

      const { actions } = await runLadder(
        input(true, async () => pressure('high')),
        pressure('high'),
      );

      expect(existsSync(recovered.incremental)).toBe(true);
      expect(existsSync(short.incremental)).toBe(false);
      expect(actions.filter((action) => action.kind === 'trim-cargo').map((action) => action.target)).toEqual([
        short.target,
      ]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rung 3 still trims the Cargo targets after its shared caches fail, and records the failure',
    async () => {
      const { target } = await cargoApp();
      caches('kept-key');
      vi.spyOn(cacheModule, 'pruneCache').mockRejectedValue(new Error('ENOSPC: no space left on device'));

      const { actions } = await runLadder(
        input(true, async () => pressure('critical')),
        pressure('critical'),
      );

      expect(
        actions
          .filter((action) => action.rung === 3)
          .map((action) => [action.kind, action.outcome])
          .toSorted(),
      ).toEqual([
        ['rung', 'failed'],
        ['trim-cargo', 'done'],
      ]);
      expect(actions.find((action) => action.target === target)).toBeDefined();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rung 3 plans no Cargo target when the level has cleared by the time it starts',
    async () => {
      const { incremental } = await cargoApp();
      const plan = vi.spyOn(cargoTargetPasses, 'planCargoTargetsAtPressure');
      let calls = 0;

      await runLadder(
        {
          ...input(true, async () => (++calls === 1 ? pressure('high') : pressure('normal'))),
          fromRung: 3,
          lastRung: 3,
        },
        pressure('high'),
      );

      expect(plan).not.toHaveBeenCalled();
      expect(existsSync(incremental)).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a command ladder leaves the Cargo target of its own workspace alone',
    async () => {
      const { app, incremental } = await cargoApp();
      const remeasure = async () => pressure('high');

      const { actions } = await runLadder({ ...input(true, remeasure), protectedRoot: app }, pressure('high'));

      expect(existsSync(incremental)).toBe(true);
      expect(actions).toEqual([]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a build headroom run trims a Cargo target only on the build volume, whatever disk.minFreeGb says',
    async () => {
      const { incremental } = await cargoApp();
      vi.stubEnv('STIM_DISK_MIN_FREE_GB', '0');
      const device = statSync(home).dev;
      vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([
        { volume: '/', freeMb: 100 * 1024, device },
        { volume: '/other', freeMb: 100 * 1024, device: device + 1 },
      ]);
      const headroom = (buildDevice: number) =>
        runLadderToFree({
          operation: testContext({ env: { ...process.env, CI: undefined, STIM_DAEMON: undefined } }),
          signal: new AbortController().signal,
          device: buildDevice,
          freeMb: 200 * 1024,
          protectedRoot: join(projects, 'build'),
        });

      await headroom(device + 1);
      expect(existsSync(incremental)).toBe(true);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * MINUTE_MS);
      await headroom(device);
      expect(existsSync(incremental)).toBe(false);
    },
  );

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

  test.each(process.platform === 'win32' ? [] : ['new activity', 'pressure cleared', 'abort'])(
    'a stopped-output boundary releases claims before critical work and rechecks %s on resume',
    async (change) => {
      const root = workspace('one-checkout', 5 * MINUTE_MS, 'Shutdown').root;
      const paths = ['derived-data', 'gradle-build'].map((name) => join(workspaceDir(root), name));
      for (const path of paths) mkdirSync(path, { recursive: true });
      await marks.markWriter(input().config)({
        path: root,
        at: Date.now(),
        lastActivityAt: Date.now() - DAY_MS,
        kept: null,
      });
      const started = join(home, 'output-rm.pid');
      const go = join(home, 'output-rm.go');
      const script = join(home, 'held-output-rm.sh');
      writeFileSync(
        script,
        'echo $$ > "$1"\ni=0\nwhile [ ! -f "$2" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done\nshift 2\nexec /bin/rm "$@"\n',
      );
      const release = () => writeFileSync(go, 'go');
      let first: string | undefined;
      let removing = false;
      const real = getExecutor();
      setExecutor({
        ...real,
        runFileAsync: async (file, args, options) => {
          const target = args.at(-1);
          if (file !== 'rm' || !target || !paths.includes(target) || first !== undefined)
            return real.runFileAsync(file, args, options);
          first = target;
          removing = true;
          try {
            return await real.runFileAsync('/bin/sh', [script, started, go, ...args], options);
          } finally {
            removing = false;
          }
        },
      });
      let remainingKeep: unknown;
      let current = pressure('high');
      const high = requestGcPass(
        'high',
        'manual',
        async (_level, signal, _emit, found, turn) => {
          found('high');
          const done = await runLadder(
            {
              ...input(true, async () => current),
              operation: testContext({ signal }),
              fromRung: 1,
              lastRung: 1,
              between: turn.boundary,
            },
            current,
          );
          return { run: ladderRun('high', done.pressure, done.actions) };
        },
        () => {},
      );
      const outcome = high.result.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(existsSync(started)).toBe(true));
        const selected = first;
        const remaining = paths.find((path) => path !== selected);
        if (!selected || !remaining) throw new Error('the first stopped output was not selected');
        const critical = requestGcItem(async () => {
          expect(removing).toBe(false);
          remainingKeep = readGcMark(root)?.candidates.find((candidate) => candidate.path === remaining)?.keep;
          for (const lock of ['native-run', 'metro-start'])
            expect(
              await withWorkspaceProcessLock(workspaceDir(root), lock, async () => 'free', {
                external: true,
                waitMs: 0,
              }),
            ).toBe('free');
          if (change === 'new activity') recordWorkspaceUse(root, new Date());
          else if (change === 'pressure cleared') current = pressure('normal');
          else high.leave();
        }, CRITICAL);
        expect(removing).toBe(true);
        release();
        await critical.result;
        const result = await outcome;
        expect(result instanceof Error).toBe(change === 'abort');
        expect(existsSync(selected)).toBe(false);
        expect(existsSync(remaining)).toBe(true);
        const kept = readGcMark(root)?.candidates.find((candidate) => candidate.path === remaining)?.keep;
        expect(change === 'new activity' ? kept?.reason : kept).toEqual(
          change === 'new activity' ? 'it is no longer idle' : remainingKeep,
        );
      } finally {
        release();
        await outcome;
      }
    },
  );

  test.each(['same unit increase', 'later owner increase', 'predictive target met'] as const)(
    'first-free evidence uses the completed output unit before yielding: %s',
    async (change) => {
      const root = workspace('first-free', 5 * MINUTE_MS, 'Shutdown').root;
      const paths = ['derived-data', 'gradle-build'].map((name) => join(workspaceDir(root), name));
      for (const path of paths) mkdirSync(path, { recursive: true });
      await marks.markWriter(input().config)({
        path: root,
        at: Date.now(),
        lastActivityAt: Date.now() - DAY_MS,
        kept: null,
      });
      const device = statSync(paths[0] ?? root).dev;
      let freeMb = 10_000;
      let removed = false;
      let sampledAt = 0;
      const order: string[] = [];
      const points: { device: number; at: number }[] = [];
      vi.spyOn(diskBudget, 'readVolumeSpaceAsync').mockImplementation(async () => {
        if (removed) {
          await Promise.resolve();
          vi.advanceTimersByTime(250);
          sampledAt = Date.now();
          order.push('sampled');
        }
        return [{ volume: '/', freeMb, device }];
      });
      let current = pressure(change === 'predictive target met' ? 'normal' : 'high');
      const owner = await acquireDisk(LADDER);
      let critical: ReturnType<typeof requestGcItem> | undefined;
      vi.spyOn(idlePass, 'deleteOutputs').mockImplementation(async (selected) => {
        for (const path of selected) rmSync(path, { recursive: true });
        removed = true;
        order.push('removed');
        if (change !== 'later owner increase') freeMb += 32;
        critical = requestGcItem(async () => {
          order.push('critical');
          freeMb += 1024;
          current = pressure('normal');
        }, CRITICAL);
        return { bytes: 0 };
      });
      try {
        await runLadder(
          {
            ...input(true, async () => current),
            fromRung: 1,
            lastRung: 1,
            operation: testContext(),
            between: owner.boundary,
            ...(change === 'predictive target met'
              ? { target: { device, freeMb: 10_016, available: () => freeMb } }
              : {}),
            firstFree: {
              pending: () => points.length === 0,
              observed: (sampleDevice, at) => {
                points.push({ device: sampleDevice, at });
              },
            },
          },
          current,
        );
        expect(order).toEqual(['removed', 'sampled', 'critical']);
        expect(points).toEqual(change !== 'later owner increase' ? [{ device, at: sampledAt }] : []);
        expect(paths.filter(existsSync)).toHaveLength(1);
      } finally {
        owner.release();
        await critical?.result;
      }
    },
  );

  test('keeping one stopped-output candidate preserves its sibling mark', async () => {
    const root = workspace('keep-one-output', 5 * MINUTE_MS, 'Shutdown').root;
    const paths = ['derived-data', 'gradle-build'].map((name) => join(workspaceDir(root), name));
    for (const path of paths) mkdirSync(path, { recursive: true });
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    const before = readGcMark(root);
    if (!before) throw new Error('missing output mark');
    const selected = before.candidates.filter((candidate) => candidate.path === paths[1]);
    marks.keepOutputMark({ ...before, candidates: selected }, 'new activity');
    expect(readGcMark(root)?.candidates.find((candidate) => candidate.path === paths[0])).toEqual(
      before.candidates.find((candidate) => candidate.path === paths[0]),
    );
    expect(readGcMark(root)?.candidates.find((candidate) => candidate.path === paths[1])?.keep?.reason).toBe(
      'new activity',
    );
  });

  test.each([
    { freeMb: 50 * 1024, deleted: true },
    { freeMb: 200 * 1024, deleted: false },
  ])('a resumed critical output candidate preserves the minFreeGb device gate at $freeMb MB', async (sample) => {
    const root = workspace('device-recheck', 5 * MINUTE_MS, 'Shutdown').root;
    const output = join(workspaceDir(root), 'derived-data');
    mkdirSync(output, { recursive: true });
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    vi.stubEnv('STIM_DISK_MIN_FREE_GB', '100');
    vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '2');
    const device = statSync(output).dev;
    let freeMb = 1024;
    vi.spyOn(daemonMeasure, 'measureDisk').mockImplementation(async () => [
      { volume: '/', device, freeMb },
      { volume: '/other', device: device + 1, freeMb: 1024 },
    ]);
    await runLadder(
      {
        ...input(true, async () => pressure('critical')),
        fromRung: 1,
        lastRung: 1,
        between: async () => {
          freeMb = sample.freeMb;
        },
      },
      pressure('critical'),
    );
    expect(existsSync(output)).toBe(!sample.deleted);
  });

  test('critical output sweep uses only marked paths and never refreshes or rediscovers candidates', async () => {
    const marked = workspace('marked', 5 * MINUTE_MS, 'Shutdown').root;
    const missing = workspace('unmarked', 5 * MINUTE_MS, 'Shutdown').root;
    const output = (root: string, name: string) => {
      const path = join(workspaceDir(root), name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'out'), 'regenerable');
      return path;
    };
    const known = output(marked, 'derived-data');
    const unknown = output(missing, 'derived-data');
    await marks.markWriter(input().config)({
      path: marked,
      at: Date.now(),
      lastActivityAt: Date.now() - 5 * MINUTE_MS,
      kept: null,
    });
    const newer = output(marked, 'gradle-build');
    const refresh = vi.spyOn(marks, 'refreshOutputMarks');
    const discover = vi.spyOn(stages, 'stoppedOutputCandidates');

    await runLadder(
      { ...input(true, async () => pressure('critical')), fromRung: 1, lastRung: 1 },
      pressure('critical'),
    );

    expect(existsSync(known)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(newer)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(readGcMark(missing)).toBeNull();
    expect(log).toHaveBeenCalledWith('info', 'gc_marks_missing', expect.any(String), { roots: 1 });
  });

  test.each(['recent activity', 'maintenance.keep', 'changed volume'] as const)(
    'a stale output mark does not override %s at critical pressure',
    async (change) => {
      const { root } = workspace('recheck', 5 * MINUTE_MS, 'Shutdown');
      const output = join(workspaceDir(root), 'derived-data');
      mkdirSync(output, { recursive: true });
      await marks.markWriter(input().config)({
        path: root,
        at: Date.now(),
        lastActivityAt: Date.now() - DAY_MS,
        kept: null,
      });
      if (change === 'recent activity') recordWorkspaceUse(root, new Date());
      else if (change === 'maintenance.keep')
        writeFileSync(join(root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
      else {
        const mark = readGcMark(root);
        if (!mark) throw new Error('missing fixture mark');
        writeCacheFile(gcMarkFile(root), { ...mark, device: mark.device + 1 });
      }

      const { actions } = await runLadder(
        { ...input(true, async () => pressure('critical')), fromRung: 1, lastRung: 1 },
        pressure('critical'),
      );

      expect(existsSync(output)).toBe(true);
      expect(actions).toContainEqual(expect.objectContaining({ rung: 1, outcome: 'kept' }));
      expect(readGcMark(root)?.candidates[0]?.keep).toBeDefined();
    },
  );

  test('a resumed saved output keeps a checkout whose only discovery route was removed', async () => {
    resetExecutor();
    const root = join(projects, 'discovered');
    const output = join(root, 'android', 'app', 'build');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(root, 'android', 'build.gradle'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(root, '.gitignore'), 'android/app/build/\n');
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['commit', '-q', '-m', 'init'],
    ])
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
      });
    const at = new Date(Date.now() - DAY_MS);
    const age = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) age(path);
        utimesSync(path, at, at);
      }
      utimesSync(directory, at, at);
    };
    age(root);
    const operation = testContext();
    const config = input().config;
    config.maintenance = { autoDiscover: false, discoverRoots: [projects] };
    saveConfig(config);
    await marks.markWriter(config)({ path: root, at: Date.now(), lastActivityAt: Date.now() - DAY_MS, kept: null });
    expect((await marks.outputMarks(config, operation)).map((mark) => mark.root)).toContain(root);
    const before = readFileSync(gcMarkFile(root), 'utf8');
    let handoffs = 0;
    await runLadder(
      {
        ...input(true, async () => pressure('critical')),
        operation,
        fromRung: 1,
        lastRung: 1,
        between: async () => {
          handoffs++;
          saveConfig({ ...config, maintenance: { autoDiscover: false, discoverRoots: [] } });
        },
      },
      pressure('critical'),
    );
    expect(handoffs).toBe(1);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
  });

  test('critical output sweep keeps a marked nested checkout after discoverRoots is broadened', async () => {
    const { root } = workspace('team/app', 5 * MINUTE_MS, 'Shutdown');
    const output = join(workspaceDir(root), 'derived-data');
    mkdirSync(output, { recursive: true });
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    const current = input().config;
    delete current.projects[root];
    current.maintenance = { discoverRoots: [projects] };
    saveConfig(current);

    await runLadder(
      { ...input(true, async () => pressure('critical')), fromRung: 1, lastRung: 1 },
      pressure('critical'),
    );

    expect(existsSync(output)).toBe(true);
  });

  test('high output sweep does not refresh once the disk reaches critical', async () => {
    workspace('missing', 5 * MINUTE_MS, 'Shutdown');
    const refresh = vi.spyOn(marks, 'refreshOutputMarks');
    const remeasure = vi
      .fn<() => Promise<DaemonPressure>>()
      .mockResolvedValueOnce(pressure('high'))
      .mockResolvedValue(pressure('critical'));

    await runLadder({ ...input(true, remeasure), fromRung: 1, lastRung: 1 }, pressure('high'));

    expect(refresh).not.toHaveBeenCalled();
  });

  test('a forced stopped-output candidate retains its selected level after a boundary', async () => {
    const root = workspace('forced-output', 5 * MINUTE_MS, 'Shutdown').root;
    const output = join(workspaceDir(root), 'derived-data');
    mkdirSync(output, { recursive: true });
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    const between = vi.fn<() => Promise<void>>(async () => {});
    await runLadder(
      {
        ...input(true, async () => pressure('normal')),
        fromRung: 1,
        lastRung: 1,
        between,
        force: { level: 'high', why: 'explicit high' },
      },
      pressure('normal'),
    );
    expect(between).toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  test('critical daemon report mode previews only known marks without writing them', async () => {
    const { root } = workspace('known-report', 5 * MINUTE_MS, 'Shutdown');
    const output = join(workspaceDir(root), 'derived-data');
    mkdirSync(output, { recursive: true });
    workspace('unmarked-report', 5 * MINUTE_MS, 'Shutdown');
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    const before = readGcMark(root);
    const discover = vi.spyOn(stages, 'stoppedOutputCandidates');
    const between = vi.fn<() => Promise<void>>(async () => {});

    const { actions } = await runLadder(
      { ...input(false, async () => pressure('critical')), fromRung: 1, lastRung: 1, between },
      pressure('critical'),
    );

    expect(actions).toContainEqual(expect.objectContaining({ rung: 1, target: root, outcome: 'would' }));
    expect(existsSync(output)).toBe(true);
    expect(discover).not.toHaveBeenCalled();
    expect(readGcMark(root)).toEqual(before);
    expect(between).not.toHaveBeenCalled();
  });

  test('marked output removal reports failure after an earlier output was deleted', async () => {
    const { root } = workspace('partial-output', 5 * MINUTE_MS, 'Shutdown');
    const first = join(workspaceDir(root), 'derived-data');
    const second = join(workspaceDir(root), 'gradle-build');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    const remove = vi.spyOn(idlePass, 'deleteOutputs');
    remove.mockImplementationOnce(async () => {
      rmSync(first, { recursive: true });
      throw new Error('removal refused');
    });

    const { actions } = await runLadder(
      { ...input(true, async () => pressure('critical')), fromRung: 1, lastRung: 1 },
      pressure('critical'),
    );

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(actions).toContainEqual(expect.objectContaining({ rung: 1, outcome: 'failed', detail: 'removal refused' }));
  });

  test.skipIf(process.platform !== 'win32')(
    'preserves saved Windows short-name keys while matching native Git routes',
    async (context) => {
      vi.stubEnv('STIM_HOME', '');
      vi.spyOn(protectedLocations, 'isProtectedLocation').mockReturnValue(false);
      const known = join(projects, 'known-long-name');
      const saved = join(projects, 'saved-long-name');
      for (const root of [known, saved]) {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      }
      writeFileSync(join(saved, '.gitignore'), 'android/app/build/\n');
      for (const root of [known, saved]) {
        execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
        execFileSync('git', [
          '-C',
          root,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ]);
      }
      const output = join(saved, 'android', 'app', 'build');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'app.bin'), 'regenerable build artifact');
      const native = await nativeRealpath(saved);
      if (saved === native) context.skip();
      const config = { projects: { [known]: {} }, repos: {}, maintenance: { autoDiscover: true } };
      saveConfig(config);
      await marks.markWriter(config)({ path: saved, at: Date.now(), lastActivityAt: null, kept: null });

      expect((await marks.outputMarks(config, testContext())).map(({ root }) => root)).toEqual([saved]);
      expect(readGcMark(saved)?.candidates).toContainEqual(expect.objectContaining({ kind: 'outputs', path: output }));
      expect(saved).not.toBe(native);
      let handoffs = 0;
      const { actions } = await runLadder(
        {
          ...input(true, async () => pressure('critical')),
          operation: testContext(),
          fromRung: 1,
          lastRung: 1,
          force: { level: 'critical', why: 'saved Windows scope' },
          between: async () => {
            handoffs++;
          },
        },
        pressure('critical'),
      );
      expect(handoffs).toBe(1);
      expect(actions).toContainEqual(expect.objectContaining({ rung: 1, target: saved }));
    },
  );

  test('high output sweep stops after known marks clear pressure, before refreshing unmarked roots', async () => {
    const { root } = workspace('known', 5 * MINUTE_MS, 'Shutdown');
    const output = join(workspaceDir(root), 'derived-data');
    mkdirSync(output, { recursive: true });
    workspace('missing', 5 * MINUTE_MS, 'Shutdown');
    await marks.markWriter(input().config)({
      path: root,
      at: Date.now(),
      lastActivityAt: Date.now() - DAY_MS,
      kept: null,
    });
    const refresh = vi.spyOn(marks, 'refreshOutputMarks');
    const remeasure = async () => pressure(existsSync(output) ? 'high' : 'normal');

    await runLadder({ ...input(true, remeasure), fromRung: 1, lastRung: 1 }, pressure('high'));

    expect(existsSync(output)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  test('rung 1 leaves out a stopped workspace whose only output is a Cargo target/', async () => {
    const rust = workspace('rust-only', 5 * MINUTE_MS, 'Shutdown').root;
    mkdirSync(join(rust, 'target'));
    writeFileSync(join(rust, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    const built = workspace('built', 5 * MINUTE_MS, 'Shutdown').root;
    mkdirSync(join(built, 'android', 'build'), { recursive: true });

    const candidates = await stages.stoppedOutputCandidates(input().config, input(), idlePass.PRESSURE_IDLE_MS);

    expect(candidates.map(({ path }) => path)).toEqual([built]);
  });

  test('rung 1 deletes the other outputs of a stopped workspace and leaves its Cargo target/ to rung 3', async () => {
    const { root } = workspace('mixed', 5 * MINUTE_MS, 'Shutdown');
    mkdirSync(join(root, 'target'));
    writeFileSync(join(root, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    const derived = join(workspaceDir(root), 'derived-data');
    mkdirSync(derived, { recursive: true });
    writeFileSync(join(derived, 'Build.o'), 'x'.repeat(4096));

    const { actions } = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );

    expect(existsSync(derived)).toBe(false);
    expect(existsSync(join(root, 'target', 'CACHEDIR.TAG'))).toBe(true);
    expect(actions.filter((action) => action.rung === 1)).toEqual([
      expect.objectContaining({ outcome: 'done', detail: expect.stringContaining(`kept ${join(root, 'target')}`) }),
    ]);
  });

  test('rung 7 in a read-only preview reports a finished worktree and removes nothing', async () => {
    const worktree = join(projects, 'finished');
    vi.spyOn(sweep, 'planWorktrees').mockResolvedValue({
      sweep: {
        idle: null,
        graceMs: 0,
        now: Date.now(),
        noOwnCommitsIdleMs: null,
        worktrees: [
          {
            path: worktree,
            keys: [worktree],
            idleDays: 9,
            merge: null,
            head: null,
            pullRequest: null,
            skipCode: null,
            skipped: null,
            eligibleAt: null,
            activity: null,
          },
        ],
      },
      actions: [{ kind: 'would-remove-worktree', target: worktree, bytes: 0, reason: 'its branch is merged' }],
      blocked: [],
      skips: [],
    });
    const act = vi.spyOn(acting, 'executeAction');

    const { actions } = await runLadder(
      {
        ...input(false, async () => pressure('high')),
        fromRung: 7,
        lastRung: 7,
        force: { level: 'high', why: 'test' },
      },
      pressure('high'),
    );

    expect(act).not.toHaveBeenCalled();
    expect(actions.filter((action) => action.rung === 7)).toEqual([
      expect.objectContaining({ target: worktree, outcome: 'kept', detail: expect.stringMatching(/^report only/) }),
    ]);
  });

  test("the stim-daemon's ladder runs neither report rung, at high or critical", async () => {
    const worktrees = vi.spyOn(sweep, 'planWorktrees');
    const ranked = vi.spyOn(dependencies, 'rankDependencies');

    for (const level of ['high', 'critical'] as const)
      await runLadder({ ...input(true, async () => pressure(level)), fromRung: 5 }, pressure(level));

    expect(worktrees).not.toHaveBeenCalled();
    expect(ranked).not.toHaveBeenCalled();
  });

  test('a pass whose last rung freed disk returns the level measured after it', async () => {
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([
      { volume: '/', freeMb: 1024, device: statSync(projects).dev },
    ]);
    const cache = { tool: 'npm', label: 'npm', paths: [projects], command: null, running: /npm/ };
    vi.spyOn(unowned, 'surveyToolCaches').mockResolvedValue([{ cache, bytes: 1024, kept: null }]);
    vi.spyOn(unowned, 'cleanToolCache').mockResolvedValue({ outcome: 'done', before: 1024, after: 0, detail: 'x' });
    const remeasure = vi
      .fn<() => Promise<DaemonPressure>>(async () => pressure('normal'))
      .mockResolvedValueOnce(pressure('critical'));
    const operation = testContext({ env: { ...process.env, STIM_HOME: undefined, ANDROID_HOME: projects } });

    const pass = await runLadder({ ...input(true, remeasure), fromRung: 9, operation }, pressure('critical'));

    expect(pass.actions).toContainEqual(expect.objectContaining({ rung: 9, outcome: 'done' }));
    expect(pass.actions.filter((action) => action.rung === 5 || action.rung === 7)).toEqual([]);
    expect(pass.pressure.level).toBe('normal');
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

  test.each(['high clears', 'critical clears', 'abort'] as const)(
    'a completed parked-device action hands off before the next admission: %s',
    async (change) => {
      vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
      const sim = { deviceTypeIdentifier: 'iPhone', runtimeIdentifier: 'iOS-26-0', simslimManaged: false };
      saveConfig({
        ...loadConfig()!,
        parked: {
          ios: ['first', 'second'].map((udid, index) =>
            Object.assign({}, sim, {
              udid,
              name: `stim-${udid}`,
              parkedAt: new Date(index * DAY_MS).toISOString(),
            }),
          ),
        },
      });
      const level = change === 'critical clears' ? 'critical' : 'high';
      let current = pressure(level);
      const controller = new AbortController();
      const owner = await acquireDisk(level === 'critical' ? CRITICAL : LADDER);
      const order: string[] = [];
      let during: string[] = [];
      let critical: ReturnType<typeof requestGcItem> | undefined;
      vi.spyOn(acting, 'executeAction').mockImplementation(async (action) => {
        order.push(action.target);
        if (action.target === 'first') {
          critical = requestGcItem(
            async () => {
              order.push('critical');
              current = pressure('normal');
              if (change === 'abort') controller.abort(new Error('cancelled between parked devices'));
            },
            level === 'critical' ? HARD_FLOOR : CRITICAL,
          );
          await Promise.resolve();
          during = [...order];
        }
        return { status: 'done', bytes: 0, detail: 'device operation settled' };
      });
      try {
        const result = runLadder(
          {
            ...input(true, async () => current),
            fromRung: 2,
            lastRung: 2,
            operation: testContext({ signal: controller.signal }),
            between: owner.boundary,
          },
          current,
        );
        const failure = await result.then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(failure).toBe(change === 'abort' ? 'cancelled between parked devices' : null);
        expect(during).toEqual(['first']);
        expect(order).toEqual(change === 'critical clears' ? ['first', 'critical', 'second'] : ['first', 'critical']);
      } finally {
        owner.release();
        await critical?.result;
      }
    },
  );

  test.each(['done', 'failed and cleared', 'failed and still critical'] as const)(
    'a resumed tool-cache plan rechecks critical volume eligibility before the next command: %s',
    async (result) => {
      const cache = (name: string) => ({
        tool: name,
        label: name,
        paths: [projects],
        command: null,
        running: /not-running/,
      });
      vi.spyOn(unowned, 'surveyToolCaches').mockResolvedValue(
        ['first', 'second'].map((name) => ({
          cache: cache(name),
          bytes: 1024,
          kept: null,
        })),
      );
      let critical: ReturnType<typeof requestGcItem> | undefined;
      const order: string[] = [];
      const owner = await acquireDisk(CRITICAL);
      const clean = vi.spyOn(unowned, 'cleanToolCache').mockImplementation(async (plan) => {
        order.push(plan.cache.label);
        if (plan.cache.label === 'second')
          return { outcome: 'done', before: 1024, after: 0, detail: 'second command settled' };
        vi.mocked(daemonMeasure.measureDisk).mockResolvedValue([
          {
            volume: '/',
            freeMb: (result === 'failed and still critical' ? 5 : 25) * 1024,
            device: statSync(projects).dev,
          },
        ]);
        critical = requestGcItem(async () => {
          order.push('critical');
        }, HARD_FLOOR);
        await Promise.resolve();
        expect(order).toEqual(['first']);
        return {
          outcome: result === 'done' ? 'done' : 'failed',
          before: 1024,
          after: 0,
          detail: 'tool command settled after freeing space',
        };
      });
      try {
        await runLadder(
          {
            ...input(true, async () => pressure('critical')),
            fromRung: 9,
            lastRung: 9,
            operation: testContext({ env: { ...process.env, STIM_HOME: undefined, ANDROID_HOME: projects } }),
            between: owner.boundary,
          },
          pressure('critical'),
        );
        expect(order).toEqual(
          result === 'failed and still critical' ? ['first', 'critical', 'second'] : ['first', 'critical'],
        );
        expect(clean).toHaveBeenCalledTimes(result === 'failed and still critical' ? 2 : 1);
      } finally {
        owner.release();
        await critical?.result;
      }
    },
  );

  test('the final tool-cache cleanup hands off before inventory reporting starts', async () => {
    const order: string[] = [];
    vi.spyOn(unowned, 'surveyToolCaches').mockResolvedValue([
      {
        cache: { tool: 'fixture', label: 'only', paths: [projects], command: null, running: /not-running/ },
        bytes: 1024,
        kept: null,
      },
    ]);
    vi.spyOn(unowned, 'reportedCaches').mockReturnValue([]);
    vi.spyOn(inventory, 'collectInventory').mockImplementation(async () => {
      order.push('inventory');
      throw new Error('no inventory fixture');
    });
    const owner = await acquireDisk(CRITICAL);
    let higher: ReturnType<typeof requestGcItem> | undefined;
    vi.spyOn(unowned, 'cleanToolCache').mockImplementation(async () => {
      order.push('cleanup');
      higher = requestGcItem(async () => {
        order.push('hard floor');
      }, HARD_FLOOR);
      return { outcome: 'done', before: 1024, after: 0, detail: 'cleanup settled' };
    });
    try {
      await runLadder(
        {
          ...input(true, async () => pressure('critical')),
          fromRung: 9,
          lastRung: 9,
          operation: testContext({ env: { ...process.env, STIM_HOME: undefined, ANDROID_HOME: projects } }),
          between: owner.boundary,
        },
        pressure('critical'),
      );
      expect(order).toEqual(['cleanup', 'hard floor', 'inventory']);
    } finally {
      owner.release();
      await higher?.result;
    }
  });

  test('a resumed forced tool cleanup credits none of the next cache already removed by another owner', async () => {
    setExecutor({
      ...getExecutor(),
      runFileAsync: async () => '16\tfixture\n',
    });
    vi.spyOn(runningFrom, 'readRunningProcessesAsync').mockResolvedValue({
      commands: [{ pid: process.pid, line: 'node vitest' }],
      cwds: [{ pid: process.pid, path: projects }],
    });
    const paths = ['first-tool-cache', 'second-tool-cache'].map((name) => join(projects, name));
    for (const path of paths) {
      mkdirSync(path);
      writeFileSync(join(path, 'artifact'), 'x'.repeat(16_384));
    }
    vi.spyOn(unowned, 'surveyToolCaches').mockResolvedValue(
      paths.map((path) => ({
        cache: { tool: 'fixture', label: path, paths: [path], command: null, running: /never-a-tool-fixture/ },
        bytes: 16_384,
        kept: null,
      })),
    );
    vi.spyOn(unowned, 'reportedCaches').mockReturnValue([]);
    vi.spyOn(inventory, 'collectInventory').mockRejectedValue(new Error('no inventory fixture'));
    const real = unowned.cleanToolCache;
    const owner = await acquireDisk(CRITICAL);
    let higher: ReturnType<typeof requestGcItem> | undefined;
    vi.spyOn(unowned, 'cleanToolCache').mockImplementation(async (plan, ...args) => {
      const result = await real(plan, ...args);
      if (plan.cache.paths[0] === paths[0])
        higher = requestGcItem(async () => {
          const next = paths[1];
          if (next) rmSync(next, { recursive: true });
        }, HARD_FLOOR);
      return result;
    });
    try {
      const result = await runLadder(
        {
          ...input(true, async () => pressure('critical')),
          fromRung: 9,
          lastRung: 9,
          force: { level: 'critical', why: 'explicit critical' },
          operation: testContext({ env: { ...process.env, STIM_HOME: undefined, ANDROID_HOME: projects } }),
          between: owner.boundary,
        },
        pressure('critical'),
      );
      expect(
        result.actions.filter((action) => action.kind === 'clean-tool-cache' && action.outcome !== 'done'),
      ).toEqual([]);
      expect(paths.some(existsSync)).toBe(false);
      expect(result.actions).toContainEqual(
        expect.objectContaining({
          kind: 'clean-tool-cache',
          target: expect.stringContaining('second-tool-cache'),
          bytes: 0,
        }),
      );
    } finally {
      owner.release();
      await higher?.result;
    }
  });

  test('a whole shared-cache trim settles before critical work and the next cache rechecks its volume', async () => {
    caches('kept-key');
    const first = join(buildCache(), 'ios', 'unused');
    const next = join(metroCache(), 'other-app', 'transform', 'aa');
    const owner = await acquireDisk(CRITICAL);
    let critical: ReturnType<typeof requestGcItem> | undefined;
    const order: string[] = [];
    let firstGone = false;
    let nextPresent = false;
    let during: string[] = [];
    const prune = cacheModule.pruneCache;
    vi.spyOn(cacheModule, 'pruneCache').mockImplementation(async (cache, options) => {
      const result = await prune(cache, options);
      if (cache.dir === buildCache()) {
        order.push('cache settled');
        firstGone = !existsSync(first);
        critical = requestGcItem(async () => {
          order.push('critical');
          nextPresent = existsSync(next);
          vi.mocked(daemonMeasure.measureDisk).mockResolvedValue([
            { volume: '/', freeMb: 100 * 1024, device: statSync(home).dev },
          ]);
        }, HARD_FLOOR);
        await Promise.resolve();
        during = [...order];
      }
      return result;
    });
    try {
      await runLadder(
        { ...input(true, async () => pressure('critical')), fromRung: 3, lastRung: 3, between: owner.boundary },
        pressure('critical'),
      );
      expect(order).toEqual(['cache settled', 'critical']);
      expect(during).toEqual(['cache settled']);
      expect(firstGone).toBe(true);
      expect(nextPresent).toBe(true);
      expect(existsSync(next)).toBe(true);
    } finally {
      owner.release();
      await critical?.result;
    }
  });

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

  test('rung 3 sizes no cache entry at critical, and sizes entries at high only with a bounded walk that does not block', async () => {
    const walks = (level: 'high' | 'critical') => {
      const sync: string[] = [];
      const async: string[] = [];
      const real = getExecutor();
      setExecutor({
        ...real,
        runFile: (file, args, options) => {
          if (file === 'du') sync.push(String(args.at(-1)));
          return real.runFile(file, args, options);
        },
        runFileAsync: async (file, args, options) => {
          if (file !== 'du') return real.runFileAsync(file, args, options);
          async.push(String(args.at(-1)));
          if (args.at(-1) === buildCache()) return `${20 * 1024 * 1024}\t${buildCache()}\n`;
          return real.runFileAsync(file, args, options);
        },
      });
      return { level, sync, async };
    };
    const entry = join(buildCache(), 'ios', 'unused');
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');

    for (const level of ['critical', 'high'] as const) {
      caches('kept-key');
      const hoursAgo = (Date.now() - 3 * 60 * MINUTE_MS) / 1000;
      utimesSync(entry, hoursAgo, hoursAgo);
      const seen = walks(level);
      await runLadder(
        input(true, async () => pressure(level)),
        pressure(level),
      );
      expect(existsSync(entry)).toBe(false);
      expect(seen.sync).toEqual([]);
      const entryWalks = seen.async.filter((path) => path.startsWith(`${buildCache()}${sep}`));
      expect(entryWalks.includes(entry)).toBe(level === 'high');
      expect(entryWalks.length === 0).toBe(level === 'critical');
    }
  });

  test('rung 3 at high removes an entry whose size walk timed out and stops the trim there', async () => {
    caches('kept-key');
    const at = (hours: number) => (Date.now() - hours * 60 * MINUTE_MS) / 1000;
    const oldest = join(buildCache(), 'ios', 'unused');
    const next = join(buildCache(), 'ios', 'kept-key');
    utimesSync(oldest, at(4), at(4));
    utimesSync(next, at(3), at(3));
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file === 'du' && args.at(-1) === buildCache()) return `${20 * 1024 * 1024}\t${buildCache()}\n`;
        if (file === 'du' && args.at(-1) === oldest)
          throw Object.assign(new Error('Command timed out after 60000ms: du'), { code: 'ETIMEDOUT' });
        return real.runFileAsync(file, args, options);
      },
    });

    await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(next)).toBe(true);
  });

  test('rung 3 at high keeps a cache or the Swift compilation cache whose size walk timed out with a kept action, and logs the failure once per 6 hours', async () => {
    workspace('idle-hour', 60 * MINUTE_MS, 'Shutdown');
    mkdirSync(join(buildCache(), 'ios'), { recursive: true });
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
    const real = getExecutor();
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args, options) => {
        if (file !== 'du') return real.runFileAsync(file, args, options);
        throw Object.assign(new Error('Command timed out after 120000ms: du'), { code: 'ETIMEDOUT' });
      },
    });
    const sizeRecords = () =>
      readFileSync(daemonNdjsonFile(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): { event?: unknown; path?: unknown } => JSON.parse(line))
        .filter((record) => record.event === 'size_failed' && record.path === buildCache());
    const kept = (actions: { rung: number | null; kind: string; target: string; outcome: string }[]) =>
      actions.find((action) => action.rung === 3 && action.kind === 'trim-cache' && action.target === buildCache());

    const startedAt = Date.now();
    const first = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(kept(first.actions)).toMatchObject({
      outcome: 'kept',
      detail: 'its size walk did not finish within 120 seconds, so it was left alone',
    });
    expect(sizeRecords()).toEqual([
      expect.objectContaining({
        level: 'warn',
        caller: 'sharedCachesStep',
        reason: 'timeout',
        limitMs: 120_000,
        ms: expect.any(Number),
      }),
    ]);

    const again = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(kept(again.actions)?.outcome).toBe('kept');
    expect(sizeRecords()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 6 * 60 * MINUTE_MS);
    await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(sizeRecords()).toHaveLength(2);

    const compilation = join(home, 'compilation-cache');
    mkdirSync(compilation);
    vi.stubEnv('STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB', '1');
    const swift = await runLadder(
      input(true, async () => pressure('high')),
      pressure('high'),
    );
    expect(swift.actions.find((action) => action.rung === 3 && action.target === compilation)).toMatchObject({
      kind: 'empty-cache',
      outcome: 'kept',
      detail: 'its size walk did not finish within 120 seconds, so it was left alone',
    });
    vi.setSystemTime(startedAt);
  });

  test('headroom expiry during cache sizing never starts eviction', async () => {
    caches('kept-key');
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
    const device = statSync(home).dev;
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([{ volume: '/', freeMb: 100 * 1024, device }]);
    const stop = new AbortController();
    const prune = vi.spyOn(cacheModule, 'pruneCache');
    const size = vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async () => {
      stop.abort();
      return 20 * 1024 ** 3;
    });
    await expect(
      runLadderToFree({
        operation: testContext({ env: { ...process.env, CI: undefined, STIM_DAEMON: undefined } }),
        signal: stop.signal,
        device,
        freeMb: 200 * 1024,
        protectedRoot: join(projects, 'build'),
      }),
    ).resolves.toBeUndefined();
    expect(size).toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(true);
  });

  test('a build headroom run goes on to the Metro cache after the build cache could not be sized and was kept', async () => {
    caches('kept-key');
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
    vi.stubEnv('STIM_CACHES_METRO_CACHE_MAX_GB', '1');
    const device = statSync(home).dev;
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([{ volume: '/', freeMb: 100 * 1024, device }]);
    const real = getExecutor();
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args, options) => {
        if (file === 'du' && args.at(-1) === buildCache()) throw Object.assign(new Error('du: denied'), { status: 1 });
        if (file === 'du' && args.at(-1) === metroCache()) return `${4 * 1024 * 1024}\t${metroCache()}\n`;
        return real.runFileAsync(file, args, options);
      },
    });

    await runLadderToFree({
      operation: testContext({ env: { ...process.env, CI: undefined, STIM_DAEMON: undefined } }),
      signal: new AbortController().signal,
      device,
      freeMb: 200 * 1024,
      protectedRoot: join(projects, 'build'),
    });

    const reached = readFileSync(daemonNdjsonFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): { event?: unknown; target?: unknown } => JSON.parse(line))
      .filter((record) => record.event === 'pressure_action')
      .map((record) => record.target);
    expect(reached).toEqual([buildCache(), metroCache()]);
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(true);
  });

  test('a build headroom run goes on past a build cache trim that evicted nothing', async () => {
    mkdirSync(join(buildCache(), 'ios', 'recent'), { recursive: true });
    const transform = join(metroCache(), 'other-app', 'transform', 'aa');
    mkdirSync(transform, { recursive: true });
    const lastWeek = (Date.now() - 7 * DAY_MS) / 1000;
    utimesSync(transform, lastWeek, lastWeek);
    vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '12');
    vi.stubEnv('STIM_CACHES_METRO_CACHE_MAX_GB', '1');
    const device = statSync(home).dev;
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([{ volume: '/', freeMb: 100 * 1024, device }]);
    const real = getExecutor();
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args, options) => {
        if (file === 'du' && args.at(-1) === buildCache()) return `${20 * 1024 * 1024}\t${buildCache()}\n`;
        if (file === 'du' && args.at(-1) === metroCache()) return `${4 * 1024 * 1024}\t${metroCache()}\n`;
        return real.runFileAsync(file, args, options);
      },
    });

    await runLadderToFree({
      operation: testContext({ env: { ...process.env, CI: undefined, STIM_DAEMON: undefined } }),
      signal: new AbortController().signal,
      device,
      freeMb: 200 * 1024,
      protectedRoot: join(projects, 'build'),
    });

    const reached = readFileSync(daemonNdjsonFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): { event?: unknown; target?: unknown; outcome?: unknown } => JSON.parse(line))
      .filter((record) => record.event === 'pressure_action');
    expect(reached).toEqual([
      expect.objectContaining({ target: buildCache(), outcome: 'kept' }),
      expect.objectContaining({ target: metroCache(), outcome: 'done' }),
    ]);
    expect(existsSync(transform)).toBe(false);
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

  test('a measured stim gc with disk short on another volume idles and deletes nothing on this one', async () => {
    const { root: running } = workspace('running', 5 * MINUTE_MS, 'Booted');
    const { root: stopped } = workspace('stopped', 5 * MINUTE_MS, 'Shutdown');
    const outputs = join(workspaceDir(stopped), 'derived-data');
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(outputs, 'Build.o'), 'x');
    const device = statSync(home).dev;
    const disk = [
      { volume: '/', freeMb: 500 * 1024, device },
      { volume: '/Volumes/X', freeMb: 30 * 1024, device: device + 1 },
    ];
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue(disk);
    vi.spyOn(daemonMeasure, 'measureTick').mockImplementation(async () => ({
      measurement: {
        disk,
        memory: { level: 'normal', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        load1: 0,
        cores: 8,
        bootedSimulators: 1,
        runningEmulators: null,
        interaction: null,
      },
      sims,
      simsError: null,
      devices: await devicesNow(),
    }));

    const ladder = await runForcedLadder({
      levels: ['high'],
      act: true,
      why: 'stim gc at high',
      trigger: 'gc',
      measured: true,
    });

    expect(ladder?.pressure.disk).toBe('high');
    expect(ladder?.levels[0]?.actions.filter((action) => action.outcome === 'done')).toEqual([]);
    expect(readIdleStage(readWorkspaceState(running))).toBeNull();
    expect(existsSync(outputs)).toBe(true);
  });

  test('at critical on another volume it takes nothing from the volume the workspaces and caches are on', async () => {
    const { root } = workspace('idle-five', 5 * MINUTE_MS, 'Shutdown');
    const outputs = join(workspaceDir(root), 'derived-data');
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(outputs, 'Build.o'), 'x');
    caches('kept-key');
    const device = statSync(home).dev;
    vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([
      { volume: '/', freeMb: 500 * 1024, device },
      { volume: '/Volumes/X', freeMb: 1024, device: device + 1 },
    ]);
    const { actions } = await runLadder(
      { ...input(true, async () => pressure('critical')), lastRung: 8 },
      pressure('critical'),
    );
    expect(existsSync(outputs)).toBe(true);
    expect(existsSync(join(buildCache(), 'ios', 'unused'))).toBe(true);
    expect(existsSync(join(metroCache(), 'other-app', 'transform', 'aa'))).toBe(true);
    expect(existsSync(memo())).toBe(true);
    expect(actions.filter((action) => action.outcome === 'done')).toEqual([]);
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
    const rungs = actions.map((action) => action.rung);
    expect(rungs).toEqual(rungs.toSorted((a, b) => a - b));
    expect(actions.some((action) => action.rung === 4 && action.kind === 'dormant-stage')).toBe(true);
  });
});

describe('the ladder stim gc forces', () => {
  test('runs every rung at the forced level whatever the measured level', async () => {
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
    const parkedTargets = async () =>
      (
        await runLadder(
          {
            config: loadConfig()!,
            act: false,
            log,
            devices: [],
            simsFailed: false,
            remeasure: async () => pressure('normal'),
            force: { level: 'high', why: 'stim gc' },
            fromRung: 2,
          },
          pressure('normal'),
        )
      ).actions.flatMap((action) => (action.kind === 'delete-parked-device' ? [action.target] : []));

    expect(await parkedTargets()).toEqual(['OLD-PARKED', 'NEW-PARKED']);
  });

  test('in a scoped home it deletes the parked simulators its ledger lists and keeps the others', async () => {
    const parked = ['OWNED', 'FOREIGN'].map((udid) => ({
      udid,
      name: `stim-${udid} (iPhone 17 26.0)`,
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
      deviceTypeIdentifier: 'iPhone',
      simslimManaged: false,
      parkedAt: new Date(Date.now() - DAY_MS).toISOString(),
    }));
    const config = { version: 2 as const, projects: {}, repos: {}, parked: { ios: parked } };
    saveConfig(config);
    for (const { udid, name } of parked)
      sims.push({
        udid,
        name,
        state: 'Shutdown',
        runtime: 'iOS 26.0',
        deviceTypeIdentifier: 'iPhone',
        available: true,
      });
    recordCreatedDevice('ios', 'OWNED');
    const simctl: string[][] = [];
    const unexpected = (file: string, args: readonly string[] = []) => {
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    setExecutor({
      run: (cmd) => unexpected(cmd),
      runFile: unexpected,
      runQuiet: (cmd) => unexpected(cmd),
      runFileQuiet: (file, args) => (file === 'ps' ? '' : unexpected(file, args)),
      runFileQuietAsync: async (file, args) => unexpected(file, args),
      spawn: (cmd, args) => unexpected(cmd, args),
      findExecutable: () => null,
      runFileAsync: async (file, args) => {
        if (file !== 'xcrun' || args[0] !== 'simctl') return unexpected(file, args);
        simctl.push(args);
        if (args[1] === 'list')
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-0': sims.map((sim) => ({ ...sim, isAvailable: true })),
            },
          });
        if (args[1] === 'delete') return '';
        return unexpected(file, args);
      },
    });
    const ladder = async (act: boolean) =>
      (
        await runLadder(
          {
            config,
            act,
            log,
            devices: [],
            sims,
            simsFailed: false,
            remeasure: async () => pressure('high'),
            force: { level: 'high', why: 'stim gc' },
            fromRung: 2,
            lastRung: 2,
          },
          pressure('normal'),
        )
      ).actions.map(({ target, outcome }) => [target, outcome]);

    expect(await ladder(false)).toEqual([
      ['OWNED', 'would'],
      ['FOREIGN', 'kept'],
    ]);
    expect(simctl).toEqual([]);

    expect(await ladder(true)).toEqual([
      ['OWNED', 'done'],
      ['FOREIGN', 'kept'],
    ]);
    expect(simctl.filter((args) => args[1] === 'delete')).toEqual([['simctl', 'delete', 'OWNED']]);
    expect(readParked('ios').map((record) => record.udid)).toEqual(['FOREIGN']);
  });

  const forced = (
    level: 'high' | 'critical',
    fromRung: number,
    operation = testContext(),
    { measured = false, lastRung }: { measured?: boolean; lastRung?: number } = {},
  ) => {
    const config = loadConfig();
    if (!config) throw new Error('the test home has no config');
    return runLadder(
      {
        config,
        act: false,
        log,
        devices: [],
        simsFailed: false,
        remeasure: async () => pressure('normal'),
        force: { level, why: 'stim gc', measured },
        fromRung,
        ...(lastRung === undefined ? {} : { lastRung }),
        operation,
      },
      pressure('normal'),
    );
  };

  test.skipIf(process.platform === 'win32')(
    'rung 9 plans the other tools cache cleaners only at critical, and never from a scoped home',
    async () => {
      setExecutor({
        ...getExecutor(),
        runFileAsync: async () => '',
        runFileQuietAsync: async (file) =>
          file === 'ps' ? `${process.pid} node vitest\n` : file === 'lsof' ? `p${process.pid}\nn/\n` : null,
        findExecutable: (name) => (name === 'npm' ? '/usr/local/bin/npm' : null),
      });
      mkdirSync(join(projects, '.npm'), { recursive: true });
      const unscoped = testContext({
        env: { ...process.env, STIM_HOME: undefined, ANDROID_HOME: projects, npm_config_cache: join(projects, '.npm') },
      });
      const planned = async (
        level: 'high' | 'critical',
        operation = unscoped,
        options: { measured?: boolean; lastRung?: number } = {},
      ) => (await forced(level, 9, operation, options)).actions.filter((action) => action.kind === 'clean-tool-cache');

      expect(await planned('high')).toEqual([]);
      expect(await planned('critical', testContext())).toEqual([]);
      expect(await planned('critical')).toEqual([expect.objectContaining({ rung: 9, outcome: 'would' })]);
      expect(await planned('critical', unscoped, { lastRung: 8 })).toEqual([]);

      const cacheDevice = statSync(join(projects, '.npm')).dev;
      const disk = vi.spyOn(daemonMeasure, 'measureDisk');
      disk.mockResolvedValue([{ volume: '/', freeMb: 500 * 1024, device: cacheDevice }]);
      expect(await planned('critical', unscoped, { measured: true })).toEqual([]);
      disk.mockResolvedValue([{ volume: '/', freeMb: 1024, device: cacheDevice }]);
      expect(await planned('critical', unscoped, { measured: true })).toEqual([
        expect.objectContaining({ rung: 9, outcome: 'would' }),
      ]);
      disk.mockResolvedValue([
        { volume: '/', freeMb: 1024, device: cacheDevice + 1 },
        { volume: '/', freeMb: 500 * 1024, device: cacheDevice },
      ]);
      expect(await planned('critical', unscoped, { measured: true })).toEqual([
        expect.objectContaining({
          rung: 9,
          outcome: 'kept',
          detail: expect.stringContaining('not under the critical level'),
        }),
      ]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    "the stim-daemon's rung 9 runs at most hourly by the clock its disk passes share, whichever thread runs them",
    async () => {
      setExecutor({
        ...getExecutor(),
        runFileAsync: async () => '',
        runFileQuietAsync: async (file) =>
          file === 'ps' ? `${process.pid} node vitest\n` : file === 'lsof' ? `p${process.pid}\nn/\n` : null,
        findExecutable: (name) => (name === 'npm' ? '/usr/local/bin/npm' : null),
      });
      mkdirSync(join(projects, '.npm'), { recursive: true });
      vi.spyOn(daemonMeasure, 'measureDisk').mockResolvedValue([
        { volume: '/', freeMb: 1024, device: statSync(join(projects, '.npm')).dev },
      ]);
      const operation = testContext({
        env: { ...process.env, STIM_HOME: undefined, ANDROID_HOME: projects, npm_config_cache: join(projects, '.npm') },
      });
      const cleaned = async (cadence: BigInt64Array) =>
        (
          await runDiskPass(
            { act: false, pressure: pressure('critical'), devices: [], sims: [], requested: false },
            log,
            operation,
            cadence,
          )
        ).actions.filter((action) => action.kind === 'clean-tool-cache');

      const ranRecently = new BigInt64Array(Object.keys(LADDER_CLOCK_SLOTS).length);
      ranRecently[LADDER_CLOCK_SLOTS.unowned] = BigInt(Date.now() - 10 * MINUTE_MS);
      expect(await cleaned(ranRecently)).toEqual([]);

      const neverRan = new BigInt64Array(Object.keys(LADDER_CLOCK_SLOTS).length);
      const before = Date.now();
      expect(await cleaned(neverRan)).toEqual([expect.objectContaining({ rung: 9, outcome: 'would' })]);
      expect(Number(neverRan[LADDER_CLOCK_SLOTS.unowned])).toBeGreaterThanOrEqual(before);
      expect(await cleaned(neverRan)).toEqual([]);
    },
  );
});

describe('the ladder a build runs for its headroom', () => {
  let DEVICE: number;
  beforeEach(() => {
    DEVICE = statSync(home).dev;
  });

  function parked(count: number) {
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    vi.spyOn(gcDevices, 'deleteParkedSims').mockImplementation(async (taken) => {
      deleted.push(...taken.map((sim) => sim.udid));
      for (const sim of taken) recordGcResult('parkedDevice', 'done', sim.name);
      return taken.length;
    });
    const sim = { deviceTypeIdentifier: 'iPhone', runtimeIdentifier: 'iOS-26-0', simslimManaged: false };
    const config = loadConfig();
    if (!config) throw new Error('the test home has no config');
    saveConfig({
      ...config,
      parked: {
        ios: Array.from({ length: count }, (_, index) => ({
          ...sim,
          udid: `PARKED-${index}`,
          name: `stim-parked-${index}`,
          parkedAt: new Date(Date.now() - (10 - index) * DAY_MS).toISOString(),
        })),
      },
    });
  }

  function freeOnBuildDevice(startGb: number, perDeletionGb: number) {
    const disk = vi.spyOn(daemonMeasure, 'measureDisk');
    disk.mockImplementation(async () => [
      { volume: '/', freeMb: (startGb + deleted.length * perDeletionGb) * 1024, device: DEVICE },
      { volume: '/other', freeMb: 1024, device: DEVICE + 1 },
    ]);
    return disk;
  }

  const run = (targetGb: number, device = DEVICE, act?: boolean) =>
    runLadderToFree({
      operation: testContext({ env: { ...process.env, CI: undefined, STIM_DAEMON: undefined } }),
      signal: new AbortController().signal,
      device,
      freeMb: targetGb * 1024,
      act,
      protectedRoot: join(projects, 'build'),
    });

  test('frees only what the target needs on the build device, below and above disk.minFreeGb, and ignores other volumes', async () => {
    parked(4);
    freeOnBuildDevice(22, 1);
    await run(24);
    expect(deleted).toEqual(['PARKED-0', 'PARKED-1']);

    deleted.length = 0;
    freeOnBuildDevice(35, 5);
    await run(50);
    expect(deleted).toEqual(['PARKED-0', 'PARKED-1', 'PARKED-2']);

    deleted.length = 0;
    freeOnBuildDevice(10, 0);
    await run(24);
    expect(deleted).toEqual(['PARKED-0']);

    deleted.length = 0;
    freeOnBuildDevice(10, 1);
    await run(24, DEVICE + 1);
    expect(deleted).toEqual([]);
  });

  test('a disk pass on the owner measures again before it acts, so a level that fell from critical to high takes only what high needs', async () => {
    parked(3);
    vi.spyOn(daemonMeasure, 'measureDisk').mockImplementation(async () => [
      { volume: '/', freeMb: (30 + deleted.length * 20) * 1024, device: DEVICE },
    ]);
    const critical: DaemonPressure = { ...pressure('critical'), reasons: ['critical when the pass was asked'] };

    await runDiskPass({ act: true, pressure: critical, devices: [], sims: [], requested: false }, log, testContext());

    expect(deleted).toEqual(['PARKED-0']);
  });

  test('a headroom read that outlives its deadline releases the owner before the filesystem answers', async () => {
    vi.useFakeTimers();
    let finish!: (disk: Awaited<ReturnType<typeof daemonMeasure.measureDisk>>) => void;
    vi.spyOn(daemonMeasure, 'measureDisk').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const asked = requestGcItem(() => run(24), LADDER);
    const next = vi.fn<() => Promise<boolean>>(async () => true);
    const waiting = requestGcItem(next);
    await vi.advanceTimersByTimeAsync(60_000);
    await asked.result;
    await expect(waiting.result).resolves.toBe(true);
    expect(next).toHaveBeenCalledOnce();
    finish([]);
    await Promise.resolve();
  });

  test.each(['report', 'off'] as const)(
    'a queued headroom turn respects a change to %s mode before grant',
    async (mode) => {
      parked(2);
      freeOnBuildDevice(10, 1);
      const turn = await acquireDisk(LADDER);
      const asked = requestGcItem(() => run(24, DEVICE, true), LADDER);
      const config = loadConfig();
      if (!config) throw new Error('missing config');
      saveConfig({ ...config, daemon: { ...config.daemon, mode } });
      turn.release();
      await asked.result;
      expect(deleted).toEqual([]);
    },
  );

  test('a queued headroom turn remeasures prior cleanup and starts no duplicate deletion when its target is met', async () => {
    parked(2);
    let freeMb = 10 * 1024;
    const disk = vi
      .spyOn(daemonMeasure, 'measureDisk')
      .mockImplementation(async () => [{ volume: '/', freeMb, device: DEVICE }]);
    const turn = await acquireDisk(LADDER);
    const asked = requestGcItem(() => run(24), LADDER);
    expect(disk).not.toHaveBeenCalled();
    freeMb = 30 * 1024;
    turn.release();
    await asked.result;
    expect(deleted).toEqual([]);
    expect(disk).toHaveBeenCalled();
  });
});

describe('rung 5 in stim gc', () => {
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
    recordWorkspaceUse(root, new Date(Date.now() - 2 * HOUR_MS));
  }

  const ladder = (level: 'high' | 'critical', protectedRoot?: string, act = true) =>
    runLadder(
      {
        config: loadConfig()!,
        act,
        log,
        devices: [],
        simsFailed: false,
        remeasure: async () => pressure(level),
        fromRung: 5,
        lastRung: 5,
        force: { level, why: 'test' },
        ...(protectedRoot ? { protectedRoot } : {}),
      },
      pressure(level),
    );

  const observe = () => {
    const config = loadConfig();
    if (!config) throw new Error('fixture config missing');
    return runDormantDependencies({
      config,
      act: false,
      log,
      devices: [],
      simsFailed: false,
      marks: true,
      operation: testContext(),
    });
  };

  test('it reports unknown inventory without discovering an unmarked worktree when process reads fail', async () => {
    const listed = getExecutor();
    setExecutor({
      ...listed,
      runFileQuietAsync: async (file, args, opts) =>
        file === 'ps' ? null : listed.runFileQuietAsync(file, args, opts),
    });
    const { idle } = linkedWorktrees(['idle']);
    register(idle);
    const { actions } = await ladder('high');
    expect(existsSync(join(idle, 'node_modules'))).toBe(true);
    expect(existsSync(join(idle, 'ios', 'Pods'))).toBe(true);
    expect(actions.filter((action) => action.rung === 5)).toEqual([
      expect.objectContaining({
        target: idle,
        outcome: 'kept',
        detail: expect.stringContaining('inventory is unknown'),
      }),
    ]);
  });

  test.skipIf(process.platform === 'win32')(
    'a read-only dry run retains the discovery preview without publishing marks',
    async () => {
      const { idle } = linkedWorktrees(['idle']);
      register(idle);
      const { actions } = await ladder('high', undefined, false);
      expect(actions.filter(({ rung, target }) => rung === 5 && target.startsWith(`${idle}${sep}`))).toHaveLength(2);
      expect(readGcMark(idle)).toBeNull();
      expect(existsSync(join(idle, 'node_modules'))).toBe(true);
    },
  );

  describe.skipIf(process.platform === 'win32')(
    'with the running processes listed (skipped on win32, where Stim cannot list them)',
    () => {
      const reports = (actions: readonly DaemonLadderAction[]) =>
        actions
          .filter((action) => action.rung === 5)
          .map(({ target, outcome, detail }) => [target, outcome, detail.startsWith('report only')]);

      test('it reports nothing of a worktree used a minute ago, and reports one used two hours ago', async () => {
        const { recent, idle } = linkedWorktrees(['recent', 'idle']);
        register(recent);
        register(idle);
        recordWorkspaceUse(recent, new Date(Date.now() - MINUTE_MS));
        await observe();
        const targets = reports((await ladder('high')).actions).map(([target]) => String(target));
        expect(targets.filter((target) => target.startsWith(`${recent}/`))).toHaveLength(2);
        expect(targets.filter((target) => target.startsWith(`${idle}/`))).toHaveLength(2);
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

      test('at high it keeps a clone under the private-bytes threshold and reports the rest, most private first, unknown last', async () => {
        const { clone, reinstalled, unknown } = linkedWorktrees(['clone', 'reinstalled', 'unknown']);
        for (const root of [clone, reinstalled, unknown]) register(root);
        measured(join(clone, 'node_modules'), REAL_BYTES_THRESHOLD - 1);
        measured(join(clone, 'ios', 'Pods'), REAL_BYTES_THRESHOLD);
        measured(join(reinstalled, 'node_modules'), 2 * REAL_BYTES_THRESHOLD);
        measured(join(reinstalled, 'ios', 'Pods'), 3 * REAL_BYTES_THRESHOLD, 'an older install');
        await observe();

        const rung5 = reports((await ladder('high')).actions);

        expect(existsSync(join(reinstalled, 'node_modules'))).toBe(true);
        expect(rung5.slice(0, 3)).toEqual([
          [join(clone, 'node_modules'), 'kept', false],
          [join(reinstalled, 'node_modules'), 'kept', true],
          [join(clone, 'ios', 'Pods'), 'kept', true],
        ]);
        expect(rung5.slice(3).toSorted()).toEqual(
          [join(reinstalled, 'ios', 'Pods'), join(unknown, 'ios', 'Pods'), join(unknown, 'node_modules')].map(
            (target) => [target, 'kept', true],
          ),
        );
      }, 20_000);

      test("it skips a worktree with no workspace in this home, the command's own workspace and one whose dev server runs", async () => {
        const { stranger, own, serving } = linkedWorktrees(['stranger', 'own', 'serving']);
        register(realpathSync.native(join(projects, 'repo')));
        register(own);
        register(serving, { metroPort: 59125, supervisor: { pid: process.pid, port: 59999 } });
        await observe();
        const { actions } = await ladder('high', own);
        for (const root of [stranger, own, serving]) expect(existsSync(join(root, 'node_modules'))).toBe(true);
        const reported = actions.filter((action) => action.rung === 5);
        expect(reported.some(({ target }) => target.startsWith(`${stranger}${sep}`))).toBe(false);
        expect(
          reported.every(({ outcome, detail }) => outcome === 'kept' && !detail.startsWith('report only: deleting')),
        ).toBe(true);
      });
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'the dormant stage for dependencies (skipped on win32, where Stim cannot list the running processes)',
  () => {
    test('after idle.dormantDays it deletes trees holding their own bytes or of unknown size, even ones worktree warm cannot restore, and keeps a workspace idle less long', async () => {
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
      writeFileSync(join(old, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
      recordWorkspaceUse(old, new Date(Date.now() - 4 * DAY_MS));
      recordWorkspaceUse(recent, new Date(Date.now() - DAY_MS / 2));
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
        expect.objectContaining({ kind: 'delete-dependencies', target: join(old, 'ios', 'Pods'), outcome: 'done' }),
      ]);
      expect(existsSync(join(old, 'node_modules'))).toBe(false);
      expect(existsSync(join(old, 'ios', 'Pods'))).toBe(false);
      expect(readJsonObject(workspaceLightenedFile(old))?.dirs).toEqual([
        join(old, 'node_modules'),
        join(old, 'ios', 'Pods'),
      ]);
      expect(existsSync(join(recent, 'node_modules'))).toBe(true);
    }, 20_000);
  },
);

describe('rung timing records', () => {
  const steps = () =>
    log.mock.calls
      .filter(([, event]) => event === 'daemon_step')
      .map(([logLevel, , , fields]) => Object.assign({ logLevel }, fields));
  const run = (operation?: ReturnType<typeof testContext>) => {
    const config = loadConfig();
    if (!config) throw new Error('missing fixture config');
    return runLadder(
      {
        config,
        act: true,
        log,
        devices: [],
        simsFailed: false,
        remeasure: async () => pressure('high'),
        fromRung: 2,
        lastRung: 2,
        ...(operation ? { operation } : {}),
      },
      pressure('high'),
    );
  };

  beforeEach(() => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
  });

  test('a rung that finishes records its start, duration, actions and outcome', async () => {
    vi.spyOn(simPool, 'readParked').mockReturnValue([]);

    await run();

    expect(steps()).toEqual([
      {
        logLevel: 'debug',
        step: 'rung',
        rung: 2,
        pressureLevel: 'high',
        startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        durationMs: 100,
        items: 0,
        outcome: 'finished',
      },
    ]);
  });

  test('a rung that throws records the failure, and the ladder goes on as before', async () => {
    vi.spyOn(simPool, 'readParked').mockImplementation(() => {
      throw new Error('boom');
    });

    const { actions } = await run();

    expect(steps()).toMatchObject([{ step: 'rung', rung: 2, outcome: 'threw', error: 'boom' }]);
    expect(actions).toMatchObject([{ rung: 2, kind: 'rung', outcome: 'failed', detail: 'boom' }]);
    expect(log).toHaveBeenCalledWith('warn', 'pressure_rung_failed', 'rung 2 failed: boom');
  });

  test('a rung stopped by an abort records it and the abort still reaches the caller', async () => {
    const controller = new AbortController();
    vi.spyOn(simPool, 'readParked').mockImplementation(() => {
      controller.abort();
      throw new Error('stopped');
    });

    await expect(run(testContext({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(steps()).toMatchObject([{ step: 'rung', rung: 2, outcome: 'aborted' }]);
    expect(steps()[0]).not.toHaveProperty('error');
  });
});

describe("the daemon tick's ladder pacing", () => {
  const GB = 1024;
  const MINUTE = 60_000;
  let ladder: MockInstance<typeof ladderModule.runLadder>;

  const FULL = 512;
  const OTHER = 10 * GB;

  function measuredAt(free: [number, number] = [FULL, OTHER], memory: 'normal' | 'high' | 'critical' = 'normal') {
    vi.spyOn(daemonMeasure, 'measureTick').mockResolvedValue({
      measurement: {
        disk: free.map((freeMb, i) => ({ volume: `/volume${i + 1}`, freeMb, device: i + 1 })),
        memory: {
          level: memory === 'critical' ? memory : 'normal',
          availableBytes: memory === 'high' ? 0 : null,
          totalBytes: 1,
        },
        load1: 0,
        cores: 1,
        bootedSimulators: 0,
        runningEmulators: null,
        interaction: null,
      },
      sims: [],
      simsError: null,
      devices: [],
    });
  }

  function passTaking(outcomes: DaemonLadderAction['outcome'][], bytes = 1) {
    ladder.mockImplementation(async (_input, level) => {
      vi.setSystemTime(Date.now() + 90_000);
      return {
        actions: outcomes.map((outcome) => ({
          rung: 3,
          kind: 'empty-cache',
          target: '/cache',
          outcome,
          bytes,
          detail: '',
        })),
        pressure: level,
      };
    });
  }

  beforeEach(() => {
    vi.spyOn(bootedParked, 'runBootedParkedPass').mockResolvedValue([]);
    vi.spyOn(idlePass, 'runIdlePass').mockResolvedValue([]);
    vi.spyOn(stages, 'runDormantPass').mockResolvedValue([]);
    ladder = vi.spyOn(ladderModule, 'runLadder').mockImplementation(async (_input, level) => ({
      actions: [],
      pressure: level,
    }));
  });

  test('records the levels, each volume, duration and whether a pass took an action, and nothing at normal', async () => {
    measuredAt();
    passTaking(['kept', 'would']);
    const fruitless = await runHomePasses({ act: true, log });
    passTaking(['kept', 'done']);
    const freed = await runHomePasses({ act: true, log, requested: true });

    const pass = {
      disk: 'critical',
      memory: 'normal',
      volumes: { 1: { freeMb: FULL, level: 'critical' }, 2: { freeMb: OTHER, level: 'critical' } },
      durationMs: 90_000,
      endedAt: Date.now(),
    };
    expect(fruitless.ladder).toEqual({ ...pass, freed: false, endedAt: Date.now() - 90_000 });
    expect(freed.ladder).toEqual({ ...pass, freed: true });
    measuredAt([100 * GB, 100 * GB]);
    expect((await runHomePasses({ act: true, log, lastLadder: freed.ladder })).ladder).toBeNull();
  });

  const SHORT = 30 * GB;
  const ROOMY = 100 * GB;
  const fruitless: Omit<LadderPass, 'endedAt'> = {
    disk: 'high',
    memory: 'normal',
    volumes: { 1: { freeMb: SHORT, level: 'high' }, 2: { freeMb: ROOMY, level: 'normal' } },
    freed: false,
    durationMs: MINUTE,
  };
  const atCritical: Omit<LadderPass, 'endedAt'> = {
    ...fruitless,
    disk: 'critical',
    volumes: { 1: { freeMb: FULL, level: 'critical' }, 2: { freeMb: ROOMY, level: 'normal' } },
  };
  test.each<[string, Omit<LadderPass, 'endedAt'>, Parameters<typeof measuredAt>, number, boolean, boolean]>([
    ['runs after a pass that took an action', { ...fruitless, freed: true }, [], 0, false, true],
    ['waits under four times a fruitless pass', fruitless, [], 4 * MINUTE - 1, false, false],
    ['runs at four times a fruitless pass', fruitless, [], 4 * MINUTE, false, true],
    [
      'runs 15 minutes after a long fruitless pass',
      { ...fruitless, durationMs: 10 * MINUTE },
      [],
      15 * MINUTE,
      false,
      true,
    ],
    ['runs when disk rose to high', { ...fruitless, disk: 'normal' }, [], 0, false, true],
    ['runs when memory pressure rose', fruitless, [undefined, 'high'], 0, false, true],
    ['waits at critical under a minute after a fruitless pass', atCritical, [[FULL, ROOMY]], MINUTE - 1, false, false],
    [
      'runs at critical a minute after a long fruitless pass',
      { ...atCritical, durationMs: 10 * MINUTE },
      [[FULL, ROOMY]],
      MINUTE,
      false,
      true,
    ],
    [
      'runs at critical at four times a short fruitless pass',
      { ...atCritical, durationMs: 1000 },
      [[FULL, ROOMY]],
      4000,
      false,
      true,
    ],
    ['runs at critical once the short volume lost 256 MB', atCritical, [[FULL - 256, ROOMY]], 0, false, true],
    [
      'waits at high while the short volume lost under 256 MB and another under 1 GB',
      fruitless,
      [[SHORT - 255, ROOMY - GB + 1]],
      0,
      false,
      false,
    ],
    ['runs at high once the short volume lost 256 MB', fruitless, [[SHORT - 256, ROOMY]], 0, false, true],
    ['runs once a volume with room lost 1 GB', fruitless, [[SHORT, ROOMY - GB]], 0, false, true],
    [
      'runs when a volume was not measured before',
      { ...fruitless, volumes: { 1: { freeMb: SHORT, level: 'high' } } },
      [],
      0,
      false,
      true,
    ],
    [
      'runs when a volume reached a higher level',
      { ...fruitless, volumes: { ...fruitless.volumes, 2: { freeMb: 40 * GB - 1, level: 'normal' } } },
      [[SHORT, 40 * GB - 1]],
      0,
      false,
      true,
    ],
    ['runs when a command asked for the tick', fruitless, [], 0, true, true],
    ['waits at high after a fruitless pass at critical', atCritical, [], MINUTE, false, false],
  ])('%s', async (_name, last, measurement, elapsedMs, requested, runs) => {
    measuredAt(measurement[0] ?? [SHORT, ROOMY], measurement[1]);
    const lastLadder = { ...last, endedAt: Date.now() - elapsedMs };

    const passes = await runHomePasses({ act: true, log, lastLadder, requested });

    expect(ladder.mock.calls.length > 0).toBe(runs);
    expect(passes.ladder === lastLadder).toBe(!runs);
  });

  test('a pass whose actions freed no bytes freed nothing, so the next pass waits', async () => {
    measuredAt([SHORT, ROOMY]);
    passTaking(['done'], 0);

    const first = await runHomePasses({ act: true, log });
    await runHomePasses({ act: true, log, lastLadder: first.ladder });

    expect(first.ladder).toMatchObject({ freed: false });
    expect(ladder).toHaveBeenCalledTimes(1);
  });
});

test('deleteOutputs stops before the next removal once its operation is aborted', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-delete-outputs-'));
  onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  const paths = ['one', 'two'].map((name) => join(base, name));
  for (const path of paths) mkdirSync(path);
  const controller = new AbortController();
  vi.spyOn(fsUtil, 'measureDirectoryAsync').mockImplementation(async () => {
    controller.abort();
    return { bytes: 1 };
  });

  await expect(idlePass.deleteOutputs(paths, controller.signal)).rejects.toThrow('aborted');

  for (const path of paths) expect(existsSync(path)).toBe(true);
});

test('deleteOutputs reports the bytes a timed-out walk finished as a lower bound and still deletes', async () => {
  const output = join(home, 'build');
  for (const name of ['intermediates', 'outputs']) mkdirSync(join(output, name), { recursive: true });
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (_file, args) => {
      if (args.at(-1) === join(output, 'intermediates')) return `${6 * 1024}\t${args.at(-1)}`;
      throw Object.assign(new Error('Command timed out after 120000ms: du'), { code: 'ETIMEDOUT', stdout: '' });
    },
  });

  expect(await idlePass.deleteOutputs([output])).toEqual({ bytes: 6 * 1024 * 1024, partial: true });
  expect(existsSync(output)).toBe(false);
});
