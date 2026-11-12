import assert from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { METRO_NAMED_CACHE_LAYOUT, withAmbientContext, withDirLockTransaction, type StimContext } from '@stim-cli/core';
import {
  easMachineStateRoot,
  gcLogFile,
  isGcLogRecord,
  readGcLog,
  deviceHostArea,
  deviceHostRoot,
  hostedDeviceId,
  readHostedDeviceLedger,
  configLockPath,
  createdDevicesLock,
  type HostedDeviceSession,
  type HostedIosDevice,
} from '@stim-cli/core/state';
import { collectParkedHostedDevices, deleteParkedHostedDevices } from '../commands/gc/hosted-devices.ts';
import { createGcResults, takeGcResults, type GcOutput } from '../commands/gc/results.ts';
import {
  collectDeviceRecords,
  collectProjectEasSessions,
  collectStaleClaims,
  findStaleEasLedgerEntries,
  type RecordDependencies,
} from '../commands/gc/records.ts';
import { listMountedVolumes } from '../fs-util.ts';
import { runReport, trackReportResource } from '../report-runtime.ts';
import * as identities from '../process-identity.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import { operationState } from '../engine/operation-state.ts';
import { testContext } from './_context.ts';
import type { ClaimHandle } from '../ownership-claim.ts';
import { runCli } from '../cli/define-op.ts';
import { getExecutor, setExecutor, resetExecutor, type Executor } from '../exec.ts';
import { readCreatedDevices, recordCreatedDevice } from '../devices/created-devices.ts';
import { getProject, saveConfig, loadConfig, upsertProject } from '../workspace/config.ts';
import { register } from '../cache/cache-manifest.ts';
import { discoverCaches } from '../cache/caches.ts';
import { ensureRemoteBootOwned, withRemoteSessionLock } from '../engine/device-remote.ts';
import * as deviceLease from '../engine/device-lease.ts';
import { deviceLeasePath, deviceLocksDir } from '../engine/device-lease.ts';
import { collectDeviceLeases } from '../commands/gc/devices.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import { collectEasSessionSweep, deleteEasSessions } from '../commands/gc/eas-sessions.ts';
import * as ownershipClaim from '../ownership-claim.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceStateFile } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import gcOp, {
  readGcReport,
  deleteParkedSims,
  describeParkedSims,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  runGc as runGcCommand,
} from '../commands/gc.ts';
import { adoptParked, parkSim, readParked } from '../devices/sim-pool.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import { forgetStaleLedgerEntries } from '../commands/gc/ledger.ts';
import { cacheClaimRoot } from '../cache/cache-claim.ts';
import { acquireAvdClaim } from '../devices/avd-claim.ts';
import * as reclaim from '../devices/reclaim.ts';
import { IMPOSSIBLE_PID, makeConfig, makeIosSim, goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

const ledgerIo = vi.hoisted((): { afterRename?: (path: unknown) => void } => ({}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const result = fs.renameSync(...args);
      ledgerIo.afterRename?.(args[1]);
      return result;
    },
  };
});

vi.mock('../devices/machine-cache-usage.ts', () => ({
  getMachineCacheReport: async () => ({
    measuredAt: new Date().toISOString(),
    complete: true,
    notices: [],
    gradle: { home: '', unusedVersions: [], usedVersions: [], unreadableProjects: [], modules: null },
    simRuntimes: { checked: true, runtimes: [] },
    deviceSupport: { entries: [], remedy: '' },
    orphanedDerivedData: [],
    runnerBuilds: { agentDeviceVersion: null, xcodeBuildVersion: null, groups: [], remedy: '' },
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

test('parked deletion skips a simulator adopted after report collection', async () => {
  upsertProject('/tmp/source', { platforms: { ios: { deviceUdid: 'P1', deviceName: 'stim-source', owned: true } } });
  upsertProject('/tmp/adopter', { platforms: {} });
  const record = {
    udid: 'P1',
    name: 'stim-parked (iPhone 17 26.5) p1',
    deviceTypeIdentifier: 'iphone-17',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    parkedAt: '2026-09-01T00:00:00.000Z',
    simslimManaged: false,
  };
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record, max: 3 });
  const report = describeParkedSims([record], [makeIosSim({ udid: 'P1', name: record.name })], []);
  const device = { deviceUdid: 'P1', deviceName: 'stim-adopter', owned: true };
  await adoptParked({ platform: 'ios', projectPath: '/tmp/adopter', udid: 'P1', device });
  let deleted = false;

  const output = await captureLog(() =>
    deleteParkedSims(report, {
      deleteParkedIosSim: async () => {
        deleted = true;
      },
    }),
  );

  expect(deleted).toBe(false);
  expect(output).toMatch(/no longer parked/);
  expect(getProject('/tmp/adopter')?.platforms?.ios).toEqual(device);
});

test.each(['parked', 'stale'])(
  'cancelling %s device-record cleanup does not wait for the config lock to be released',
  async (kind) => {
    const record = {
      udid: 'P1',
      name: 'stim-parked',
      deviceTypeIdentifier: 'iphone-17',
      runtimeIdentifier: 'ios-26-5',
      parkedAt: '2026-09-01T00:00:00.000Z',
      simslimManaged: false,
    };
    saveConfig({
      version: 2,
      projects: { [tmpHome]: { platforms: { ios: { deviceUdid: 'GONE' } } } },
      repos: {},
      parked: { ios: [record] },
    });
    let release = () => {};
    const holding = withDirLockTransaction(
      configLockPath(),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const operation = testContext({ cwd: tmpHome, signal: controller.signal });
    const pending = withAmbientContext(operation, () =>
      kind === 'parked'
        ? deleteParkedSims(
            [
              {
                udid: record.udid,
                name: record.name,
                model: null,
                runtime: null,
                parkedAt: record.parkedAt,
                app: null,
                bytes: null,
                listed: false,
              },
            ],
            { operation },
          )
        : gcDevices.deleteProjectDevices(
            [],
            [],
            [{ kind: 'ios', id: 'GONE', project: tmpHome, owned: false }],
            undefined,
            operation,
          ),
    );
    const settled = pending.catch((error: unknown) => error);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      const result = await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
      ]);
      expect(result).toMatchObject({ name: 'AbortError' });
      expect(readParked('ios')).toEqual([record]);
      expect(getProject(tmpHome)?.platforms?.ios?.deviceUdid).toBe('GONE');
      expect(readClaimSet(join(tmpHome, 'pool-locks', 'ios', 'p1.lock')).live).toEqual([]);
    } finally {
      release();
      await holding;
      await settled;
    }
  },
);

test('parked deletion keeps ownership records when simulator listing was unavailable', async () => {
  installExecutor();
  upsertProject('/tmp/source', { platforms: { ios: { deviceUdid: 'P1', deviceName: 'stim-source', owned: true } } });
  const record = {
    udid: 'P1',
    name: 'stim-parked (iPhone 17 26.5) p1',
    deviceTypeIdentifier: 'iphone-17',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    parkedAt: '2026-09-01T00:00:00.000Z',
    simslimManaged: false,
  };
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record, max: 3 });
  const parkedSims = await gcDevices.collectParkedSims({
    listAllIosSims: () => {
      throw new Error('simctl unavailable');
    },
  });

  let failures = 0;
  const output = await captureLog(async () => {
    failures = await deleteParkedSims(parkedSims);
  });

  expect(failures).toBe(1);
  expect(output).toMatch(/Could not verify.*record was kept/);
  expect(readParked('ios')).toEqual([record]);
});

test('findOrphanedDevices proposes only Stim devices absent from config', () => {
  const result = findOrphanedDevices({
    sims: [
      makeIosSim({ udid: 'U1', name: 'stim-gone' }),
      makeIosSim({ udid: 'U2', name: 'stim-live' }),
      makeIosSim({ udid: 'U3', name: 'iPhone 17 Pro' }),
    ],
    avds: ['stim-old', 'Pixel_7'],
    config: makeConfig({
      projects: {
        '/p': {
          platforms: {
            ios: { deviceUdid: 'U2', owned: true },
            android: { avdName: 'stim-kept', owned: true },
          },
        },
      },
    }),
    isMounted: () => true,
  });
  expect(result.orphaned.map((o) => o.id).toSorted()).toEqual(['U1', 'stim-old']);
});

test('a simulator in the parked pool is referenced rather than orphaned', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'P1', name: 'stim-parked (iPhone 17 26.5) p1' })],
    config: makeConfig({
      parked: {
        ios: [
          {
            udid: 'P1',
            name: 'stim-parked (iPhone 17 26.5) p1',
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            parkedAt: '2026-09-03T00:00:00.000Z',
            simslimManaged: false,
          },
        ],
        android: [],
      },
    }),
  });

  expect(result.orphaned).toEqual([]);
  expect(result.kept[0]?.reason).toBe('referenced by the simulator pool');
});

test('gc reports ledger UDIDs a complete simctl listing lacks, and --delete forgets only those', async () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  process.env.ANDROID_AVD_HOME = join(tmpHome, 'avd');
  const project = join(tmpHome, 'app');
  mkdirSync(project);
  saveConfig({
    version: 2,
    projects: { [project]: { platforms: { ios: { deviceUdid: 'LIVE', owned: true } } } },
    repos: {},
  });
  rmSync(join(tmpHome, 'created-devices.json'), { force: true });
  for (const udid of ['GONE', 'UNAVAILABLE', 'LIVE']) recordCreatedDevice('ios', udid);
  const device = (udid: string, isAvailable: boolean) => ({
    udid,
    name: `stim-${udid.toLowerCase()}`,
    state: 'Shutdown',
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
    isAvailable,
  });
  let listing: string | null = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [device('LIVE', true), device('UNAVAILABLE', false)],
    },
  });
  setExecutor({
    ...getExecutor(),
    run: () => '',
    runQuiet: () => null,
    runFileAsync: async (file, args, options) => getExecutor().runFile(file, args, options),
    runFile: (file, args) => {
      if (file === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
        if (listing === null) throw new Error('simctl timed out');
        return listing;
      }
      return '';
    },
  });
  try {
    expect((await deviceRecords()).staleLedgerEntries).toEqual([{ kind: 'ios', id: 'GONE' }]);

    listing = null;
    expect((await deviceRecords()).staleLedgerEntries).toEqual([]);
    await captureLog(() => runGc({ pressure: 'normal' }));
    expect([...readCreatedDevices().ios].toSorted()).toEqual(['GONE', 'LIVE', 'UNAVAILABLE']);

    listing = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [device('LIVE', true), device('UNAVAILABLE', false)],
      },
    });
    await captureLog(() => runGc({ pressure: 'normal' }));
    expect([...readCreatedDevices().ios].toSorted()).toEqual(['LIVE', 'UNAVAILABLE']);
  } finally {
    delete process.env.ANDROID_AVD_HOME;
  }
});

describe('android ledger names', () => {
  const GONE = 'stim-t1401-gone';
  const avdHome = () => join(tmpHome, 'avd');
  let listing: string | null;

  beforeEach(() => {
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    process.env.ANDROID_AVD_HOME = avdHome();
    mkdirSync(avdHome(), { recursive: true });
    mkdirSync(join(avdHome(), 'stim-t1401-data.avd'));
    writeFileSync(join(avdHome(), 'stim-t1401-ini.ini'), 'path=/Volumes/Offline/stim-t1401-ini.avd\n');
    const project = join(tmpHome, 'app');
    mkdirSync(project, { recursive: true });
    saveConfig({
      version: 2,
      projects: {
        [project]: {
          platforms: {
            android: { avdName: 'stim-t1401-reserved', owned: true, deviceName: 'x', setupIncomplete: true },
          },
        },
      },
      repos: {},
    });
    rmSync(join(tmpHome, 'created-devices.json'), { force: true });
    for (const name of [GONE, 'stim-t1401-listed', 'stim-t1401-data', 'stim-t1401-ini', 'stim-t1401-reserved'])
      recordCreatedDevice('android', name);
    listing = 'stim-t1401-listed\n';
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args, options) => getExecutor().runFile(file, args, options),
      run: (command) => {
        if (!command.includes('-list-avds')) return '';
        if (listing === null) throw new Error('emulator timed out');
        return listing;
      },
      runQuiet: () => null,
      runFile(file, args = []) {
        return this.run!([file, ...args].join(' '));
      },
    });
  });

  const androidEntries = async () =>
    (await deviceRecords()).staleLedgerEntries.filter((entry) => entry.kind === 'android');

  test.each(['config', 'device ledger'])(
    'cancelling while waiting for the %s lock keeps the AVD ledger entry and releases admission',
    async (kind) => {
      const lock = kind === 'config' ? configLockPath() : createdDevicesLock();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = withDirLockTransaction(lock, () => gate);
      const controller = new AbortController();
      const reason = new Error('cancel queued ledger cleanup');
      let admitted = 0;
      let ledgerHeldWhileConfigWaits = 0;
      const avdRoot = join(tmpHome, 'avd-locks', `${encodeURIComponent(GONE)}.lock`);
      try {
        const forgetting = forgetStaleLedgerEntries([{ kind: 'android', id: GONE }], undefined, controller.signal);
        setImmediate(() => {
          admitted = readClaimSet(avdRoot).live.length;
          if (kind === 'config')
            ledgerHeldWhileConfigWaits = readClaimSet(createdDevicesLock() + '.claims').live.length;
          controller.abort(reason);
        });
        await expect(forgetting).rejects.toBe(reason);
        expect(admitted).toBe(1);
        expect(ledgerHeldWhileConfigWaits).toBe(0);
        expect(readCreatedDevices().android.has(GONE)).toBe(true);
        expect(readClaimSet(avdRoot).live).toEqual([]);
      } finally {
        release();
        await holding;
      }
      for (const root of [configLockPath() + '.claims', createdDevicesLock() + '.claims']) {
        expect(readClaimSet(root).live).toEqual([]);
      }
    },
  );

  test('only a name with no registration, data, listing or unfinished setup is stale, and gc forgets it', async () => {
    expect(await androidEntries()).toEqual([{ kind: 'android', id: GONE }]);
    await captureLog(() => runGc({ pressure: 'normal' }));
    expect([...readCreatedDevices().android].toSorted()).toEqual([
      'stim-t1401-ini',
      'stim-t1401-listed',
      'stim-t1401-reserved',
    ]);
  });

  test.each([
    ['the emulator listing fails', () => (listing = null)],
    ['the first AVD root is missing, as on an unmounted volume', () => rmSync(avdHome(), { recursive: true })],
  ])('nothing is pruned when %s', async (_, breakIt) => {
    breakIt();
    expect(await androidEntries()).toEqual([]);
    await captureLog(() => runGc({ pressure: 'normal' }));
    expect(readCreatedDevices().android.has(GONE)).toBe(true);
  });

  test('a name recreated after the report, or claimed by a running setup, is kept', async () => {
    const entries = await androidEntries();
    writeFileSync(join(avdHome(), `${GONE}.ini`), `path=${join(avdHome(), `${GONE}.avd`)}\n`);
    const output = await captureLog(() => forgetStaleLedgerEntries(entries));
    expect(output).toContain(`Kept the ledger entry for android ${GONE}`);
    rmSync(join(avdHome(), `${GONE}.ini`));

    const claim = acquireAvdClaim(GONE);
    try {
      expect(await captureLog(() => forgetStaleLedgerEntries(entries))).toContain(
        `Could not forget the ledger entry for android ${GONE}`,
      );
    } finally {
      releaseClaim(claim);
    }
    expect(readCreatedDevices().android.has(GONE)).toBe(true);
  });
});

test('cancelling device ledger cleanup after one commit preserves remaining entries', async () => {
  recordCreatedDevice('ios', 'cancel-first');
  recordCreatedDevice('ios', 'cancel-later');
  const before = [...readCreatedDevices().ios];
  const controller = new AbortController();
  const reason = new Error('cancel after ledger commit');
  ledgerIo.afterRename = (file) => {
    if (String(file) === join(tmpHome, 'created-devices.json')) controller.abort(reason);
  };
  const outcome = await Promise.resolve()
    .then(() =>
      forgetStaleLedgerEntries(
        [
          { kind: 'ios', id: 'cancel-first' },
          { kind: 'ios', id: 'cancel-later' },
        ],
        undefined,
        controller.signal,
      ),
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  expect(controller.signal.aborted).toBe(true);
  expect(outcome).toEqual({ error: reason });
  expect([...readCreatedDevices().ios]).toEqual(before.filter((id) => id !== 'cancel-first'));
  expect(readClaimSet(createdDevicesLock() + '.claims').live).toEqual([]);
});

test('gc sizes only listed owned Android AVDs after ownership classification', async () => {
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const project = join(tmpHome, 'stale-project');
  mkdirSync(project, { recursive: true });
  saveConfig({
    version: 2,
    projects: {
      [project]: { platforms: { android: { avdName: 'stim-stale', owned: true } } },
    },
    repos: {},
  });
  const sized: string[] = [];
  const sizeTimeouts: Array<number | 'unbounded'> = [];
  setExecutor({
    run(cmd) {
      if (cmd.includes('simctl list devices --json')) return JSON.stringify({ devices: {} });
      if (cmd.endsWith(' -list-avds')) {
        return 'stim-orphan\nstim-stale\nstim-unreadable\nPixel_7\n';
      }
      throw new Error(`unexpected run: ${cmd}`);
    },
    runFile(file, args = []) {
      if (args[0] === '-list-avds') return this.run!([file, ...args].join(' '));
      return JSON.stringify({ devices: {} });
    },
    runQuiet: () => null,
    runFileQuiet: () => null,
    spawn: () => null,
  });

  const report = await collectDeviceRecords(loadConfig(), [], {
    avdDirectory: (name) => `/avds/${name}.avd`,
    directorySize: (dir, options) => {
      sized.push(dir);
      sizeTimeouts.push(options.timeoutMs);
      if (dir.includes('unreadable')) throw new Error('timed out');
      return dir.includes('orphan') ? 5 * 1024 ** 3 : 2 * 1024 ** 3;
    },
  });

  expect(report.orphanedDevices).toContainEqual({
    kind: 'android',
    id: 'stim-orphan',
    name: 'stim-orphan',
    bytes: 5 * 1024 ** 3,
  });
  expect(report.orphanedDevices).toContainEqual({
    kind: 'android',
    id: 'stim-unreadable',
    name: 'stim-unreadable',
  });
  expect(sized).toEqual(['/avds/stim-orphan.avd', '/avds/stim-unreadable.avd', '/avds/stim-stale.avd']);
  expect(sizeTimeouts).toEqual([5000, 5000, 5000]);
});

const staleSims = [makeIosSim({ udid: 'U-STALE', name: 'stim-stale' })];

function staleConfig(extra = {}) {
  return makeConfig({
    projects: {
      '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE', owned: true } } },
      ...extra,
    },
  });
}

test('findStaleDeviceRecords proposes nothing for a platform whose listing failed', () => {
  const config = makeConfig({
    projects: {
      '/a': { platforms: { ios: { deviceUdid: 'GONE' }, android: { avdName: 'stim-gone' } } },
    },
  });
  expect(findStaleDeviceRecords({ config, sims: [], avds: [], simsChecked: false }).map((r) => r.kind)).toEqual([
    'android',
  ]);
  expect(findStaleDeviceRecords({ config, sims: [], avds: [], avdsChecked: false }).map((r) => r.kind)).toEqual([
    'ios',
  ]);
  expect(findStaleDeviceRecords({ config, simsChecked: false, avdsChecked: false })).toEqual([]);
});

test('findStaleDeviceRecords skips a project the dead-entry sweep already claimed', () => {
  const stale = findStaleDeviceRecords({
    config: makeConfig({ projects: { '/dead': { platforms: { ios: { deviceUdid: 'GONE' } } } } }),
    sims: [],
    deadProjects: ['/dead'],
  });
  expect(stale).toEqual([]);
});

test('findStaleProjectDevices fails closed when a project timestamp cannot be read', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => NaN,
  });
  expect(stale.length).toBe(0);
});

test('findStaleProjectDevices ignores devices Stim does not own', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: makeConfig({ projects: { '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE' } } } } }),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
  });
  expect(stale.length).toBe(0);
});

test('findStaleDeviceRecords still clears a dangling claim held by a key that is not absolute', () => {
  const stale = findStaleDeviceRecords({
    config: makeConfig({
      projects: { '.claude/stim-worktrees/nestrel': { platforms: { ios: { deviceUdid: 'GONE', owned: true } } } },
    }),
    sims: [],
    avds: [],
  });
  expect(stale.map((r) => r.id)).toEqual(['GONE']);
});

test('findStaleProjectDevices skips projects the dead-entry sweep already claimed', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
    deadProjects: ['/live/p'],
  });
  expect(stale.length).toBe(0);
});

let tmpHome: string;
let fakeHome: string;
let testSignal: AbortSignal;
let originalHomeRoots: Record<string, string | undefined>;
let originalTmpRoots: Record<string, string | undefined>;
let originalAvdRoots: Record<string, string | undefined>;

const HOME_ENV_KEYS = ['HOME', 'USERPROFILE'];
const TMP_ENV_KEYS = process.platform === 'win32' ? ['TMPDIR', 'TEMP', 'TMP'] : ['TMPDIR'];

function deviceRecords(deps: RecordDependencies = {}) {
  return collectDeviceRecords(loadConfig(), [], deps);
}

function currentConfig() {
  const cfg = loadConfig();
  assert(cfg, 'expected a config on disk');
  return cfg;
}

function stubDu() {
  const base = getExecutor();
  setExecutor({
    ...base,
    runFileAsync: async (file, args, options) =>
      file === 'du' ? `8\t${args?.at(-1) ?? ''}` : base.runFileAsync(file, args, options),
  });
}

function installExecutor() {
  setExecutor({
    run(cmd) {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet() {
      return null;
    },
    runFileQuiet() {
      return null;
    },
    spawn(cmd) {
      throw new Error(`unexpected spawn: ${cmd}`);
    },
  });
}

function runGc(opts: Parameters<typeof runGcCommand>[0] = {}, deps: Parameters<typeof runGcCommand>[1] = {}) {
  const operation = deps.operation ?? testContext({ env: { ...process.env }, signal: testSignal });
  return withAmbientContext(operation, () => runGcCommand(opts, deps));
}

async function cli(args: string[] = []) {
  await runCli(gcOp, args, { version: '9.9.9' });
}

async function sweepingGc(opts: Parameters<typeof runGcCommand>[0] = {}) {
  const scope = vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  try {
    await runGc(opts);
  } finally {
    scope.mockRestore();
  }
}

interface GcPayloadAction {
  rung: number | null;
  kind: string;
  target: string;
  outcome: string;
  detail: string;
}

async function gcJson(opts: Parameters<typeof runGcCommand>[0], sweep = false) {
  const { stdout } = await captureJson(() => (sweep ? sweepingGc : runGc)({ ...opts, json: true }));
  return JSON.parse(stdout.at(-1) ?? '') as {
    actions: GcPayloadAction[];
    actionable: boolean;
    failures: number | null;
    results: { kind: string; status: string; label: string; id: string | null }[];
    sections?: Record<string, never>;
  };
}

async function captureJson(fn: () => unknown) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...args) => void stderr.push(args.join(' ')));
  try {
    await fn();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { stdout, stderr: stderr.join('\n') };
}

function captureLog(fn: () => unknown) {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => logs.join('\n'));
}

async function easGc(act: boolean, deps: RecordDependencies) {
  const results = createGcResults();
  const lines: string[] = [];
  const sweep = await collectProjectEasSessions(deps);
  const output: GcOutput = {
    log: (line) => void lines.push(line),
    error: (line) => void lines.push(line),
    record: results.record,
    fail: () => {},
  };
  const failures = act && sweep ? await deleteEasSessions(sweep, deps, output) : 0;
  return { sweep, failures, results: results.take(), output: [...(sweep?.notices ?? []), ...lines].join('\n') };
}

async function easOutput(act: boolean, deps: RecordDependencies): Promise<string> {
  return (await easGc(act, deps)).output;
}

interface EasCall {
  args: string[];
  options: { cwd?: string; timeoutMs?: number; omitEnv?: readonly string[] };
}

type EasResponse = string | Error | ((options: EasCall['options']) => string | Error);

function easGcHarness({
  project,
  list,
  get = {},
  stop = {},
}: {
  project: string;
  list:
    | string
    | Error
    | Record<string, string | Error>
    | ((after: string, page: number, options: EasCall['options']) => string | Error);
  get?: Record<string, EasResponse>;
  stop?: Record<string, EasResponse>;
}) {
  const appJson = join(project, 'app.json');
  if (!existsSync(appJson)) writeFileSync(appJson, '{"expo":{}}');
  const calls: EasCall[] = [];
  let page = 0;
  return {
    calls,
    deps: {
      operation: testContext({ env: { ...process.env }, signal: testSignal }),
      easLedgerRoot: join(fakeHome, 'machine-eas'),
      findProjectRoot: () => project,
      detectIsExpo: () => true,
      resolveEasCliBin: () => ({ file: '/bin/eas', source: 'path' as const }),
      runEasFile(_file: string, args: string[], options: EasCall['options']) {
        calls.push({ args, options });
        const id = args[args.indexOf('--id') + 1] ?? '';
        const after = args.includes('--after') ? (args[args.indexOf('--after') + 1] ?? '') : 'first';
        const listValue =
          typeof list === 'function'
            ? list(after, page++, options)
            : typeof list === 'object' && !(list instanceof Error)
              ? list[after]
              : list;
        const selected = args[0] === 'simulator:list' ? listValue : args[0] === 'simulator:get' ? get[id] : stop[id];
        const value = typeof selected === 'function' ? selected(options) : selected;
        if (value instanceof Error) throw value;
        return value ?? '';
      },
    },
  };
}

function easList(
  sessions: Array<{ id?: string; name?: string; status?: string; platform?: string | null }> = [],
  pageInfo: { hasNextPage?: unknown; endCursor?: unknown } = { hasNextPage: false, endCursor: null },
): string {
  return JSON.stringify({ sessions, pageInfo });
}

function registerExpoProject(project: string): void {
  mkdirSync(project, { recursive: true });
  saveConfig({ version: 2, projects: { [project]: { isExpo: true } }, repos: {} });
}

function writeRemoteState(project: string, value: unknown): void {
  ensureWorkspaceStorage(project);
  writeFileSync(workspaceStateFile(project), typeof value === 'string' ? value : JSON.stringify(value));
}

function writeEasLedger(
  ledgerRoot: string,
  claims: Array<{
    sessionId: string;
    name: string;
    platform: 'ios' | 'android';
    workspaceRoot: string;
    stateFile: string;
  }>,
): void {
  mkdirSync(ledgerRoot, { recursive: true });
  const file = join(ledgerRoot, 'sessions.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { claims?: Record<string, unknown> };
    existing = parsed.claims ?? {};
  }
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      claims: {
        ...existing,
        ...Object.fromEntries(
          claims.map((claim) => [
            claim.sessionId,
            { ...claim, workspaceHome: dirname(dirname(dirname(claim.stateFile))) },
          ]),
        ),
      },
    }),
  );
}

function claimEasSessions(
  project: string,
  sessions: Array<{ id: string; name: string; platform: 'ios' | 'android' }>,
): void {
  ensureWorkspaceStorage(project);
  writeEasLedger(
    join(fakeHome, 'machine-eas'),
    sessions.map((session) => ({
      sessionId: session.id,
      name: session.name,
      platform: session.platform,
      workspaceRoot: project,
      stateFile: workspaceStateFile(project),
    })),
  );
}

beforeEach(({ signal }) => {
  testSignal = signal;
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  for (const udid of [
    'A1F3-0000',
    'DEFAULT',
    'GONE',
    'HERE',
    'P1',
    'PHONE',
    'TABLET',
    'U-STALE',
    'U1',
    'U2',
    'U3',
    'UDID-1',
    'UDID-2',
    'UDID-9',
    'UDID-DEAD',
    'UDID-ELSEWHERE',
    'UDID-HERE',
    'UDID-LIVE',
    'UDID-REAL-1',
    'UDID-REAL-2',
    'UDID-STALE',
    'UDID-VANISHED',
    'drs_new',
  ])
    recordCreatedDevice('ios', udid);
  for (const name of [
    'stim-abandoned',
    'stim-adopter',
    'stim-alpha',
    'stim-b',
    'stim-bad',
    'stim-beta',
    'stim-claimed',
    'stim-creating',
    'stim-dead',
    'stim-dead-owner',
    'stim-different',
    'stim-ext',
    'stim-extra',
    'stim-first',
    'stim-gone',
    'stim-here',
    'stim-hidden',
    'stim-home-b',
    'stim-kept',
    'stim-live',
    'stim-new',
    'stim-old',
    'stim-one',
    'stim-orphan',
    'stim-orphan-1',
    'stim-orphan-2',
    'stim-race',
    'stim-real-env-1',
    'stim-real-env-2',
    'stim-registering',
    'stim-report-orphan',
    'stim-resolved',
    'stim-second',
    'stim-someones-live-env',
    'stim-source',
    'stim-stale',
    'stim-stale-avd',
    'stim-stale-record',
    'stim-target',
    'stim-three',
    'stim-too-late',
    'stim-two',
    'stim-unclaimed',
    'stim-unreadable',
  ])
    recordCreatedDevice('android', name);

  fakeHome = mkdtempSync(join(tmpdir(), 'stim-fakehome-'));
  originalHomeRoots = Object.fromEntries(HOME_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of HOME_ENV_KEYS) process.env[key] = fakeHome;
  vi.stubEnv('XDG_CACHE_HOME', join(fakeHome, '.cache'));
  originalAvdRoots = Object.fromEntries(
    ['ANDROID_AVD_HOME', 'ANDROID_SDK_HOME', 'ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.ANDROID_AVD_HOME = join(fakeHome, 'avd');
  process.env.ANDROID_SDK_HOME = fakeHome;
  process.env.ANDROID_USER_HOME = join(fakeHome, '.android');
  process.env.ANDROID_EMULATOR_HOME = join(fakeHome, '.android');

  originalTmpRoots = Object.fromEntries(TMP_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TMP_ENV_KEYS) process.env[key] = fakeHome;
});

afterEach(() => {
  ledgerIo.afterRename = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalAvdRoots)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetExecutor();
  for (const [key, value] of Object.entries(originalTmpRoots)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  for (const [key, value] of Object.entries(originalHomeRoots)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('EAS orphan session sweep', () => {
  test('a session claimed from another STIM_HOME is never stopped', async () => {
    const project = join(fakeHome, 'expo-app');
    const clone = join(fakeHome, 'expo-app-clone');
    const homeA = join(fakeHome, 'home-a');
    const homeB = join(fakeHome, 'home-b');
    const ledgerRoot = join(fakeHome, 'machine-eas');
    mkdirSync(project, { recursive: true });
    mkdirSync(clone, { recursive: true });

    process.env.STIM_HOME = homeB;
    writeRemoteState(clone, { remoteDevice: { platform: 'ios', sessionId: 'drs_home_b' } });
    const stateFile = workspaceStateFile(clone);
    writeEasLedger(ledgerRoot, [
      { sessionId: 'drs_home_b', name: 'stim-home-b', platform: 'ios', workspaceRoot: clone, stateFile },
    ]);

    process.env.STIM_HOME = homeA;
    saveConfig({ version: 2, projects: { [project]: { isExpo: true } }, repos: {} });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_home_b', name: 'stim-home-b', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_home_b: JSON.stringify({ id: 'drs_home_b', name: 'stim-home-b', status: 'IN_PROGRESS' }) },
      stop: { drs_home_b: JSON.stringify({ id: 'drs_home_b', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, { ...harness.deps, easLedgerRoot: ledgerRoot });

    expect(output).not.toMatch(/Stopped EAS session drs_home_b/);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('gc lists a fixture-looking ledger entry whose workspace is gone and forgets it', async () => {
    const project = join(fakeHome, 'expo-app');
    const ledgerRoot = easMachineStateRoot();
    const gone = join(fakeHome, 'deleted-fixture');
    mkdirSync(project, { recursive: true });
    ensureWorkspaceStorage(project);
    writeEasLedger(ledgerRoot, [
      {
        sessionId: 'drs_2',
        name: 'stim-fixture',
        platform: 'ios',
        workspaceRoot: gone,
        stateFile: workspaceStateFile(gone),
      },
      {
        sessionId: 'drs_live',
        name: 'stim-live',
        platform: 'ios',
        workspaceRoot: project,
        stateFile: workspaceStateFile(project),
      },
    ]);
    installExecutor();
    const ids = () => {
      const ledger: { claims: object } = JSON.parse(readFileSync(join(ledgerRoot, 'sessions.json'), 'utf-8'));
      return Object.keys(ledger.claims);
    };

    expect(findStaleEasLedgerEntries(listMountedVolumes()).map((entry) => entry.id)).toEqual(['drs_2']);
    await runGc({ dryRun: true, pressure: 'normal' });
    expect(ids()).toEqual(['drs_2', 'drs_live']);

    await runGc({ pressure: 'normal' });
    expect(ids()).toEqual(['drs_live']);
  });

  test('a missing config never authorizes an unclaimed session stop', async () => {
    const project = join(fakeHome, 'expo-app');
    mkdirSync(project, { recursive: true });
    installExecutor();
    const ledgerRoot = join(fakeHome, 'machine-eas');
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_unclaimed', name: 'stim-unclaimed', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_unclaimed: JSON.stringify({ id: 'drs_unclaimed', name: 'stim-unclaimed', status: 'IN_PROGRESS' }),
      },
      stop: { drs_unclaimed: JSON.stringify({ id: 'drs_unclaimed', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, { ...harness.deps, easLedgerRoot: ledgerRoot });

    expect(output).toMatch(/unclaimed|ownership.*not verified/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a fixed ledger claim authorizes cleanup after its workspace state is verified absent', async () => {
    const project = join(fakeHome, 'expo-app');
    const ledgerRoot = join(fakeHome, 'machine-eas');
    mkdirSync(project, { recursive: true });
    ensureWorkspaceStorage(project);
    const stateFile = workspaceStateFile(project);
    writeEasLedger(ledgerRoot, [
      { sessionId: 'drs_claimed', name: 'stim-claimed', platform: 'ios', workspaceRoot: project, stateFile },
    ]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_claimed', name: 'stim-claimed', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_claimed: JSON.stringify({ id: 'drs_claimed', name: 'stim-claimed', status: 'IN_PROGRESS' }) },
      stop: { drs_claimed: JSON.stringify({ id: 'drs_claimed', status: 'STOPPED' }) },
    });

    await easOutput(true, { ...harness.deps, easLedgerRoot: ledgerRoot });

    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list', 'simulator:get', 'simulator:stop']);
  });

  test.each(['missing', 'corrupt', 'mismatched', 'mismatched-state-path'])(
    '%s fixed ledger data never authorizes stop',
    async (kind) => {
      const project = join(fakeHome, 'expo-app');
      const ledgerRoot = join(fakeHome, 'machine-eas');
      mkdirSync(project, { recursive: true });
      ensureWorkspaceStorage(project);
      if (kind === 'corrupt') {
        mkdirSync(ledgerRoot, { recursive: true });
        writeFileSync(join(ledgerRoot, 'sessions.json'), '{broken');
      } else if (kind === 'mismatched') {
        writeEasLedger(ledgerRoot, [
          {
            sessionId: 'drs_target',
            name: 'stim-different',
            platform: 'ios',
            workspaceRoot: project,
            stateFile: workspaceStateFile(project),
          },
        ]);
      } else if (kind === 'mismatched-state-path') {
        const stateFile = join(tmpHome, 'workspaces', 'wrong-workspace', 'state.json');
        mkdirSync(dirname(stateFile), { recursive: true });
        writeEasLedger(ledgerRoot, [
          {
            sessionId: 'drs_target',
            name: 'stim-target',
            platform: 'ios',
            workspaceRoot: project,
            stateFile,
          },
        ]);
      }
      installExecutor();
      const harness = easGcHarness({
        project,
        list: easList([{ id: 'drs_target', name: 'stim-target', status: 'IN_PROGRESS', platform: 'IOS' }]),
        get: { drs_target: JSON.stringify({ id: 'drs_target', name: 'stim-target', status: 'IN_PROGRESS' }) },
        stop: { drs_target: JSON.stringify({ id: 'drs_target', status: 'STOPPED' }) },
      });

      await easOutput(true, { ...harness.deps, easLedgerRoot: ledgerRoot });

      expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
    },
  );

  test('dry run reports a project-scoped orphan and performs no lookup or stop', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const { sweep } = await easGc(false, harness.deps);

    expect(sweep).toMatchObject({ projectScope: project, deletionSafe: true });
    expect(sweep?.orphaned).toEqual([expect.objectContaining({ id: 'drs_orphan', name: 'stim-old' })]);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
    expect(harness.calls[0]?.options).toMatchObject({ cwd: project, timeoutMs: expect.any(Number) });
    expect(harness.calls[0]?.options.omitEnv).toEqual(
      expect.arrayContaining(['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN']),
    );
  });

  test('a session recorded by another registered workspace is not orphaned', async () => {
    const project = join(fakeHome, 'expo-app');
    const otherWorkspace = join(fakeHome, 'expo-worktree');
    mkdirSync(project, { recursive: true });
    mkdirSync(otherWorkspace, { recursive: true });
    saveConfig({
      version: 2,
      projects: { [project]: { isExpo: true }, [otherWorkspace]: { isExpo: true } },
      repos: {},
    });
    claimEasSessions(project, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    writeRemoteState(otherWorkspace, { remoteDevice: { platform: 'ios', sessionId: 'drs_recorded' } });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([
        { id: 'drs_recorded', name: 'stim-live', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' },
      ]),
    });

    const { sweep } = await easGc(false, harness.deps);

    expect(sweep?.orphaned.map((session) => session.id)).toEqual(['drs_orphan']);
    expect(JSON.parse(readFileSync(workspaceStateFile(otherWorkspace), 'utf-8'))).toMatchObject({
      remoteDevice: { sessionId: 'drs_recorded' },
    });
  });

  const gcWithUnavailableRoot = async (prepareRoot: (root: string) => string) => {
    const project = join(fakeHome, 'expo-app');
    const unavailable = prepareRoot(join(fakeHome, 'unavailable-workspace'));
    mkdirSync(project, { recursive: true });
    saveConfig({
      version: 2,
      projects: { [project]: { isExpo: true }, [unavailable]: { isExpo: true } },
      repos: {},
    });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, harness.deps).finally(() => {
      if (existsSync(unavailable)) chmodSync(unavailable, 0o700);
    });

    return { output, calls: harness.calls };
  };

  test('a registered workspace root that is missing fails closed', async () => {
    const { output, calls } = await gcWithUnavailableRoot((root) => root);
    expect(output).toMatch(/unavailable-workspace.*not available|unavailable-workspace.*not readable/i);
    expect(calls).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'a registered workspace root that is inaccessible fails closed (skipped on Windows: mode 000 does not take read access away from a directory)',
    async () => {
      const { output, calls } = await gcWithUnavailableRoot((root) => {
        mkdirSync(root);
        chmodSync(root, 0o000);
        return root;
      });
      expect(output).toMatch(/unavailable-workspace.*not available|unavailable-workspace.*not readable/i);
      expect(calls).toEqual([]);
    },
  );

  test('an existing registered workspace with no state file does not block deletion', async () => {
    const project = join(fakeHome, 'expo-app');
    const emptyWorkspace = join(fakeHome, 'empty-workspace');
    mkdirSync(project, { recursive: true });
    mkdirSync(emptyWorkspace, { recursive: true });
    saveConfig({
      version: 2,
      projects: { [project]: { isExpo: true }, [emptyWorkspace]: { isExpo: true } },
      repos: {},
    });
    ensureWorkspaceStorage(emptyWorkspace);
    claimEasSessions(emptyWorkspace, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    await easOutput(true, harness.deps);

    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list', 'simulator:get', 'simulator:stop']);
  });

  test('an active remote session creation lock disables deletion while local cleanup continues', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_creating', name: 'stim-creating', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_creating: JSON.stringify({ id: 'drs_creating', name: 'stim-creating', status: 'IN_PROGRESS' }),
      },
      stop: { drs_creating: JSON.stringify({ id: 'drs_creating', status: 'STOPPED' }) },
    });

    const output = await withRemoteSessionLock(project, () => easOutput(true, harness.deps));

    expect(output).toMatch(/remote-session|remote session.*lock/i);
    expect(harness.calls).toEqual([]);
  });

  test('an active EAS start lock disables only the remote sweep while local cleanup continues', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    writeFileSync(
      join(project, 'app.json'),
      JSON.stringify({ expo: { extra: { eas: { projectId: 'active-eas-project' } } } }),
    );
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_hidden', name: 'stim-hidden', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const output = await withEasProjectLock(project, () => easOutput(true, harness.deps), {
      machineRoot: join(fakeHome, 'machine-eas'),
    });

    expect(output).toMatch(/EAS project lock/i);
    expect(harness.calls).toEqual([]);
  });

  test('a false then true Expo classification cannot enable an unlocked EAS sweep', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_race', name: 'stim-race', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_race: JSON.stringify({ id: 'drs_race', name: 'stim-race', status: 'IN_PROGRESS' }),
      },
      stop: { drs_race: JSON.stringify({ id: 'drs_race', status: 'STOPPED' }) },
    });
    let classifications = 0;

    await easGc(true, { ...harness.deps, detectIsExpo: () => classifications++ > 0 });

    expect(classifications).toBe(1);
    expect(harness.calls).toEqual([]);
  });

  test('dry run does not wait behind an active remote session creation lock', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_creating', name: 'stim-creating', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });
    const startedAt = Date.now();

    const output = await withRemoteSessionLock(project, () => easOutput(false, harness.deps));

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(output).toMatch(/remote-session|remote session.*lock/i);
    expect(harness.calls).toEqual([]);
  });

  test('a malformed remote session lock disables the EAS sweep', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const lockDir = join(workspaceDir(realpathSync(project)), 'remote-session.lock');
    mkdirSync(join(lockDir, 'exclusive'), { recursive: true });
    writeFileSync(join(lockDir, 'exclusive', 'broken.claim'), '{not valid json');
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_hidden', name: 'stim-hidden', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const output = await easOutput(true, harness.deps);

    expect(output).toMatch(/remote-session|remote session.*lock/i);
    expect(harness.calls).toEqual([]);
    expect(existsSync(lockDir)).toBe(true);
  });

  test('registry expansion releases and retries the sorted remote session lock set', async () => {
    const project = join(fakeHome, 'z-expo-app');
    const added = join(fakeHome, 'a-expo-workspace');
    registerExpoProject(project);
    mkdirSync(added, { recursive: true });
    installExecutor();
    const harness = easGcHarness({ project, list: easList() });
    const acquisitions: string[] = [];
    let depth = 0;
    let expanded = false;
    const deps = {
      ...harness.deps,
      withRemoteSessionLock: async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
        acquisitions.push(root);
        depth++;
        try {
          if (!expanded) {
            expanded = true;
            saveConfig({
              version: 2,
              projects: { [project]: { isExpo: true }, [added]: { isExpo: true } },
              repos: {},
            });
          }
          return await fn();
        } finally {
          depth--;
        }
      },
    } as unknown as RecordDependencies;

    await easOutput(false, deps);

    expect(acquisitions).toEqual([realpathSync(project), realpathSync(added), realpathSync(project)]);
    expect(depth).toBe(0);
  });

  test('an error from the GC core is not retried as a lock acquisition failure', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({ project, list: easList() });
    const failure = new Error('report output failed');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      throw failure;
    });

    await expect(runGc({ dryRun: true, pressure: 'normal' }, harness.deps)).rejects.toBe(failure);

    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  test('an unexpected EAS collection failure becomes a notice while local cleanup continues', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({ project, list: easList() });
    const deps = {
      ...harness.deps,
      withRemoteSessionLock: async <T>(_root: string, fn: () => Promise<T>): Promise<T> => {
        await fn();
        throw new Error('remote session lock release failed');
      },
    } as unknown as RecordDependencies;

    const output = await easOutput(true, deps);

    expect(output).toMatch(/EAS collection failed.*remote session lock release failed/i);
    expect(harness.calls.filter((call) => call.args[0] === 'simulator:stop')).toEqual([]);
  });

  test('a workspace registered during the EAS list cannot hide a pending state write', async () => {
    const project = join(fakeHome, 'expo-app');
    const added = join(fakeHome, 'new-expo-workspace');
    registerExpoProject(project);
    mkdirSync(added, { recursive: true });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: () => {
        saveConfig({
          version: 2,
          projects: { [project]: { isExpo: true }, [added]: { isExpo: true } },
          repos: {},
        });
        return easList([{ id: 'drs_registering', name: 'stim-registering', status: 'IN_PROGRESS', platform: 'IOS' }]);
      },
      get: {
        drs_registering: JSON.stringify({
          id: 'drs_registering',
          name: 'stim-registering',
          status: 'IN_PROGRESS',
        }),
      },
      stop: { drs_registering: JSON.stringify({ id: 'drs_registering', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, harness.deps);

    expect(output).toMatch(/registered workspace roots.*changed|new.*remote-session lock/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('the final state rescan rejects a workspace registered after classification', async () => {
    const project = join(fakeHome, 'expo-app');
    const added = join(fakeHome, 'late-expo-workspace');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_registering', name: 'stim-registering', platform: 'ios' }]);
    mkdirSync(added, { recursive: true });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_registering', name: 'stim-registering', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_registering: JSON.stringify({
          id: 'drs_registering',
          name: 'stim-registering',
          status: 'IN_PROGRESS',
        }),
      },
      stop: { drs_registering: JSON.stringify({ id: 'drs_registering', status: 'STOPPED' }) },
    });

    const sweep = await collectEasSessionSweep(
      { version: 2, projects: { [project]: { isExpo: true } }, repos: {} },
      harness.deps,
    );
    expect(sweep.orphaned.map((session) => session.id)).toEqual(['drs_registering']);
    saveConfig({ version: 2, projects: { [project]: { isExpo: true }, [added]: { isExpo: true } }, repos: {} });
    writeRemoteState(added, { remoteDevice: { platform: 'ios', sessionId: 'drs_registering' } });
    const output = await captureLog(() => deleteEasSessions(sweep, harness.deps));

    expect(output).toMatch(/workspace record.*left running/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test.each([false, true])(
    'the EAS sweep lock covers separate clones through the final stop (cancelled %s)',
    async (cancelled) => {
      const project = join(fakeHome, 'expo-app');
      const otherWorkspace = join(fakeHome, 'expo-app-clone');
      const projectGitCommon = join(fakeHome, 'project.git');
      const otherGitCommon = join(fakeHome, 'other.git');
      registerExpoProject(project);
      mkdirSync(otherWorkspace, { recursive: true });
      mkdirSync(projectGitCommon, { recursive: true });
      mkdirSync(otherGitCommon, { recursive: true });
      const appConfig = JSON.stringify({ expo: { extra: { eas: { projectId: 'shared-eas-project' } } } });
      writeFileSync(join(project, 'app.json'), appConfig);
      writeFileSync(
        join(otherWorkspace, 'app.config.js'),
        "module.exports = { extra: { eas: { projectId: 'shared-eas-project' } } };\n",
      );
      claimEasSessions(project, [{ id: 'drs_old', name: 'stim-old', platform: 'ios' }]);
      setExecutor({
        run(cmd) {
          throw new Error(`unexpected run: ${cmd}`);
        },
        runQuiet() {
          return null;
        },
        runFileQuiet(_file: string, args: string[]) {
          if (!args.includes('--git-common-dir')) return null;
          return args.some((arg) => arg.includes(otherWorkspace)) ? otherGitCommon : projectGitCommon;
        },
        spawn(cmd) {
          throw new Error(`unexpected spawn: ${cmd}`);
        },
      });
      const cancellation = new AbortController();
      const order: string[] = [];
      let startPromise: Promise<unknown> | null = null;
      const harness = easGcHarness({
        project,
        list: easList([{ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
        get: {
          drs_old: () => {
            order.push('get');
            startPromise = ensureRemoteBootOwned({
              root: otherWorkspace,
              platform: 'ios',
              operation: harness.deps.operation,
              sessionName: 'stim-new',
              startedAt: '2026-08-28T00:00:00.000Z',
              register: () => {
                order.push('register');
                const config = loadConfig();
                saveConfig({
                  version: 2,
                  projects: { ...config?.projects, [otherWorkspace]: { isExpo: true } },
                  repos: config?.repos ?? {},
                });
              },
              boot: async () => {
                order.push('create');
                return { ok: true, udid: 'drs_new' };
              },
              createdSessionId: () => 'drs_new',
              abandonCreatedSession: () => ({ ok: true, sessionId: 'drs_new' }),
              writeState: () => {
                order.push('publish');
              },
              ledgerRoot: join(fakeHome, 'machine-eas'),
            });
            return JSON.stringify({ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS' });
          },
        },
        stop: {
          drs_old: () => {
            order.push('stop');
            if (cancelled) cancellation.abort();
            return JSON.stringify({ id: 'drs_old', status: 'STOPPED' });
          },
        },
      });

      harness.deps.operation.signal = AbortSignal.any([testSignal, cancellation.signal]);
      const exitCode = process.exitCode;
      try {
        await easGc(true, harness.deps).catch((error: unknown) => {
          if (!cancelled) throw error;
        });
        await startPromise;
      } finally {
        process.exitCode = exitCode;
      }

      expect(order).toEqual(cancelled ? ['get', 'stop'] : ['get', 'stop', 'register', 'create', 'publish']);
    },
  );

  test('collects every page before comparing current-project sessions', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [
      { id: 'drs_page_1', name: 'stim-one', platform: 'ios' },
      { id: 'drs_page_2', name: 'stim-two', platform: 'android' },
    ]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: {
        first: easList([{ id: 'drs_page_1', name: 'stim-one', status: 'IN_PROGRESS', platform: 'IOS' }], {
          hasNextPage: true,
          endCursor: 'cursor-2',
        }),
        'cursor-2': easList([{ id: 'drs_page_2', name: 'stim-two', status: 'NEW', platform: 'ANDROID' }], {
          hasNextPage: false,
          endCursor: 'cursor-2-end',
        }),
      },
    });

    const { sweep } = await easGc(false, harness.deps);

    expect(sweep?.orphaned.map((session) => session.id)).toEqual(['drs_page_1', 'drs_page_2']);
    const pages = harness.calls.filter((call) => call.args[0] === 'simulator:list');
    expect(pages).toHaveLength(2);
    expect(pages[0]?.args).toEqual(expect.arrayContaining(['--limit', '100']));
    expect(pages[0]?.args).not.toContain('--after');
    expect(pages[1]?.args).toEqual(expect.arrayContaining(['--limit', '100', '--after', 'cursor-2']));
    for (const page of pages) {
      expect(page.options).toMatchObject({ cwd: project, timeoutMs: 30_000 });
      expect(page.options.omitEnv).toEqual(
        expect.arrayContaining(['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN']),
      );
    }
  });

  test('a unique-cursor sequence stops at the configured page limit', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: (_after, page) => {
        if (page > 10) throw new Error('test safety bound reached');
        return easList([], { hasNextPage: true, endCursor: `cursor-${page + 1}` });
      },
    });
    const deps = { ...harness.deps, easMaxPages: 3 } as unknown as RecordDependencies;

    const output = await easOutput(true, deps);

    expect(output).toMatch(/page limit|maximum.*pages/i);
    expect(harness.calls.filter((call) => call.args[0] === 'simulator:list')).toHaveLength(3);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:get')).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
  });

  test('a slow page sequence stops at the total deadline and shortens the final page timeout', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    let clock = 0;
    const harness = easGcHarness({
      project,
      list: (_after, page) => {
        clock += 40_000;
        return easList(
          page === 2 ? [{ id: 'drs_too_late', name: 'stim-too-late', status: 'IN_PROGRESS', platform: 'IOS' }] : [],
          { hasNextPage: page < 2, endCursor: `cursor-${page + 1}` },
        );
      },
      get: {
        drs_too_late: JSON.stringify({ id: 'drs_too_late', name: 'stim-too-late', status: 'IN_PROGRESS' }),
      },
      stop: { drs_too_late: JSON.stringify({ id: 'drs_too_late', status: 'STOPPED' }) },
    });
    const deps = {
      ...harness.deps,
      easNow: () => clock,
      easCollectionTimeoutMs: 60_000,
    } as unknown as RecordDependencies;

    const output = await easOutput(true, deps);

    expect(output).toMatch(/deadline|time limit/i);
    const listCalls = harness.calls.filter((call) => call.args[0] === 'simulator:list');
    expect(listCalls.map((call) => call.options.timeoutMs)).toEqual([30_000, 20_000]);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:get')).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
  });

  test.each([
    [
      'malformed page info',
      { first: JSON.stringify({ sessions: [], pageInfo: { hasNextPage: 'yes', endCursor: null } }) },
    ],
    ['missing next cursor', { first: easList([], { hasNextPage: true, endCursor: null }) }],
    [
      'repeated cursor',
      {
        first: easList([], { hasNextPage: true, endCursor: 'same' }),
        same: easList([], { hasNextPage: true, endCursor: 'same' }),
      },
    ],
    [
      'later page failure',
      {
        first: easList([], { hasNextPage: true, endCursor: 'next' }),
        next: new Error('page request failed'),
      },
    ],
  ])('a %s fails closed while local deletion continues', async (_label, list) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({ project, list });

    const output = await easOutput(true, harness.deps);

    expect(output).toMatch(/page|cursor/i);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:get')).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
  });

  test.each([
    ['missing', undefined],
    ['null', null],
    ['unknown', 'WINDOWS'],
  ])('an owned session with %s platform is never reported or stopped', async (_label, platform) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_bad', name: 'stim-bad', status: 'IN_PROGRESS', platform }]),
      get: { drs_bad: JSON.stringify({ id: 'drs_bad', name: 'stim-bad', status: 'IN_PROGRESS' }) },
    });

    const output = await easOutput(true, harness.deps);

    expect(output).toMatch(/platform/i);
    expect(output).not.toMatch(/Orphaned EAS sessions/);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('delete stops an orphan only after a matching active owned lookup', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, harness.deps);

    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list', 'simulator:get', 'simulator:stop']);
    expect(output).toMatch(/Stopped EAS session drs_orphan/);
  });

  test.each([
    {
      label: 'terminal',
      get: JSON.stringify({ id: 'drs_old', name: 'stim-old', status: 'STOPPED' }),
      expected: /already stopped/i,
    },
    {
      label: 'missing',
      get: Object.assign(new Error('lookup failed'), { stderr: 'Device run session drs_old was not found.' }),
      expected: /already gone/i,
    },
  ])('treats a $label candidate as resolved without a stop', async ({ get, expected }) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_old', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_old: get },
    });

    const output = await easOutput(true, harness.deps);

    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(output).toMatch(expected);
  });

  test.each([
    ['network failure', new Error('getaddrinfo ENOTFOUND api.expo.dev')],
    ['authentication failure', new Error('Authentication failed. Log in to EAS.')],
    ['malformed output', 'not json'],
  ])('reports a %s as a notice and refuses deletion', async (_label, list) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({ project, list });

    const { sweep } = await easGc(true, harness.deps);
    expect(sweep).toMatchObject({ deletionSafe: false, orphaned: [] });
    expect(sweep?.notices).toHaveLength(1);
  });

  test('a malformed workspace state fails closed for remote deletion', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    writeRemoteState(project, '{not json');
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, harness.deps);

    expect(output).toMatch(/state\.json.*could not be read|state\.json.*valid JSON/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a listed state entry that cannot be read fails closed for remote deletion', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_unreadable', name: 'stim-old', platform: 'ios' }]);
    symlinkSync(join(fakeHome, 'missing-state-target'), workspaceStateFile(project));
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_unreadable', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_unreadable: JSON.stringify({ id: 'drs_unreadable', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_unreadable: JSON.stringify({ id: 'drs_unreadable', status: 'STOPPED' }) },
    });

    const output = await easOutput(true, harness.deps);

    expect(output).toMatch(/state\.json.*could not be read/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a candidate changed to an unowned name is never stopped', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_reused', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_reused', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_reused: JSON.stringify({ id: 'drs_reused', name: 'manual-session', status: 'IN_PROGRESS' }) },
    });

    const run = await easGc(true, harness.deps);

    expect(run.output).toMatch(/not owned by Stim/i);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(run.failures).toBeGreaterThan(0);
  });

  test('candidate failures are independent and do not block local cleanup', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [
      { id: 'drs_lookup_fail', name: 'stim-one', platform: 'ios' },
      { id: 'drs_stop_fail', name: 'stim-two', platform: 'android' },
      { id: 'drs_ok', name: 'stim-three', platform: 'ios' },
    ]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([
        { id: 'drs_lookup_fail', name: 'stim-one', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'drs_stop_fail', name: 'stim-two', status: 'IN_PROGRESS', platform: 'ANDROID' },
        { id: 'drs_ok', name: 'stim-three', status: 'IN_PROGRESS', platform: 'IOS' },
      ]),
      get: {
        drs_lookup_fail: new Error('lookup timed out'),
        drs_stop_fail: JSON.stringify({ id: 'drs_stop_fail', name: 'stim-two', status: 'IN_PROGRESS' }),
        drs_ok: JSON.stringify({ id: 'drs_ok', name: 'stim-three', status: 'IN_PROGRESS' }),
      },
      stop: {
        drs_stop_fail: new Error('stop failed'),
        drs_ok: JSON.stringify({ id: 'drs_ok', status: 'STOPPED' }),
      },
    });

    const run = await easGc(true, harness.deps);

    expect(harness.calls.filter((call) => call.args[0] === 'simulator:get')).toHaveLength(3);
    expect(harness.calls.filter((call) => call.args[0] === 'simulator:stop')).toHaveLength(2);
    expect(run.output).toContain('Stopped EAS session drs_ok');
    expect(run.failures).toBeGreaterThan(0);
  });

  test('a throwing claim removal reports resolved sessions and continues other candidates and local cleanup', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [
      { id: 'drs_first', name: 'stim-first', platform: 'ios' },
      { id: 'drs_second', name: 'stim-second', platform: 'android' },
    ]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([
        { id: 'drs_first', name: 'stim-first', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'drs_second', name: 'stim-second', status: 'IN_PROGRESS', platform: 'ANDROID' },
      ]),
      get: {
        drs_first: JSON.stringify({ id: 'drs_first', name: 'stim-first', status: 'IN_PROGRESS' }),
        drs_second: JSON.stringify({ id: 'drs_second', name: 'stim-second', status: 'IN_PROGRESS' }),
      },
      stop: {
        drs_first: JSON.stringify({ id: 'drs_first', status: 'STOPPED' }),
        drs_second: JSON.stringify({ id: 'drs_second', status: 'STOPPED' }),
      },
    });

    const output = await easOutput(true, {
      ...harness.deps,
      removeEasSessionClaim: () => {
        throw new Error('claim store unavailable');
      },
    } as unknown as RecordDependencies);

    expect(output).toMatch(/Stopped EAS session drs_first/);
    expect(output).toMatch(/Stopped EAS session drs_second/);
    expect(output).toMatch(/ownership claim.*could not be removed/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual([
      'simulator:list',
      'simulator:get',
      'simulator:stop',
      'simulator:get',
      'simulator:stop',
    ]);
  });

  test('a false claim removal reports the stopped session and retained claim', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_resolved', name: 'stim-resolved', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_resolved', name: 'stim-resolved', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_resolved: JSON.stringify({ id: 'drs_resolved', name: 'stim-resolved', status: 'IN_PROGRESS' }),
      },
      stop: { drs_resolved: JSON.stringify({ id: 'drs_resolved', status: 'STOPPED' }) },
    });

    const run = await easGc(true, {
      ...harness.deps,
      removeEasSessionClaim: () => false,
    } as unknown as RecordDependencies);

    expect(run.output).toMatch(/Stopped EAS session drs_resolved/);
    expect(run.output).toMatch(/ownership claim.*could not be removed/i);
    expect(run.failures).toBeGreaterThan(0);
  });
});

test('a dry run leaves every registered entry in place', async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({
    version: 2,
    projects: { [localDeadPath]: { metroPort: 8101 } },
    repos: {},
  });
  installExecutor();

  const before = loadConfig();
  await cli(['--dry-run', '--pressure', 'normal']);

  expect(currentConfig().projects[localDeadPath]).toBeTruthy();
  expect(loadConfig()).toEqual(before);
});

test('a dead project on an unmounted volume is not unregistered', async () => {
  const unmountedPath = '/Volumes/StimTestVolumeThatDoesNotExist/proj/gone';
  const localDeadPath = join(fakeHome, 'no-longer-here');

  saveConfig({
    version: 2,
    projects: {
      [unmountedPath]: { metroPort: 8100 },
      [localDeadPath]: { metroPort: 8101 },
    },
    repos: {},
  });
  installExecutor();

  await cli(['--pressure', 'normal']);

  const cfg = currentConfig();
  expect(cfg.projects[unmountedPath]).toBeTruthy();
  expect(cfg.projects[unmountedPath]?.metroPort).toBe(8100);
  expect(cfg.projects[localDeadPath]).toBe(undefined);
});

test('gc exits 1 when a dead project keeps its entry because a collector could not be stopped', async () => {
  const deadPath = join(fakeHome, 'no-longer-here');
  saveConfig({ version: 2, projects: { [deadPath]: { metroPort: 8101 } }, repos: {} });
  installExecutor();
  const collector = {
    platform: 'ios' as const,
    name: 'ios log collector (pid 4242)',
    reason: 'Collector exit could not be confirmed; keeping its ownership record.',
  };
  vi.spyOn(reclaim, 'reclaimProject').mockResolvedValue({
    path: deadPath,
    dereferenced: [],
    killedPid: null,
    skippedMetro: null,
    metroPort: 8101,
    deletedDevices: [],
    parkedDevices: [],
    evictedDevices: [],
    poolNotes: [],
    skippedDevices: [collector],
    failedDevices: [collector],
    keptEntry: true,
    stoppedSession: null,
    stoppedTunnel: null,
    releasedLeases: [],
    removedWorkspaceDirs: [],
    failedWorkspaceDirs: [],
  });
  try {
    const payload = await gcJson({ pressure: 'normal' });
    expect(payload.actions).toContainEqual(
      expect.objectContaining({ kind: 'prune-project', target: deadPath, outcome: 'failed' }),
    );
    expect(payload.failures).toBe(1);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = undefined;
  }
});

describe('a registry key that is not an absolute path', () => {
  const relativeKey = '.claude/stim-worktrees/nestrel';

  test('gc removes it when it claims no device', async () => {
    saveConfig({
      version: 2,
      projects: { [relativeKey]: { metroPort: 8100, platforms: {} } },
      repos: {},
    });
    installExecutor();

    await cli(['--pressure', 'normal']);

    expect(currentConfig().projects[relativeKey]).toBe(undefined);
  });

  test('gc keeps it while it claims a device', async () => {
    saveConfig({
      version: 2,
      projects: {
        [relativeKey]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-1', owned: true } } },
      },
      repos: {},
    });
    installExecutor();

    await cli(['--pressure', 'normal']);

    expect(currentConfig().projects[relativeKey]?.platforms?.ios?.deviceUdid).toBe('UDID-1');
  });
});

interface DeviceSpec {
  udid: string;
  name: string;
  state?: string;
}

function iosListJson(devices: DeviceSpec[]) {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': devices.map((d) => ({
        udid: d.udid,
        name: d.name,
        state: d.state || 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
      })),
    },
  });
}

interface InstallDeviceExecutorOptions {
  devices: DeviceSpec[];
  execCalls: string[];
  throwOnShutdownFor?: Set<string>;
}

function installDeviceExecutor({
  devices,
  execCalls,
  throwOnShutdownFor = new Set<string>(),
}: InstallDeviceExecutorOptions) {
  setExecutor({
    run(cmd) {
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return iosListJson(devices);
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet(cmd) {
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return iosListJson(devices);
      return '';
    },
    runFile(file, args: string[] = []) {
      const cmd = [file, ...args].join(' ');
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return iosListJson(devices);
      if (cmd.startsWith('xcrun simctl delete ')) return '';
      throw new Error(`unexpected runFile: ${cmd}`);
    },
    runFileQuiet(file: string, args: string[] = []) {
      execCalls.push([file, ...args].join(' '));
      if (args[1] === 'shutdown' && throwOnShutdownFor.has(args[2] ?? '')) {
        throw new Error(`simulated shutdown failure for ${args[2]}`);
      }
      return '';
    },
    spawn(cmd, args: readonly string[] = []) {
      execCalls.push([cmd, ...args].join(' '));
      throw new Error(`unexpected spawn: ${cmd}`);
    },
  });
}

function usedDaysAgo(dir: string, days: number) {
  mkdirSync(dir, { recursive: true });
  recordWorkspaceUse(dir, new Date(Date.now() - days * DAY_MS));
}

test('gc re-verifies ownership before shutdown, shuts down before delete, and contains a per-device teardown throw', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-1', name: 'stim-orphan-1' },
      { udid: 'UDID-2', name: 'stim-orphan-2' },
    ],
    execCalls,
    throwOnShutdownFor: new Set(['UDID-1']),
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  await sweepingGc({ pressure: 'normal' });

  const firstListIndex = execCalls.findIndex((c) => c.includes('simctl list devices --json'));
  const shutdown1Index = execCalls.findIndex((c) => c.startsWith('xcrun simctl shutdown UDID-1'));
  const shutdown2Index = execCalls.findIndex((c) => c.startsWith('xcrun simctl shutdown UDID-2'));
  const delete2Index = execCalls.findIndex((c) => c.startsWith('xcrun simctl delete UDID-2'));

  expect(firstListIndex !== -1).toBeTruthy();
  expect(firstListIndex < shutdown1Index).toBeTruthy();
  expect(shutdown2Index !== -1 && delete2Index !== -1).toBeTruthy();
  expect(shutdown2Index < delete2Index).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-1'))).toBe(false);
});

test("Stim Desktop's run (gc --json) deletes this home's orphan and never another home's", async () => {
  const otherHome = mkdtempSync(join(tmpdir(), 'stim-other-home-'));
  process.env.STIM_HOME = otherHome;
  recordCreatedDevice('ios', 'FOREIGN-UDID');
  process.env.STIM_HOME = tmpHome;
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-2', name: 'stim-orphan-2' },
      { udid: 'FOREIGN-UDID', name: 'stim-1362-mobile (iPhone 18 Pro 27.0)', state: 'Booted' },
    ],
    execCalls,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  try {
    const { stdout } = await captureJson(() => sweepingGc({ pressure: 'normal', json: true }));
    const payload = JSON.parse(stdout[0] ?? '');
    expect(payload.results.filter((result: { kind: string }) => result.kind === 'device')).toEqual([
      expect.objectContaining({ kind: 'device', status: 'done', detail: expect.stringContaining('stim-orphan-2') }),
    ]);
  } finally {
    rmSync(otherHome, { recursive: true, force: true });
  }
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-2'))).toBe(true);
  expect(execCalls.some((c) => c.includes('FOREIGN-UDID') && !c.includes('list'))).toBe(false);
});

test('gc --json lists every device with its owner and every runtime and system image with its use, under a scoped STIM_HOME', async () => {
  installExecutor();
  const otherHome = mkdtempSync(join(tmpdir(), 'stim-other-home-'));
  process.env.STIM_HOME = otherHome;
  recordCreatedDevice('ios', 'FOREIGN');
  process.env.STIM_HOME = tmpHome;
  recordCreatedDevice('ios', 'MINE');
  recordCreatedDevice('ios', 'LEFT');
  recordCreatedDevice('android', 'stim-app-tablet');
  const project = join(fakeHome, 'app');
  mkdirSync(project);
  saveConfig({
    version: 2,
    projects: {
      [project]: {
        metroPort: 8100,
        platforms: { ios: { deviceUdid: 'MINE', owned: true } },
        deviceSlots: {
          tablet: { android: { avdName: 'stim-app-tablet', owned: true } },
        },
      },
    },
    parked: {
      ios: [
        {
          udid: 'PARKED',
          name: 'stim-parked (iPhone 15 17.4) p1',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
          parkedAt: '2026-09-03T00:00:00.000Z',
          simslimManaged: false,
        },
      ],
      android: [],
    },
    repos: {},
  });
  const avdHome = process.env.ANDROID_AVD_HOME as string;
  const writeAvd = (name: string, sysdir: string, booted: boolean) => {
    const directory = join(avdHome, `${name}.avd`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${directory}\n`);
    writeFileSync(join(directory, 'config.ini'), `image.sysdir.1=${sysdir}\nhw.device.name=pixel_9\n`);
    if (booted) writeFileSync(join(directory, 'hardware-qemu.ini'), '');
    return directory;
  };
  const tabletDirectory = writeAvd('stim-app-tablet', 'system-images/android-36/google_apis/arm64-v8a/', true);
  writeAvd('Pixel_9', 'system-images/android-36/google_apis/arm64-v8a/', false);
  const sdk = join(fakeHome, 'sdk');
  for (const image of ['android-36/google_apis/arm64-v8a', 'android-30/google_apis/arm64-v8a']) {
    mkdirSync(join(sdk, 'system-images', image), { recursive: true });
  }
  const savedSdk = {
    ANDROID_HOME: process.env.ANDROID_HOME,
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
  };
  process.env.ANDROID_HOME = sdk;
  delete process.env.ANDROID_SDK_ROOT;
  const devices = [
    { udid: 'MINE', name: 'stim-app (iPhone 15 17.4)' },
    { udid: 'LEFT', name: 'stim-gone (iPhone 15 17.4)' },
    { udid: 'PARKED', name: 'stim-parked (iPhone 15 17.4) p1' },
    { udid: 'FOREIGN', name: 'stim-1362-mobile (iPhone 15 17.4)' },
    { udid: 'USER', name: 'iPhone 15' },
  ];
  const runtimes = {
    A: {
      identifier: 'A',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
      platformIdentifier: 'com.apple.platform.iphonesimulator',
      version: '17.4',
      build: '21E213',
      sizeBytes: 7000,
      deletable: true,
    },
    B: {
      identifier: 'B',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4',
      platformIdentifier: 'com.apple.platform.iphonesimulator',
      version: '16.4',
      build: '20E247',
      sizeBytes: 5000,
      deletable: true,
    },
    C: {
      identifier: 'C',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-15-0',
      platformIdentifier: 'com.apple.platform.iphonesimulator',
      deletable: false,
    },
    W: {
      identifier: 'W',
      platformIdentifier: 'com.apple.platform.watchsimulator',
      deletable: true,
    },
  };
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const execCalls: string[] = [];
  const inventoryExecutor: Executor = {
    ...getExecutor(),
    runFile(file, args: string[] = [], options) {
      if (args[0] === '-list-avds') return this.run([file, ...args].join(' '), options);
      const cmd = [file, ...args].join(' ');
      execCalls.push(cmd);
      if (cmd === 'xcrun simctl list devices --json') return iosListJson(devices);
      if (cmd === 'xcrun simctl runtime list -j') return JSON.stringify(runtimes);
      if (cmd === 'xcrun simctl list runtimes -j') {
        return JSON.stringify({
          runtimes: [
            { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4', version: '17.4', buildversion: '21E213' },
            { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6', version: '18.6', buildversion: '22G86' },
            { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-10-4', version: '10.4' },
          ],
        });
      }
      throw new Error(`unexpected runFile: ${cmd}`);
    },
  };
  setExecutor({
    ...inventoryExecutor,
    runFileAsync: async (file, args, options) => inventoryExecutor.runFile(file, args, options),
  });

  try {
    const { stdout } = await captureJson(() => runGc({ dryRun: true, pressure: 'normal', json: true }));
    const { inventory } = JSON.parse(stdout[0] ?? '');
    expect(
      inventory.devices.map((d: { id: string; owner: string; project: string | null; slot: string | null }) => [
        d.id,
        d.owner,
        d.project,
        d.slot,
      ]),
    ).toEqual([
      ['MINE', 'workspace', project, 'default'],
      ['LEFT', 'orphaned', null, null],
      ['PARKED', 'parked', null, null],
      ['FOREIGN', 'otherStimHome', null, null],
      ['USER', 'user', null, null],
      ['Pixel_9', 'user', null, null],
      ['stim-app-tablet', 'workspace', project, 'tablet'],
    ]);
    expect(inventory.devices.find((d: { id: string }) => d.id === 'stim-app-tablet')).toMatchObject({
      runtime: 'system-images;android-36;google_apis;arm64-v8a',
      directory: tabletDirectory,
      lastUsedAt: expect.any(String),
    });
    expect(inventory.devices.find((d: { id: string }) => d.id === 'Pixel_9').lastUsedAt).toBe(null);
    expect(inventory.runtimes).toEqual([
      expect.objectContaining({
        identifier: 'A',
        deviceCount: 5,
        command: 'xcrun simctl runtime delete A',
      }),
      expect.objectContaining({
        identifier: 'B',
        bytes: 5000,
        deviceCount: 0,
        command: 'xcrun simctl runtime delete B',
      }),
      expect.objectContaining({
        identifier: 'C',
        deviceCount: 0,
        command: null,
      }),
      expect.objectContaining({
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
        version: '18.6',
        bytes: null,
        command: null,
      }),
    ]);
    expect(inventory.systemImages.map((i: { package: string; avdCount: number }) => [i.package, i.avdCount])).toEqual([
      ['system-images;android-30;google_apis;arm64-v8a', 0],
      ['system-images;android-36;google_apis;arm64-v8a', 2],
    ]);
    expect(inventory.notices).toEqual([]);
    expect(
      execCalls.filter(
        (c) =>
          !c.includes(' list ') &&
          !/ -?-version$/.test(c) &&
          !['/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', 'vm_stat', 'adb devices'].includes(c),
      ),
    ).toEqual([]);
  } finally {
    rmSync(otherHome, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedSdk)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'gc --json inventory reports AVD and system image folders it cannot read instead of dropping them',
  async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    const lockedAvdRoot = process.env.ANDROID_AVD_HOME as string;
    mkdirSync(lockedAvdRoot, { recursive: true });
    const userAvdRoot = join(process.env.ANDROID_USER_HOME as string, 'avd');
    for (const name of ['Pixel_9', 'Locked', 'Sealed']) {
      const directory = join(userAvdRoot, `${name}.avd`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(userAvdRoot, `${name}.ini`), `path=${directory}\npath.rel=avd/${name}.avd\n`);
      writeFileSync(join(directory, 'config.ini'), 'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n');
    }
    const sdk = join(fakeHome, 'sdk');
    const images = join(sdk, 'system-images');
    mkdirSync(join(images, 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
    const savedSdk = { ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT };
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const inventoryExecutor: Executor = {
      ...getExecutor(),
      runFile(file, args: string[] = []) {
        const cmd = [file, ...args].join(' ');
        if (cmd === 'xcrun simctl list devices --json') return iosListJson([]);
        if (cmd === 'xcrun simctl runtime list -j') return '{}';
        if (cmd === 'xcrun simctl list runtimes -j') return '{"runtimes":[]}';
        throw new Error(`unexpected runFile: ${cmd}`);
      },
    };
    setExecutor({
      ...inventoryExecutor,
      runFileAsync: async (file, args, options) => inventoryExecutor.runFile(file, args, options),
    });
    chmodSync(lockedAvdRoot, 0o000);
    chmodSync(join(userAvdRoot, 'Locked.ini'), 0o000);
    chmodSync(join(userAvdRoot, 'Sealed.avd'), 0o000);
    chmodSync(images, 0o000);

    try {
      const { stdout } = await captureJson(() => runGc({ dryRun: true, pressure: 'normal', json: true }));
      const { inventory } = JSON.parse(stdout[0] ?? '');
      expect(inventory.devices.map((d: { id: string; runtime: string | null }) => [d.id, d.runtime])).toEqual([
        ['Pixel_9', 'system-images;android-36;google_apis;arm64-v8a'],
        ['Sealed', null],
      ]);
      expect(inventory.systemImages).toEqual([]);
      expect(inventory.notices).toEqual([
        expect.stringMatching(/^Android system images not listed: EACCES/),
        expect.stringContaining(`AVDs in ${lockedAvdRoot} not listed: EACCES`),
        expect.stringMatching(/^AVD Locked not listed: EACCES/),
        expect.stringMatching(/^details of AVD Sealed not listed: EACCES/),
      ]);
    } finally {
      chmodSync(lockedAvdRoot, 0o700);
      chmodSync(join(userAvdRoot, 'Sealed.avd'), 0o700);
      chmodSync(images, 0o700);
      for (const [key, value] of Object.entries(savedSdk)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test('report-mode gc lists a seeded orphaned ios sim but issues no shutdown or delete command', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-9', name: 'stim-report-orphan' }],
    execCalls,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  const payload = await gcJson({ dryRun: true, pressure: 'normal' }, true);

  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'delete-orphaned-devices', outcome: 'would' }),
  );
  expect(payload.sections?.orphanedDevices).toEqual([
    expect.objectContaining({ id: 'UDID-9', name: 'stim-report-orphan' }),
  ]);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test("gc reaps a dead project's owned orphan device in the same run it prunes the entry", async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({
    version: 2,
    projects: {
      [localDeadPath]: {
        metroPort: 8100,
        platforms: { ios: { deviceUdid: 'UDID-DEAD', owned: true } },
      },
    },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-DEAD', name: 'stim-dead-owner' }],
    execCalls,
  });

  await sweepingGc({ pressure: 'normal' });

  const cfg = currentConfig();
  expect(cfg.projects[localDeadPath]).toBe(undefined);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown UDID-DEAD'))).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-DEAD'))).toBeTruthy();
});

test('gc with no config names Stim devices it cannot verify, but never touches them', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'stim-someones-live-env', state: 'Booted' }],
    execCalls,
  });

  const payload = await gcJson({ pressure: 'normal' });

  expect(payload.actions.some((action) => action.kind === 'delete-orphaned-devices')).toBe(false);
  expect(payload.actions.filter((action) => action.kind === 'keep').map((action) => action.detail)).toContainEqual(
    expect.stringContaining('stim-someones-live-env'),
  );
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test('a config scoped by STIM_HOME never sweeps machine-global devices through the CLI', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-REAL-1', name: 'stim-real-env-1', state: 'Booted' },
      { udid: 'UDID-REAL-2', name: 'stim-real-env-2' },
    ],
    execCalls,
  });
  const livePath = join(fakeHome, 'some-project');
  mkdirSync(livePath, { recursive: true });
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-ELSEWHERE', owned: true } } } },
    repos: {},
  });

  const configBefore = currentConfig();
  const { stdout } = await captureJson(() => cli(['--pressure', 'normal', '--json']));
  const payload = JSON.parse(stdout.at(-1) ?? '');

  expect(payload.actions.some((action: GcPayloadAction) => action.kind === 'delete-orphaned-devices')).toBe(false);
  expect(execCalls.filter((cmd) => cmd.includes('UDID-REAL-'))).toEqual([]);
  expect(currentConfig()).toEqual(configBefore);
});

test("under a scoped STIM_HOME, the dry run lists a dead project's owned device as to be deleted and the rest as not touched", async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({
    version: 2,
    projects: {
      [localDeadPath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-DEAD', owned: true } } },
    },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-DEAD', name: 'stim-dead-owner' },
      { udid: 'UDID-REAL-1', name: 'stim-real-env-1' },
    ],
    execCalls,
  });

  const payload = await gcJson({ dryRun: true, pressure: 'normal' });

  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'prune-project', target: localDeadPath, outcome: 'would' }),
  );
  expect(payload.sections?.unverifiedDevices).toEqual([]);
  expect(execCalls.some((c) => c.includes('simctl delete'))).toBe(false);
});

test("under a scoped STIM_HOME, gc tears down a pruned dead project's owned device and leaves other stim devices alone", async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({
    version: 2,
    projects: {
      [localDeadPath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-DEAD', owned: true } } },
    },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-DEAD', name: 'stim-dead-owner', state: 'Booted' },
      { udid: 'UDID-REAL-1', name: 'stim-real-env-1', state: 'Booted' },
    ],
    execCalls,
  });

  await cli(['--pressure', 'normal']);

  expect(currentConfig().projects[localDeadPath]).toBe(undefined);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-DEAD'))).toBe(true);
  expect(execCalls.filter((cmd) => cmd.includes('UDID-REAL-'))).toEqual([]);
});

test('the STIM_HOME guard does not disable dead-entry pruning', async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({ version: 2, projects: { [localDeadPath]: { metroPort: 8100 } }, repos: {} });
  installExecutor();

  await cli(['--pressure', 'normal']);

  expect(currentConfig().projects[localDeadPath]).toBe(undefined);
});

test('gc reports a live project whose recorded sim is gone, and clears the record only', async () => {
  const livePath = join(fakeHome, 'live-project');
  usedDaysAgo(livePath, 1);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-VANISHED', owned: true } } } },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({ devices: [], execCalls });

  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  expect((await deviceRecords()).staleDeviceRecords).toEqual([
    expect.objectContaining({ kind: 'ios', id: 'UDID-VANISHED', project: livePath }),
  ]);
  expect(currentConfig().projects[livePath]?.platforms?.ios).toBeTruthy();

  await captureLog(() => sweepingGc({ pressure: 'normal' }));
  const cfg = currentConfig();
  expect(cfg.projects[livePath]).toBeTruthy();
  expect(cfg.projects[livePath]?.platforms?.ios).toBe(undefined);
  expect(execCalls.some((c) => /simctl (shutdown|delete)/.test(c))).toBe(false);
  expect(execCalls.some((c) => /avdmanager delete/.test(c))).toBe(false);
});

test('a recorded sim that IS on the machine is not a stale record', async () => {
  const livePath = join(fakeHome, 'live-project');
  usedDaysAgo(livePath, 0);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-HERE', owned: true } } } },
    repos: {},
  });
  installDeviceExecutor({ devices: [{ udid: 'UDID-HERE', name: 'stim-live' }], execCalls: [] });

  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  expect((await deviceRecords()).staleDeviceRecords).toEqual([]);
  await captureLog(() => sweepingGc({ pressure: 'normal' }));
  expect(currentConfig().projects[livePath]?.platforms?.ios).toBeTruthy();
});

test('a dry run reports a registered cache with its size, without being asked for it', async () => {
  const cacheDir = join(fakeHome, 'my-cache');
  mkdirSync(join(cacheDir, 'entry-a'), { recursive: true });
  writeFileSync(join(cacheDir, 'entry-a', 'blob'), 'x'.repeat(1000));
  register({ dir: cacheDir, name: 'My cache', note: 'a test cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const payload = await gcJson({ dryRun: true, pressure: 'normal' });

  expect(payload.sections?.caches).toContainEqual(
    expect.objectContaining({ name: 'My cache', dir: cacheDir, source: 'registered' }),
  );
});

test('gc keeps the shared Gradle build cache below critical, and at critical under a scoped home', async () => {
  const previous = process.env.GRADLE_USER_HOME;
  const gradleHome = join(fakeHome, 'gradle-home');
  const cachesRoot = join(gradleHome, 'caches');
  const cacheDir = join(cachesRoot, 'build-cache-1');
  const cacheAlias = join(gradleHome, 'caches-alias');
  const entry = join(cacheDir, 'entry-a');
  mkdirSync(cacheDir, { recursive: true });
  symlinkSync(cachesRoot, cacheAlias, 'dir');
  writeFileSync(entry, 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(entry, old, old);
  process.env.GRADLE_USER_HOME = gradleHome;
  saveConfig({ version: 2, projects: {}, repos: {} });
  register({ dir: cacheAlias, name: 'Gradle build cache', prune: 'entries' });
  installExecutor();

  try {
    for (const pressure of ['normal', 'high', 'critical'] as const) {
      await captureJson(() => runGc({ pressure }));
      expect(existsSync(entry)).toBeTruthy();
    }
  } finally {
    if (previous === undefined) delete process.env.GRADLE_USER_HOME;
    else process.env.GRADLE_USER_HOME = previous;
  }
});

test('a caches path committed in .stim.json is neither reported nor trimmed', async () => {
  const project = join(fakeHome, 'app');
  const committed = join(fakeHome, 'Documents');
  const entry = join(committed, 'notes');
  mkdirSync(project, { recursive: true });
  mkdirSync(committed, { recursive: true });
  writeFileSync(entry, 'x');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(entry, old, old);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(project, '.stim.json'), JSON.stringify({ caches: [committed] }));
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    const payload = await gcJson({ pressure: 'normal' });
    expect(JSON.stringify(payload.actions)).not.toContain(committed);
    expect(existsSync(entry)).toBe(true);
  } finally {
    process.chdir(previousCwd);
  }
});

test('the age sweep trims the cache entries nothing has touched', async () => {
  const cacheDir = join(fakeHome, 'my-cache');
  const oldEntry = join(cacheDir, 'entry-old');
  const freshEntry = join(cacheDir, 'entry-fresh');
  mkdirSync(oldEntry, { recursive: true });
  mkdirSync(freshEntry, { recursive: true });
  writeFileSync(join(oldEntry, 'blob'), 'x'.repeat(1000));
  writeFileSync(join(freshEntry, 'blob'), 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(oldEntry, old, old);
  register({ dir: cacheDir, name: 'My cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--pressure', 'normal']);

  expect(existsSync(oldEntry)).toBe(false);
  expect(existsSync(freshEntry)).toBeTruthy();
});

test('the age sweep ignores a legacy Metro parent registered after its named child', async () => {
  const parent = join(tmpHome, 'metro-cache');
  const child = join(parent, 'demo');
  const shard = join(child, '0a');
  const currentTransform = join(shard, 'current');
  const legacyShard = join(parent, '1b');
  const legacyTransform = join(legacyShard, 'legacy');
  mkdirSync(shard, { recursive: true });
  mkdirSync(legacyShard, { recursive: true });
  writeFileSync(currentTransform, 'current');
  writeFileSync(legacyTransform, 'legacy');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(shard, old, old);
  utimesSync(legacyTransform, old, old);
  register({
    dir: child,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  register({ dir: parent, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--pressure', 'normal']);

  expect(existsSync(currentTransform)).toBe(true);
  expect(existsSync(legacyTransform)).toBe(true);
});

test('the age sweep ignores a legacy Metro parent whose named child is a symlink', async () => {
  const parent = join(tmpHome, 'metro-cache');
  const target = join(tmpHome, 'metro-target');
  const child = join(parent, 'demo');
  const shard = join(target, '0a');
  const currentTransform = join(shard, 'current');
  mkdirSync(parent, { recursive: true });
  mkdirSync(shard, { recursive: true });
  writeFileSync(currentTransform, 'current');
  symlinkSync(target, child, 'dir');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(shard, old, old);
  register({
    dir: child,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  register({ dir: parent, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--pressure', 'normal']);

  expect(existsSync(currentTransform)).toBe(true);
});

test('the age sweep keeps a current Metro store that is also a current override parent', async () => {
  const parent = join(tmpHome, 'metro-cache', 'first-app');
  const child = join(parent, 'second-app');
  const parentTransform = join(parent, '0a', 'old-parent-transform');
  const childTransform = join(child, '1b', 'current-child-transform');
  mkdirSync(dirname(parentTransform), { recursive: true });
  mkdirSync(dirname(childTransform), { recursive: true });
  writeFileSync(parentTransform, 'parent');
  writeFileSync(childTransform, 'child');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(parentTransform, old, old);
  utimesSync(dirname(childTransform), old, old);
  register({
    dir: parent,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  register({
    dir: child,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const caches = discoverCaches();
  expect(caches.find((cache) => cache.dir === parent)?.prune).toBe('report-only');
  expect(caches.find((cache) => cache.dir === child)?.prune).toBe('entries');
  await cli(['--pressure', 'normal']);

  expect(existsSync(parentTransform)).toBe(true);
  expect(existsSync(childTransform)).toBe(true);
});

test('critical empties an index-backed cache that the age sweep cannot trim', async () => {
  const casDir = join(tmpHome, 'compilation-cache');
  const leaf = join(casDir, 'v9.data.leaf');
  const index = join(casDir, 'v4.actions');
  mkdirSync(casDir, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  writeFileSync(index, 'index');
  register({ dir: casDir, name: 'Xcode compilation cache', prune: 'atomic' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  stubDu();
  const plan = await gcJson({ dryRun: true, pressure: 'critical' });
  expect(plan.actions).toContainEqual(
    expect.objectContaining({ kind: 'empty-cache', target: casDir, outcome: 'would' }),
  );

  await captureJson(() => runGc({ pressure: 'normal' }));
  expect(existsSync(leaf)).toBeTruthy();

  const build = plantClaim(cacheClaimRoot(casDir), 'shared', liveClaimOwner(), {
    details: { platform: 'ios', projectRoot: '/w/app' },
  });
  const kept = await gcJson({ pressure: 'critical' });
  expect(kept.actions).toContainEqual(
    expect.objectContaining({ target: casDir, outcome: 'kept', detail: expect.stringContaining('ios build') }),
  );
  expect(existsSync(leaf)).toBeTruthy();
  rmSync(build);

  await captureJson(() => runGc({ pressure: 'critical' }));
  expect(existsSync(leaf)).toBe(false);
  expect(existsSync(index)).toBe(false);
});

describe('gc and the Swift compilation cache cap', () => {
  const casDir = () => join(tmpHome, 'compilation-cache');
  const leaf = () => join(casDir(), 'v9.data.leaf');
  const OVER_CAP_GB = '0.000001';
  beforeEach(() => {
    mkdirSync(casDir(), { recursive: true });
    writeFileSync(leaf(), 'x'.repeat(4000));
    writeFileSync(join(casDir(), 'v4.actions'), 'index');
    register({ dir: casDir(), name: 'Xcode compilation cache', prune: 'atomic' });
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const base = getExecutor();
    setExecutor({
      ...base,
      runFileAsync: async (file, args, options) =>
        file === 'du' ? `5\t${args?.[1] ?? ''}` : base.runFileAsync(file, args, options),
    });
  });
  afterEach(() => {
    delete process.env.STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB;
  });

  test('empties the cache whole when it exceeds the cap and no build holds it', async () => {
    process.env.STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB = OVER_CAP_GB;
    const dryRun = await gcJson({ dryRun: true, pressure: 'normal' });
    expect(dryRun.actions).toContainEqual(
      expect.objectContaining({ target: expect.stringContaining(casDir()), outcome: 'would' }),
    );
    expect(existsSync(leaf())).toBe(true);

    await captureLog(() => cli(['--pressure', 'normal']));
    expect(existsSync(leaf())).toBe(false);
    expect(existsSync(join(casDir(), 'v4.actions'))).toBe(false);
  });

  test('keeps it, naming the build, while a build holds the cache', async () => {
    process.env.STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB = OVER_CAP_GB;
    const build = plantClaim(cacheClaimRoot(casDir()), 'shared', liveClaimOwner(), {
      details: { platform: 'ios', projectRoot: '/w/app' },
    });
    const payload = await gcJson({ pressure: 'normal' });
    expect(payload.actions).toContainEqual(
      expect.objectContaining({ outcome: 'kept', detail: expect.stringContaining(`pid ${process.pid} in /w/app`) }),
    );
    expect(existsSync(leaf())).toBe(true);
    rmSync(build);
  });

  test('keeps it under the cap', async () => {
    process.env.STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB = '1';
    await captureLog(() => cli(['--pressure', 'normal']));
    expect(existsSync(leaf())).toBe(true);
  });

  test('keeps it when the cap is 0', async () => {
    process.env.STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB = '0';
    await captureLog(() => cli(['--pressure', 'normal']));
    expect(existsSync(leaf())).toBe(true);
  });
});

test('critical empties an entries-style cache including entries used today', async () => {
  const cacheDir = join(tmpHome, 'my-cache');
  const freshEntry = join(cacheDir, 'entry-fresh');
  mkdirSync(freshEntry, { recursive: true });
  writeFileSync(join(freshEntry, 'blob'), 'x'.repeat(1000));
  register({ dir: cacheDir, name: 'My cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await captureJson(() => runGc({ pressure: 'critical' }));

  expect(existsSync(freshEntry)).toBe(false);
  expect(existsSync(cacheDir)).toBeTruthy();
});

test('a dry run at critical reports what would be emptied and writes nothing', async () => {
  const casDir = join(tmpHome, 'compilation-cache');
  const leaf = join(casDir, 'v9.data.leaf');
  mkdirSync(casDir, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  register({ dir: casDir, name: 'Xcode compilation cache', prune: 'atomic' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const before = loadConfig();

  stubDu();
  const payload = await gcJson({ dryRun: true, pressure: 'critical' });

  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'empty-cache', target: casDir, outcome: 'would' }),
  );
  expect(existsSync(leaf)).toBeTruthy();
  expect(loadConfig()).toEqual(before);
});

test('critical under a scoped home leaves machine-global caches alone', async () => {
  const globalCas = join(fakeHome, 'Library', 'Developer', 'Xcode', 'DerivedData', 'CompilationCache.noindex');
  const leaf = join(globalCas, 'v9.data.leaf');
  mkdirSync(globalCas, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await captureJson(() => runGc({ pressure: 'critical' }));

  expect(existsSync(leaf)).toBeTruthy();
});

test('the age sweep under a scoped home leaves machine-global caches alone', async () => {
  const map = join(fakeHome, 'metro-file-map-abc123');
  writeFileSync(map, 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(map, old, old);
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await captureJson(() => runGc({ pressure: 'normal' }));

  expect(existsSync(map)).toBeTruthy();
});

function writeLock({
  platform = 'ios',
  key = 'abc-debug-sim',
  pid,
  projectRoot = '/w/app-412',
}: {
  platform?: string;
  key?: string;
  pid: number;
  projectRoot?: string;
}) {
  const path = join(tmpHome, 'build-locks', `${platform}-${key}.lock`);
  plantClaim(path, 'exclusive', pid === process.pid ? liveClaimOwner() : goneClaimOwner(pid), {
    details: { projectRoot, logFile: `${projectRoot}/.stim/logs/build-${platform}.ndjson` },
  });
  return path;
}

test('gc removes the stale lock and leaves the live one alone', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const live = writeLock({ pid: process.pid, projectRoot: '/w/alive' });
  const stale = writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' });

  await captureLog(() => sweepingGc({ pressure: 'normal' }));
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(live)).toBe(true);
});

describe('gc --json', () => {
  const deadPath = () => join(fakeHome, 'no-longer-here');

  beforeEach(() => {
    saveConfig({ version: 2, projects: { [deadPath()]: { metroPort: 8101 } }, repos: {} });
    installExecutor();
  });

  test('a dry run prints one payload with every section and deletes nothing', async () => {
    saveConfig({ version: 2, projects: { [deadPath()]: { metroPort: 8101, ports: { web: 8102 } } }, repos: {} });
    const lock = writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' });
    const before = loadConfig();

    const { stdout } = await captureJson(() => cli(['--dry-run', '--pressure', 'normal', '--json']));

    expect(stdout).toHaveLength(1);
    const payload = JSON.parse(stdout[0] ?? '');
    expect(payload).toMatchObject({ mode: 'dry-run', level: 'normal', actionable: true, failures: null, results: [] });
    expect(payload.actions).toContainEqual(
      expect.objectContaining({ kind: 'prune-project', target: deadPath(), outcome: 'would' }),
    );
    expect(payload.actions).toContainEqual(expect.objectContaining({ kind: 'forget-stale-records', outcome: 'would' }));
    expect(payload.sections.deadProjects).toEqual([{ path: deadPath() }]);
    expect(payload.sections.orphanedPorts).toEqual([{ project: deadPath(), label: 'web', port: 8102 }]);
    expect(payload.sections.staleBuildLocks).toEqual([
      { path: lock, platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' },
    ]);
    expect(Object.keys(payload.sections)).toEqual([
      'deadProjects',
      'invalidProjects',
      'orphanedPorts',
      'orphanedWorkspaces',
      'linkedWorktrees',
      'unlistedWorktreeDirectories',
      'parkedSimulators',
      'parkedEmulators',
      'parkedHostedDevices',
      'hostedAppStorage',
      'otherHomes',
      'orphanedDevices',
      'unverifiedDevices',
      'simulatorLaunchdFolders',
      'staleDevices',
      'finishedDevices',
      'ownedDeviceDisk',
      'staleDeviceRecords',
      'staleLedgerEntries',
      'staleEasLedgerEntries',
      'staleStatusCaches',
      'orphanedEasSessions',
      'staleBuildLocks',
      'staleBuildSlots',
      'unresolvedBuildClaims',
      'buildsInProgress',
      'expiredDeviceLeases',
      'keptDeviceLeases',
      'deviceSweepNotices',
      'easSessionSweepNotices',
      'skipped',
      'workspaceLogs',
      'recordings',
      'workspaceBuildOutputs',
      'caches',
      'agentDevice',
      'swiftpmCache',
      'machineCaches',
      'tempLeftovers',
      'trash',
      'gradleVersions',
      'memory',
      'watchmanRoots',
      'memoryNotices',
    ]);
    expect(loadConfig()).toEqual(before);
    expect(existsSync(lock)).toBe(true);
  });

  test('an acting run prints the actions it took and the failure count', async () => {
    const lock = writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' });

    const { stdout } = await captureJson(() => cli(['--pressure', 'normal', '--json']));

    expect(stdout).toHaveLength(1);
    const payload = JSON.parse(stdout[0] ?? '');
    expect(payload).toMatchObject({ mode: 'delete', actionable: true, failures: 0 });
    expect(payload).not.toHaveProperty('sections');
    expect(payload.actions).toContainEqual(
      expect.objectContaining({ kind: 'prune-project', target: deadPath(), outcome: 'done' }),
    );
    expect(currentConfig().projects[deadPath()]).toBe(undefined);
    expect(existsSync(lock)).toBe(false);
  });
});

test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'gc continues after staging cleanup fails and leaves no cleanup claim (skipped on Windows: mode 0 does not stop a directory from being deleted)',
  async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const blocked = join(tmpHome, 'build-locks', 'ios-staging.lock');
    const staging = join(blocked, '.staging-interrupted');
    const writable = join(tmpHome, 'build-slots', 'slot-0');
    mkdirSync(staging, { recursive: true });
    mkdirSync(writable, { recursive: true });
    writeFileSync(join(staging, 'partial.claim'), '{');
    chmodSync(staging, 0);
    try {
      const payload = await gcJson({ pressure: 'normal' }, true);
      expect(payload.actions).toContainEqual(
        expect.objectContaining({ kind: 'forget-stale-records', outcome: 'failed' }),
      );
      expect(payload.failures).toBe(1);
      expect(existsSync(staging)).toBe(true);
      expect(existsSync(writable)).toBe(false);
      expect(readClaimSet(blocked).live).toEqual([]);
    } finally {
      chmodSync(staging, 0o700);
    }
  },
);

test('gc keeps a lock whose holder cannot be identified', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const path = join(tmpHome, 'build-locks', 'ios-unresolved-debug-sim.lock');
  plantClaim(path, 'exclusive', { pid: 4242, processToken: 'nonsense' });

  const claims = collectStaleClaims();
  expect(claims.buildLocks.stale).toEqual([]);
  expect((claims.buildLocks.unresolved ?? []).map((l) => l.path)).toEqual([path]);

  await captureLog(() => sweepingGc({ pressure: 'normal' }));
  expect(existsSync(join(path, 'exclusive'))).toBe(true);
});

test('a dry run removes no lock at all', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const stale = writeLock({ pid: IMPOSSIBLE_PID });
  await captureLog(() => sweepingGc({ dryRun: true, pressure: 'normal' }));
  expect(existsSync(stale)).toBe(true);
});

function writeSlot({
  index = 0,
  pid,
  projectRoot = '/w/app-412',
}: {
  index?: number;
  pid: number;
  projectRoot?: string;
}) {
  const path = join(tmpHome, 'build-slots', `slot-${index}`);
  plantClaim(path, 'exclusive', pid === process.pid ? liveClaimOwner() : goneClaimOwner(pid), {
    details: { index, projectRoot },
  });
  return path;
}

test('gc removes the stale build slot and leaves a live one alone', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const live = writeSlot({ index: 0, pid: process.pid, projectRoot: '/w/alive' });
  const stale = writeSlot({ index: 1, pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' });

  await captureLog(() => sweepingGc({ pressure: 'normal' }));
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(live)).toBe(true);
});

describe('gc against a claim taken while gc is deleting', { timeout: 60_000 }, () => {
  const SRC_URL = new URL('../', import.meta.url).href;
  const CHILD_TIMEOUT_MS = 40_000;
  const BARRIER_MS = 25_000;

  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'stim-gc-race-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  // A barrier the child cannot miss: both sides only ever create files, and the child blocks in a
  // synchronous spin because every removal it is paused inside runs on its main thread.
  const WAIT_FOR_FILE = [
    'const waitForFile = (file) => {',
    `  const deadline = Date.now() + ${BARRIER_MS};`,
    '  while (!fs.existsSync(file)) {',
    "    if (Date.now() > deadline) throw new Error('barrier timed out: ' + file);",
    '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    '  }',
    '};',
  ].join('\n');

  function script(name: string, body: string) {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return path;
  }

  function start(path: string, args: string[]) {
    const child = spawn(process.execPath, [path, ...args], {
      env: { ...process.env, STIM_HOME: tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    let exited = false;
    const done = once(child, 'exit')
      .then(([code]) => {
        if (code !== 0) throw new Error(`${path} exited ${code}: ${output}`);
        return output;
      })
      .finally(() => {
        exited = true;
        clearTimeout(timer);
      });
    void done.catch(() => undefined);
    async function waitForFile(file: string) {
      const deadline = Date.now() + BARRIER_MS;
      while (!existsSync(file)) {
        if (exited) {
          await done;
          throw new Error(`${path} exited before ${file}: ${output}`);
        }
        if (Date.now() > deadline) throw new Error(`barrier timed out: ${file}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    return { child, done, waitForFile };
  }

  // gc, paused inside the first removal it makes anywhere under the claim set it decided was stale.
  const gcScript = () =>
    script(
      'gc.mjs',
      [
        "import fs from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const [claimSet, ready, proceed] = process.argv.slice(2);',
        WAIT_FOR_FILE,
        'let paused = false;',
        'const pauseOnce = (path) => {',
        '  if (paused || !String(path).startsWith(claimSet)) return;',
        '  paused = true;',
        '  fs.writeFileSync(ready, String(path));',
        '  waitForFile(proceed);',
        '};',
        'const realRm = fs.rmSync;',
        'const realRmdir = fs.rmdirSync;',
        'fs.rmSync = (path, options) => (pauseOnce(path), realRm(path, options));',
        'fs.rmdirSync = (path, options) => (pauseOnce(path), realRmdir(path, options));',
        'syncBuiltinESMExports();',
        `const { setExecutor } = await import(${JSON.stringify(SRC_URL)} + 'exec.ts');`,
        'setExecutor({',
        "  run: () => '',",
        '  runQuiet: () => null,',
        '  runFileQuiet: () => null,',
        "  runFile: () => '',",
        "  spawn: () => { throw new Error('unexpected tool spawn'); },",
        '});',
        `const { runGc } = await import(${JSON.stringify(SRC_URL)} + 'commands/gc.ts');`,
        "await runGc({ pressure: 'normal' });",
      ].join('\n'),
    );

  // A competing build: takes the claim set while gc is paused, then holds it.
  const holderScript = () =>
    script(
      'holder.mjs',
      [
        "import fs from 'node:fs';",
        'const [claimSet, acquired, proceed] = process.argv.slice(2);',
        WAIT_FOR_FILE,
        `const { tryAcquireClaim, releaseClaim } = await import(${JSON.stringify(SRC_URL)} + 'ownership-claim.ts');`,
        `const deadline = Date.now() + ${BARRIER_MS};`,
        'let got;',
        'for (;;) {',
        "  got = tryAcquireClaim({ root: claimSet, mode: 'exclusive' });",
        '  if (got.pending) releaseClaim(got.pending);',
        '  if (got.acquired) break;',
        "  if (Date.now() > deadline) throw new Error('never acquired the claim');",
        '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
        '}',
        "fs.writeFileSync(acquired + '.tmp', JSON.stringify(got.acquired));",
        "fs.renameSync(acquired + '.tmp', acquired);",
        'waitForFile(proceed);',
      ].join('\n'),
    );

  const claimSets = [
    { kind: 'build lock', set: () => writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID }) },
    { kind: 'build slot', set: () => writeSlot({ index: 1, pid: IMPOSSIBLE_PID }) },
  ];

  for (const { kind, set } of claimSets) {
    test(`a ${kind} taken while gc deletes it keeps its new holder, and no second process takes it`, async () => {
      saveConfig({ version: 2, projects: {}, repos: {} });
      installExecutor();
      const claimSet = set();
      const file = (name: string) => join(scratch, name);

      const gc = start(gcScript(), [claimSet, file('gc.ready'), file('gc.go')]);
      await gc.waitForFile(file('gc.ready'));

      const holder = start(holderScript(), [claimSet, file('a.acquired'), file('a.go')]);
      await holder.waitForFile(file('a.acquired'));
      const held = JSON.parse(readFileSync(file('a.acquired'), 'utf-8')) as { path: string; claimId: string };

      writeFileSync(file('gc.go'), 'go');
      const gcOutput = await gc.done;

      try {
        expect(existsSync(held.path)).toBe(true);
        expect(readClaimSet(claimSet).live.map((h) => h.claimId)).toEqual([held.claimId]);
        const second = tryAcquireClaim({ root: claimSet, mode: 'exclusive' });
        if (second.acquired) releaseClaim(second.acquired);
        if (second.pending) releaseClaim(second.pending);
        expect(second.acquired).toBe(undefined);
        expect(second.held?.claimId).toBe(held.claimId);
        expect(gcOutput).not.toMatch(/Cleared/);
      } finally {
        writeFileSync(file('a.go'), 'go');
        await holder.done;
      }
    });
  }

  test('a claim that becomes unresolvable while gc deletes it is left alone, not removed', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const claimSet = writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID });
    const file = (name: string) => join(scratch, name);

    const gc = start(gcScript(), [claimSet, file('gc.ready'), file('gc.go')]);
    await gc.waitForFile(file('gc.ready'));

    const spawning = plantClaim(claimSet, 'exclusive', goneClaimOwner(), {
      claimId: 'spawning',
      child: { record: null },
    });
    writeFileSync(file('gc.go'), 'go');
    const gcOutput = await gc.done;

    expect(existsSync(spawning)).toBe(true);
    expect(readClaimSet(claimSet).unresolved.map((p) => p.path)).toEqual([spawning]);
    expect(gcOutput).not.toMatch(/Cleared/);
  });
});

function writeLeaseFile({
  platform = 'ios',
  id = 'UDID-LEASE',
  holder = '/w/holder',
  expiresInMs = 60_000,
  body = null,
}: {
  platform?: string;
  id?: string;
  holder?: string;
  expiresInMs?: number;
  body?: string | null;
}) {
  mkdirSync(deviceLocksDir(), { recursive: true });
  const path = deviceLeasePath(platform, id);
  const now = Date.now();
  writeFileSync(
    path,
    body ??
      JSON.stringify({
        version: 1,
        platform,
        id,
        deviceName: 'Old iPhone',
        holder,
        token: 'token-1',
        grantedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + expiresInMs).toISOString(),
      }),
  );
  return path;
}

describe('expired device leases', () => {
  test('a dry run reports an expired lease and removes nothing', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const path = writeLeaseFile({ expiresInMs: -1000 });

    expect(collectDeviceLeases(Date.now()).expired).toEqual([
      expect.objectContaining({ path, id: 'UDID-LEASE', lease: expect.objectContaining({ holder: '/w/holder' }) }),
    ]);
    const payload = await gcJson({ dryRun: true, pressure: 'normal' }, true);
    expect(payload.actions).toContainEqual(expect.objectContaining({ kind: 'delete-device-lease', outcome: 'would' }));
    expect(existsSync(path)).toBe(true);
  });

  test('gc removes the expired lease and leaves a live one alone', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const expired = writeLeaseFile({ id: 'UDID-OLD', expiresInMs: -1000 });
    const live = writeLeaseFile({ id: 'UDID-LIVE', holder: tmpHome, expiresInMs: 600_000 });

    await captureLog(() => sweepingGc({ pressure: 'normal' }));
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test('a file that does not parse is reported and kept', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const path = writeLeaseFile({ id: 'UDID-BROKEN', body: '{ not a lease' });

    expect(collectDeviceLeases(Date.now()).kept).toEqual([expect.objectContaining({ path })]);
    await captureLog(() => sweepingGc({ pressure: 'normal' }));
    expect(existsSync(path)).toBe(true);
  });

  test('an unexpired lease whose holder is gone is reported and kept', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const path = writeLeaseFile({ id: 'UDID-ABSENT', holder: join(fakeHome, 'unmounted'), expiresInMs: 600_000 });

    expect(collectDeviceLeases(Date.now()).kept).toEqual([expect.objectContaining({ path })]);
    await captureLog(() => sweepingGc({ pressure: 'normal' }));
    expect(existsSync(path)).toBe(true);
  });

  test('a lease of a live workspace is not reported at all', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    writeLeaseFile({ holder: tmpHome, expiresInMs: 600_000 });

    expect(collectDeviceLeases(Date.now())).toMatchObject({ expired: [], kept: [] });
  });
});

test('GC preserves named-slot references on unavailable volumes and identifies stale records by slot', () => {
  const config = makeConfig({
    projects: {
      '/Volumes/offline/app': {
        platforms: { ios: { deviceUdid: 'DEFAULT', owned: true } },
        deviceSlots: {
          phone: { ios: { deviceUdid: 'PHONE', owned: true } },
          tablet: { ios: { deviceUdid: 'TABLET', owned: true } },
          emulator: { android: { avdName: 'stim-extra', owned: true } },
        },
      },
    },
  });
  const sims = ['DEFAULT', 'PHONE', 'TABLET'].map((udid) => makeIosSim({ udid, name: `stim-${udid}` }));
  const result = findOrphanedDevices({ config, sims, avds: ['stim-extra'], isMounted: () => false });
  expect(result.orphaned).toEqual([]);
  expect(result.kept).toHaveLength(4);
  const stale = findStaleDeviceRecords({ config, sims: sims.slice(0, 1), avds: [] });
  expect(stale.map(({ slot, id }) => [slot, id])).toEqual([
    ['phone', 'PHONE'],
    ['tablet', 'TABLET'],
    ['emulator', 'stim-extra'],
  ]);
});

test('gc reports and reclaims named ports only for confirmed missing workspaces', async () => {
  const missing = join(fakeHome, 'missing-ports');
  const unmounted = '/Volumes/StimTestVolumeThatDoesNotExist/named-ports';
  upsertProject(missing, { ports: { web: 8900 } });
  upsertProject(unmounted, { ports: { web: 8901 } });
  installExecutor();
  const original = getExecutor();
  const inspected: string[] = [];
  setExecutor({
    ...original,
    findExecutable: (name) => (name === 'lsof' ? '/usr/sbin/lsof' : null),
    runFile: (file, args, opts) => {
      if (file === 'netstat') {
        inspected.push(args.join(' '));
        return 'Proto Local Address Foreign Address State PID\n';
      }
      if (file === 'lsof') {
        inspected.push(args[1]);
        return '';
      }
      return original.runFile(file, args, opts);
    },
    runQuiet: (cmd, opts) => {
      if (cmd.startsWith('lsof ')) {
        inspected.push(cmd.split(' ')[2]!);
        return '';
      }
      return original.runQuiet(cmd, opts);
    },
  });
  const payload = await gcJson({ dryRun: true, pressure: 'normal' });
  expect(payload.sections?.orphanedPorts).toEqual([{ project: missing, label: 'web', port: 8900 }]);
  expect(inspected).toEqual([]);
  await cli(['--pressure', 'normal']);
  expect(getProject(missing)).toBeNull();
  expect(getProject(unmounted)?.ports).toEqual({ web: 8901 });
  expect(inspected).toEqual([]);
});

test('unscoped gc JSON reports agent-device separately without adding actionable cleanup', async () => {
  installExecutor();
  const dir = join(fakeHome, '.agent-device');
  mkdirSync(dir);
  writeFileSync(join(dir, 'keep'), 'agent-device-owned');
  const { stdout } = await captureJson(() => cli(['--dry-run', '--pressure', 'normal', '--json']));
  expect(stdout).toHaveLength(1);
  const report = JSON.parse(stdout[0]!);
  expect(report.sections.agentDevice).toMatchObject({
    version: 1,
    stateDir: { dir: realpathSync.native(dir), present: true },
  });
  expect(report.sections.caches.some((entry: { dir: string }) => entry.dir === dir)).toBe(false);
  expect(report.actionable).toBe(false);
  expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('agent-device-owned');
});

test.each(['normal', 'critical'] as const)(
  'gc at %s leaves agent-device and SwiftPM bytes intact',
  async (pressure) => {
    installExecutor();
    const project = realpathSync.native(fakeHome);
    writeFileSync(join(project, 'package.json'), '{}');
    upsertProject(project, { platforms: {} });
    ensureWorkspaceStorage(project);
    const dirs = [
      swiftpmDir(),
      join(fakeHome, '.gradle', 'caches', '9.3.1'),
      join(fakeHome, '.gradle', 'caches', 'modules-2'),
      join(fakeHome, '.agent-device'),
      join(tmpHome, 'server', 'agent-device'),
      join(workspaceDir(project), 'agent-device'),
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'keep'), Buffer.from([0, 1, 255]));
    }
    const report = await gcJson({ pressure });
    expect(JSON.stringify(report.actions.filter((action) => action.outcome === 'done'))).not.toMatch(
      /agent-device|swiftpm|gradle/i,
    );
    for (const dir of dirs) expect(readFileSync(join(dir, 'keep'))).toEqual(Buffer.from([0, 1, 255]));
  },
);

function swiftpmDir(): string {
  return process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Caches', 'org.swift.swiftpm')
    : join(fakeHome, '.cache', 'org.swift.swiftpm');
}

test('unscoped gc reports SwiftPM without making it actionable or a cache', async () => {
  installExecutor();
  const dir = swiftpmDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep'), 'shared');
  mkdirSync(join(fakeHome, '.agent-device'));
  const { stdout } = await captureJson(() => cli(['--dry-run', '--pressure', 'normal', '--json']));
  expect(stdout).toHaveLength(1);
  const report = JSON.parse(stdout[0]!);
  expect(report.sections.swiftpmCache).toMatchObject({ version: 1, dir: realpathSync.native(dir), present: true });
  expect(report.sections.caches.some((entry: { dir: string }) => entry.dir === dir)).toBe(false);
  expect(report.actionable).toBe(false);
  expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('shared');
});

describe('parked hosted device GC', () => {
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const udid = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
  const parkedAt = '2026-01-01T00:00:00.000Z';

  function session(overrides: Partial<HostedDeviceSession> = {}): HostedDeviceSession {
    return {
      id: sessionId,
      client: 'client-1',
      workspace: '/client/project',
      slot: 'default',
      attempt: 'attempt-1',
      platform: 'ios',
      state: 'stopped',
      createdAt: parkedAt,
      parked: { at: parkedAt },
      deviceType: 'iPhone 17',
      runtime: '26.5',
      device: {
        udid,
        name: 'stim-hosted',
        deviceType: 'iPhone 17',
        runtime: '26.5',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        architecture: 'arm64',
      },
      ...overrides,
    };
  }

  function androidSession(): HostedDeviceSession {
    return session({
      id: '22222222-2222-2222-2222-222222222222',
      platform: 'android',
      deviceType: undefined,
      runtime: undefined,
      consolePort: 5554,
      systemImage: 'system-images;android-36;google_apis;arm64-v8a',
      deviceProfile: 'pixel_7',
      device: {
        avdName: 'stim-hosted-android',
        serial: 'emulator-5554',
        consolePort: 5554,
        systemImage: 'system-images;android-36;google_apis;arm64-v8a',
        deviceProfile: 'pixel_7',
        architecture: 'arm64-v8a',
      },
    });
  }

  function journal(records: HostedDeviceSession[]) {
    mkdirSync(deviceHostRoot(), { recursive: true });
    writeFileSync(join(deviceHostRoot(), 'sessions.json'), JSON.stringify({ version: 1, sessions: records }));
    for (const record of records) {
      const home = join(deviceHostArea(record.id), 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'hosted-device.json'), JSON.stringify(record.device));
      writeFileSync(
        join(home, 'created-devices.json'),
        JSON.stringify({
          version: 1,
          ios: record.platform === 'ios' && record.device ? [hostedDeviceId(record.device)] : [],
          android: record.platform === 'android' && record.device ? [hostedDeviceId(record.device)] : [],
          web: [],
        }),
      );
    }
  }

  test.skipIf(process.platform === 'win32')(
    'unresolved hosted Android inventory retains its actual session claim',
    async () => {
      const record = androidSession();
      journal([record]);
      const original = getExecutor();
      resetExecutor();
      const real = getExecutor().runFileAsync.bind(getExecutor());
      const operation = testContext({ cwd: tmpHome, projectRoot: tmpHome });
      let owned: { pid: number; processToken: string } | undefined;
      let handles: ClaimHandle[] = [];
      let closed = Promise.resolve();
      const inspect = vi
        .spyOn(identities, 'inspectProcessIdentity')
        .mockImplementation((identity) =>
          owned && identity?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(identity),
        );
      setExecutor({
        ...original,
        runFileAsync: (file, args, options) => {
          if (!args.includes('-list-avds')) throw new Error(`Unexpected native query: ${file}`);
          return real(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            ...options,
            timeoutMs: 25,
            onSpawn: (child) => {
              options.onSpawn?.(child);
              const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
              if (child.pid === undefined || !birth?.ok) throw new Error('The hosted inventory child has no identity');
              owned = { pid: child.pid, processToken: birth.token };
              handles = [...operationState(operation).declaring];
              closed = new Promise<void>((resolve) => child.once('close', resolve));
            },
          });
        },
      });
      try {
        await expect(
          withAmbientContext(operation, () =>
            deleteParkedHostedDevices(collectParkedHostedDevices().devices, { operation }),
          ),
        ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
        if (!owned) throw new Error('The hosted inventory probe did not start');
        expect(inspectProcessIdentity(owned)).toBe('same');
        expect(readClaimSet(join(deviceHostRoot(), `${record.id}.claims`)).live).toMatchObject([
          { child: { pid: owned.pid } },
        ]);
        expect(readHostedDeviceLedger(join(deviceHostArea(record.id), 'home'))?.android).toEqual([
          'stim-hosted-android',
        ]);
      } finally {
        inspect.mockRestore();
        if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
        await closed;
        expect(owned ? await waitForProcessExit(owned, 5000) : true).toBe(true);
        for (const handle of handles) releaseClaim(handle);
      }
    },
  );

  function worker(result: unknown, beforeSpawn?: () => void) {
    const requests: { input: unknown; home: string }[] = [];
    const script = join(mkdtempSync(join(tmpHome, 'gc-worker-')), 'worker.mjs');
    writeFileSync(
      script,
      `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.mode !== 'stop' || !input.session || !['ios', 'android'].includes(input.platform)) process.exit(2);
      writeFileSync(join(process.env.STIM_HOME, 'request.json'), JSON.stringify(input));
      const ledger = JSON.parse(readFileSync(join(process.env.STIM_HOME, 'created-devices.json')));
      if (ledger[input.platform].length !== 1) process.exit(3);
      process.stdout.write(${JSON.stringify(JSON.stringify(result))});
    `,
    );
    setExecutor({
      ...getExecutor(),
      spawn(file, args, options) {
        expect(file).toBe(process.execPath);
        expect(args).toHaveLength(1);
        expect(args?.[0]).toMatch(/[/\\]device-host-worker\.mjs$/);
        beforeSpawn?.();
        const child = spawn(file, [script], options);
        child.once('close', () => {
          requests.push({
            input: JSON.parse(readFileSync(join(options!.cwd as string, 'request.json'), 'utf8')),
            home: options!.env!.STIM_HOME!,
          });
        });
        return child;
      },
    });
    return requests;
  }

  beforeEach(() => {
    takeGcResults();
    installExecutor();
  });

  afterEach(() => {
    takeGcResults();
  });

  test('collection lists only parked native sessions and reports session-home ledger ownership', () => {
    const android = androidSession();
    journal([
      session(),
      android,
      session({ id: '33333333-3333-3333-3333-333333333333', parked: undefined }),
      session({ id: '44444444-4444-4444-4444-444444444444', parked: undefined, state: 'ready' }),
      session({
        id: '55555555-5555-5555-5555-555555555555',
        parked: undefined,
        platform: 'macos',
        device: null,
        deviceType: undefined,
        runtime: undefined,
        appSlot: 1,
      }),
    ]);
    const home = join(deviceHostArea(android.id), 'home');
    writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [], android: [], web: [] }));
    expect(collectParkedHostedDevices()).toEqual({
      devices: [
        {
          session: sessionId,
          client: 'client-1',
          platform: 'ios',
          id: udid,
          name: 'stim-hosted',
          parkedAt,
          listed: true,
        },
        {
          session: android.id,
          client: 'client-1',
          platform: 'android',
          id: 'stim-hosted-android',
          name: 'stim-hosted-android',
          parkedAt,
          listed: false,
        },
      ],
      notices: [],
    });
    expect(collectParkedHostedDevices({ olderThanDays: 2, now: Date.parse(parkedAt) + DAY_MS }).devices).toEqual([]);
    expect(collectParkedHostedDevices({ olderThanDays: 1, now: Date.parse(parkedAt) + DAY_MS }).devices).toHaveLength(
      2,
    );
  });

  test('delete holds the session claim and sends stop to the private home, then records a verified result', async () => {
    journal([session()]);
    const requests = worker({ state: 'stopped', device: session().device }, () => {
      const claims = readClaimSet(join(deviceHostRoot(), `${sessionId}.claims`));
      expect(claims.live[0]?.childDeclared).toBe(true);
    });
    const journalBefore = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    expect(await deleteParkedHostedDevices(collectParkedHostedDevices().devices)).toBe(0);
    expect(requests).toEqual([
      {
        home: join(deviceHostArea(sessionId), 'home'),
        input: { mode: 'stop', platform: 'ios', session: sessionId, deviceType: 'iPhone 17', runtime: '26.5' },
      },
    ]);
    expect(takeGcResults()).toMatchObject([{ kind: 'parkedHostedDevice', status: 'done', id: udid }]);
    expect(readClaimSet(join(deviceHostRoot(), `${sessionId}.claims`)).live).toEqual([]);
    expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journalBefore);
  });

  // The worker's process group is signaled, which Node does not support on Windows (nodejs.org/api/process.html#processkillpid-signal).
  test.skipIf(process.platform === 'win32')(
    'a timed-out worker gets one SIGTERM and its surviving group gets SIGKILL only after five seconds',
    async () => {
      journal([session()]);
      const home = join(deviceHostArea(sessionId), 'home');
      const script = join(home, 'timeout-worker.mjs');
      writeFileSync(
        script,
        `
      import { spawn } from 'node:child_process';
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      for await (const chunk of process.stdin) {}
      spawn(process.execPath, ['--input-type=module', '-e',
        "import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.env.STIM_HOME+'/descendant-ready','ready'); setInterval(()=>{},1000);"
      ], { stdio: 'ignore' });
      while (!existsSync(join(process.env.STIM_HOME, 'descendant-ready'))) await new Promise(resolve => setTimeout(resolve, 10));
      writeFileSync(join(process.env.STIM_HOME, 'worker-ready'), 'ready');
      setInterval(()=>{},1000);
    `,
      );
      let child: ReturnType<typeof spawn> | undefined;
      setExecutor({
        ...getExecutor(),
        spawn(file, _args, options) {
          child = spawn(file, [script], options);
          return child;
        },
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const started = Date.now();
      const kill = vi.spyOn(process, 'kill');
      const deletion = deleteParkedHostedDevices(collectParkedHostedDevices().devices);
      const signals = () =>
        kill.mock.calls.filter(([pid, signal]) => pid === -child!.pid! && signal !== 0).map(([, signal]) => signal);
      try {
        await vi.waitFor(() => expect(existsSync(join(home, 'worker-ready'))).toBe(true));
        await vi.advanceTimersByTimeAsync(90_000 - (Date.now() - started));
        expect(signals()).toEqual(['SIGTERM']);
        await vi.waitFor(() => expect(child?.signalCode).toBe('SIGTERM'));
        await vi.advanceTimersByTimeAsync(94_999 - (Date.now() - started));
        expect(signals()).toEqual(['SIGTERM']);
        await vi.advanceTimersByTimeAsync(1);
        expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
        await vi.waitFor(() => expect(readClaimSet(join(deviceHostRoot(), `${sessionId}.claims`)).live).toEqual([]));
        expect(await deletion).toBe(1);
        expect(takeGcResults()).toMatchObject([{ status: 'failed', detail: expect.stringContaining('deadline') }]);
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
        vi.useRealTimers();
        kill.mockRestore();
      }
    },
  );

  // Node cannot signal POSIX process groups on Windows: https://nodejs.org/api/process.html#processkillpid-signal
  test.each([false, true])(
    'caller cancellation drains the hosted worker using the captured environment and skips later sessions (bounded=%s)',
    { skip: process.platform === 'win32' },
    async (bounded) => {
      const second = session({
        id: '22222222-2222-2222-2222-222222222222',
        device: { ...(session().device as HostedIosDevice), udid: 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC' },
      });
      journal([session(), second]);
      const home = join(deviceHostArea(sessionId), 'home');
      const ready = join(home, 'ready.json');
      const script = join(home, 'cancel-worker.mjs');
      writeFileSync(
        script,
        `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80));
      for await (const chunk of process.stdin) {}
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ tag: process.env.STIM_TEST_CONTEXT_TAG, home: process.env.STIM_HOME }));
      setInterval(() => {}, 1000);
    `,
      );
      let child: ReturnType<typeof spawn> | undefined;
      let closed = false;
      let spawns = 0;
      const previous = getExecutor();
      resetExecutor();
      const launch = bounded ? getExecutor().spawn : spawn;
      setExecutor({ ...previous });
      setExecutor({
        ...getExecutor(),
        spawn(file, _args, options) {
          spawns += 1;
          if (spawns > 1)
            return spawn(
              file,
              ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
              options,
            );
          child = launch(file, [script], options);
          child.once('close', () => {
            closed = true;
          });
          return child;
        },
      });
      const controller = new AbortController();
      const operation: StimContext = {
        home: tmpHome,
        cwd: tmpHome,
        projectRoot: tmpHome,
        buildCache: null,
        runId: 'hosted-cancel',
        env: { ...process.env, STIM_HOME: tmpHome, STIM_TEST_CONTEXT_TAG: 'captured-client' },
        signal: controller.signal,
        output: () => {},
      };
      const reason = new Error('caller cancelled hosted cleanup');
      const devices = collectParkedHostedDevices().devices;
      const work = (scope: StimContext) => {
        const task = deleteParkedHostedDevices(devices, { operation: scope });
        trackReportResource(
          scope,
          task.then(
            () => undefined,
            (error: unknown) => {
              if (error instanceof Error && 'claims' in error) throw error;
              return undefined;
            },
          ),
          () => {},
        );
        return task;
      };
      const deletion = (
        bounded ? runReport(operation, (scope) => withAmbientContext(scope, () => work(scope))) : work(operation)
      ).catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2000 });
        controller.abort(reason);
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 });
        expect(await deletion).toBe(reason);
        expect(JSON.parse(readFileSync(ready, 'utf8'))).toEqual({ tag: 'captured-client', home });
        expect(spawns).toBe(1);
        expect(readClaimSet(join(deviceHostRoot(), `${sessionId}.claims`)).live).toEqual([]);
        expect(readHostedDeviceLedger(join(deviceHostArea(second.id), 'home'))?.ios).toEqual([
          'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC',
        ]);
      } finally {
        controller.abort(reason);
        if (child?.pid && !closed) {
          const done = once(child, 'close');
          process.kill(-child.pid, 'SIGKILL');
          await done;
        }
        await deletion;
      }
    },
  );

  test('an unverifiable new worker receives no native request and no process signal', async () => {
    journal([session()]);
    const home = join(deviceHostArea(sessionId), 'home');
    const script = join(home, 'unverified-worker.mjs');
    const input = join(home, 'input.txt');
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs';
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      writeFileSync(${JSON.stringify(input)}, input);
    `,
    );
    let child: ReturnType<typeof spawn> | undefined;
    let kill: ReturnType<typeof vi.spyOn> | undefined;
    setExecutor({
      ...getExecutor(),
      spawn(file, _args, options) {
        child = spawn(file, [script], options);
        kill = vi.spyOn(child, 'kill');
        return child;
      },
    });
    vi.spyOn(identities, 'captureProcessIdentity').mockReturnValue({ ok: false, reason: 'ACCESS_DENIED' });
    try {
      expect(await deleteParkedHostedDevices(collectParkedHostedDevices().devices)).toBe(1);
      expect(kill).not.toHaveBeenCalled();
      expect(readFileSync(input, 'utf8')).toBe('');
      expect(readClaimSet(join(deviceHostRoot(), `${sessionId}.claims`)).live).toEqual([]);
      expect(takeGcResults()).toMatchObject([
        { status: 'failed', detail: expect.stringContaining('identity unavailable') },
      ]);
    } finally {
      vi.restoreAllMocks();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
  });

  test.skipIf(process.platform === 'win32')(
    'a worker that exits before its identity is read reports its own failure',
    async () => {
      journal([session()]);
      const script = join(deviceHostArea(sessionId), 'home', 'exiting-worker.mjs');
      writeFileSync(script, "process.stderr.write('worker broke\\n');process.exit(6);\n");
      setExecutor({ ...getExecutor(), spawn: (file, _args, options) => spawn(file, [script], options) });
      vi.spyOn(identities, 'captureProcessIdentity').mockImplementation((pid) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        return captureProcessIdentity(pid);
      });
      try {
        expect(await deleteParkedHostedDevices(collectParkedHostedDevices().devices)).toBe(1);
        expect(takeGcResults()).toMatchObject([{ status: 'failed', detail: expect.stringContaining('worker broke') }]);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  test('Android stop preserves the recorded console port and selectors', async () => {
    const android = androidSession();
    journal([android]);
    const requests = worker({ state: 'stopped', device: android.device });
    expect(
      await deleteParkedHostedDevices(collectParkedHostedDevices().devices, {
        listAvds: () => ['stim-hosted-android'],
      }),
    ).toBe(0);
    expect(requests).toEqual([
      {
        home: join(deviceHostArea(android.id), 'home'),
        input: {
          mode: 'stop',
          platform: 'android',
          session: android.id,
          consolePort: 5554,
          systemImage: 'system-images;android-36;google_apis;arm64-v8a',
          deviceProfile: 'pixel_7',
        },
      },
    ]);
    expect(takeGcResults()).toMatchObject([{ status: 'done', id: 'stim-hosted-android' }]);
  });

  test('an Android AVD absent from the caller environment keeps its session ledger without starting a worker', async () => {
    const android = androidSession();
    journal([android]);
    expect(
      await deleteParkedHostedDevices(collectParkedHostedDevices().devices, { listAvds: () => ['another-avd'] }),
    ).toBe(0);
    expect(takeGcResults()).toMatchObject([
      {
        status: 'kept',
        id: 'stim-hosted-android',
        detail: "AVD not visible from this shell's Android environment; run gc with the server's ANDROID_AVD_HOME/HOME",
      },
    ]);
    expect(readHostedDeviceLedger(join(deviceHostArea(android.id), 'home'))?.android).toEqual(['stim-hosted-android']);
  });

  test('an already removed device is reported without actionable work or a delete attempt', async () => {
    journal([session()]);
    writeFileSync(
      join(deviceHostArea(sessionId), 'home', 'created-devices.json'),
      JSON.stringify({ version: 1, ios: [], android: [], web: [] }),
    );
    const before = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    expect(collectParkedHostedDevices().devices[0]).toHaveProperty('listed', false);
    const payload = await gcJson({ pressure: 'normal' });
    expect(payload.actionable).toBe(false);
    expect(payload.results.filter((result) => result.kind === 'parkedHostedDevice')).toEqual([]);
    expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(before);
    expect(await deleteParkedHostedDevices(collectParkedHostedDevices().devices)).toBe(0);
    expect(takeGcResults()).toEqual([]);
  });

  test('an unreadable ledger is listed as unknown and keeps the device on delete', async () => {
    journal([session()]);
    writeFileSync(join(deviceHostArea(sessionId), 'home', 'created-devices.json'), '{');
    const collected = collectParkedHostedDevices();
    expect(collected.devices[0]?.listed).toBeNull();
    expect(collected.notices[0]).toContain('ledger unreadable');
    expect(await deleteParkedHostedDevices(collected.devices)).toBe(0);
    expect(takeGcResults()).toMatchObject([{ status: 'kept' }]);
  });

  test('JSON delete reports the worker outcome and keeps the server journal unchanged', async () => {
    journal([session()]);
    const before = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    const requests = worker({ state: 'stopped', device: session().device });
    const { stdout } = await captureJson(() => cli(['--pressure', 'normal', '--json']));
    expect(stdout).toHaveLength(1);
    const payload = JSON.parse(stdout[0]!);
    expect(payload.mode).toBe('delete');
    expect(payload.failures).toBe(0);
    expect(payload.results.filter((result: { kind: string }) => result.kind === 'parkedHostedDevice')).toMatchObject([
      { status: 'done', detail: expect.stringContaining(sessionId) },
    ]);
    expect(requests).toHaveLength(1);
    expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(before);
  });

  test('a held session claim keeps its device without launching the worker', async () => {
    journal([session()]);
    const claim = tryAcquireClaim({
      root: join(deviceHostRoot(), `${sessionId}.claims`),
      mode: 'exclusive',
      label: 'hosted device session',
    }).acquired;
    expect(claim).toBeDefined();
    try {
      expect(await deleteParkedHostedDevices(collectParkedHostedDevices().devices)).toBe(0);
      expect(takeGcResults()).toMatchObject([{ status: 'kept', detail: expect.stringContaining('claim') }]);
    } finally {
      releaseClaim(claim);
    }
  });

  test('a ledger changed after collection keeps the device', async () => {
    journal([session()]);
    const collected = collectParkedHostedDevices().devices;
    writeFileSync(
      join(deviceHostArea(sessionId), 'home', 'created-devices.json'),
      JSON.stringify({ version: 1, ios: [], android: [], web: [] }),
    );
    expect(await deleteParkedHostedDevices(collected)).toBe(0);
    expect(takeGcResults()).toMatchObject([{ status: 'kept', detail: expect.stringContaining('ledger') }]);
  });

  test('adoption after collection keeps the device', async () => {
    journal([session()]);
    const collected = collectParkedHostedDevices().devices;
    journal([session({ state: 'ready', parked: undefined })]);
    expect(await deleteParkedHostedDevices(collected)).toBe(0);
    expect(takeGcResults()).toMatchObject([{ status: 'kept', detail: expect.stringContaining('no longer') }]);
  });

  test.each([{ state: 'stopped', device: { ...session().device, udid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB' } }])(
    'an unverified worker result fails that device and continues with the next session (%j)',
    async (badResult) => {
      const second = session({
        id: '22222222-2222-2222-2222-222222222222',
        device: { ...(session().device as HostedIosDevice), udid: 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC' },
      });
      journal([session(), second]);
      let runs = 0;
      const firstRequests = worker(badResult, () => {
        runs += 1;
        if (runs === 1) worker({ state: 'stopped', device: second.device });
      });
      expect(await deleteParkedHostedDevices(collectParkedHostedDevices().devices)).toBe(1);
      expect(firstRequests).toHaveLength(1);
      expect(runs).toBe(1);
      expect(takeGcResults()).toMatchObject([
        { status: 'failed', id: udid },
        { status: 'done', id: 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC' },
      ]);
    },
  );

  test('JSON dry run includes the hosted section and leaves the journal and ledger intact', async () => {
    journal([session()]);
    const before = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    const { stdout } = await captureJson(() => cli(['--dry-run', '--pressure', 'normal', '--json']));
    expect(stdout).toHaveLength(1);
    const payload = JSON.parse(stdout[0]!);
    expect(payload.actionable).toBe(true);
    expect(payload.results).toEqual([]);
    expect(payload.sections.parkedHostedDevices).toEqual([
      {
        session: sessionId,
        client: 'client-1',
        platform: 'ios',
        id: udid,
        name: 'stim-hosted',
        parkedAt,
        listed: true,
      },
    ]);
    expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(before);
    expect(readHostedDeviceLedger(join(deviceHostArea(sessionId), 'home'))?.ios).toEqual([udid]);
    const active = session({ state: 'ready', parked: undefined });
    journal([active]);
    const apps = join(deviceHostArea(sessionId), 'apps');
    const blobs = join(deviceHostArea(sessionId), 'blobs');
    mkdirSync(apps);
    mkdirSync(blobs);
    writeFileSync(join(apps, 'current'), 'app');
    writeFileSync(join(blobs, 'content'), 'blob');
    const executor = getExecutor();
    setExecutor({
      ...executor,
      runFileAsync: (file, args, options) =>
        file === 'du' && [apps, blobs].includes(String(args.at(-1)))
          ? Promise.resolve(`4\t${args.at(-1)}`)
          : executor.runFileAsync(file, args, options),
    });
    const usage = await captureJson(() => cli(['--dry-run', '--pressure', 'normal', '--json']));
    const onlyStorage = JSON.parse(usage.stdout[0]!);
    expect(onlyStorage.actionable).toBe(false);
    expect(onlyStorage.sections.hostedAppStorage).toEqual([
      {
        session: sessionId,
        client: active.client,
        platform: 'ios',
        state: 'ready',
        path: deviceHostArea(sessionId),
        appsBytes: 4096,
        blobsBytes: 4096,
        willDelete: false,
        detail: 'reported only',
      },
    ]);
    expect(readFileSync(join(apps, 'current'), 'utf8')).toBe('app');
    expect(readFileSync(join(blobs, 'content'), 'utf8')).toBe('blob');
    const outside = join(tmpHome, 'outside-app-storage');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'outside');
    rmSync(apps, { recursive: true });
    symlinkSync(outside, apps, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await readGcReport({ pressure: 'normal' });
    assert(!('code' in linked) && linked.sections);
    expect(linked.sections.hostedAppStorage).toEqual([]);
    expect(linked.sections.deviceSweepNotices).toContainEqual({
      message: `Hosted app storage ${sessionId} unavailable: Hosted app storage is not an owned directory.`,
    });
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside');
  });
});

describe('the gc log', () => {
  function stageRun() {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    writeLeaseFile({ id: 'UDID-OLD', expiresInMs: -1000 });
    writeLeaseFile({ id: 'UDID-BAD', expiresInMs: -1000 });
    writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' });
    const remove = deviceLease.removeExpiredLeaseAsync;
    vi.spyOn(deviceLease, 'removeExpiredLeaseAsync').mockImplementation(async (entry, signal) => {
      if (entry.id === 'UDID-BAD') throw new Error('permission denied');
      return remove(entry, signal);
    });
    vi.spyOn(ownershipClaim, 'clearFreeClaimSet').mockReturnValue({ status: 'refused', reason: 'builder unresolved' });
  }

  test('a deleting run records each cleared, kept and failed action with the run that did it', async () => {
    stageRun();
    await captureLog(() => sweepingGc({ pressure: 'normal' }));

    const records = readGcLog()
      .filter(isGcLogRecord)
      .filter((r) => r.kind !== 'keep');
    expect(records.map((r) => [r.kind, r.status]).toSorted()).toEqual([
      ['delete-device-lease', 'done'],
      ['delete-device-lease', 'failed'],
      ['forget-stale-records', 'kept'],
    ]);
    expect(records.find((r) => r.status === 'failed')).toMatchObject({
      src: 'gc',
      level: 'error',
      trigger: 'manual',
      options: { level: 'normal', pressure: true },
      detail: 'permission denied',
    });
    expect(records.find((r) => r.kind === 'forget-stale-records')).toMatchObject({ level: 'info' });
    expect(new Set(records.map((r) => r.runId)).size).toBe(1);
  });

  test('a dry run writes no record and creates no log', async () => {
    stageRun();
    await captureLog(() => sweepingGc({ dryRun: true, pressure: 'normal' }));
    expect(existsSync(gcLogFile())).toBe(false);
  });

  test('a deleting run that only keeps things writes no record', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    writeLock({ platform: 'android', key: 'def-debug-sim', pid: IMPOSSIBLE_PID, projectRoot: '/w/dead' });
    vi.spyOn(ownershipClaim, 'clearFreeClaimSet').mockReturnValue({ status: 'refused', reason: 'builder unresolved' });
    await captureLog(() => sweepingGc({ pressure: 'normal' }));
    expect(existsSync(gcLogFile())).toBe(false);
  });

  test('a run started by Stim Desktop is recorded as desktop', async () => {
    stageRun();
    vi.stubEnv('STIM_DESKTOP_APP', '/Applications/Stim.app');
    await captureLog(() => sweepingGc({ pressure: 'normal' }));
    expect(
      new Set(
        readGcLog()
          .filter(isGcLogRecord)
          .map((r) => r.trigger),
      ),
    ).toEqual(new Set(['desktop']));
  });
});
