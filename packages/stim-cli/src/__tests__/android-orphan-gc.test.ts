import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readClaimSet } from '../ownership-claim.ts';
import { writeAvdProcessLock } from './_factories.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc } from '../commands/gc.ts';
import { collectDeviceRecords } from '../commands/gc/records.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import { ensureConfig, getProject, loadConfig, upsertProject } from '../workspace/config.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { listOrphanedAvdDirectories } from '../devices/android.ts';
import { readCreatedDevices, recordCreatedDevice } from '../devices/created-devices.ts';
import { parkSim, readParked } from '../devices/sim-pool.ts';
import { teardownOwnedAvd, teardownParkedAvd } from '../devices/teardown.ts';

const race = vi.hoisted(() => ({ afterRename: null as null | ((from: string, to: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args);
      race.afterRename?.(String(args[0]), String(args[1]));
    },
  };
});

let home: string;
let avdRoot: string;
let saved: Record<string, string | undefined>;
let savedExitCode: typeof process.exitCode;
let listed: string[];
let deleteRegistration: boolean;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-orphan-avds-')));
  avdRoot = join(home, 'avd');
  mkdirSync(avdRoot);
  const keys = [
    'STIM_HOME',
    'HOME',
    'USERPROFILE',
    'AGENT_DEVICE_STATE_DIR',
    'AGENT_DEVICE_IOS_RUNNER_LEASE_DIR',
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'ANDROID_AVD_HOME',
    'ANDROID_SDK_HOME',
    'ANDROID_USER_HOME',
    'ANDROID_EMULATOR_HOME',
  ];
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    STIM_HOME: join(home, 'stim'),
    HOME: home,
    USERPROFILE: home,
    AGENT_DEVICE_STATE_DIR: '',
    AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: '',
    ANDROID_HOME: join(home, 'sdk'),
    ANDROID_SDK_ROOT: join(home, 'sdk'),
    ANDROID_AVD_HOME: avdRoot,
    ANDROID_SDK_HOME: home,
    ANDROID_USER_HOME: join(home, '.android'),
    ANDROID_EMULATOR_HOME: join(home, '.android'),
  });
  savedExitCode = process.exitCode;
  ensureConfig();
  listed = [];
  deleteRegistration = false;
  const real = getExecutor();
  const run = (cmd: string) => {
    if (cmd.includes('emulator -list-avds')) return listed.join('\n');
    if (cmd === 'adb devices') return 'List of devices attached\n';
    if (cmd.includes('delete avd')) {
      if (deleteRegistration) {
        const name = /-n (\S+)/.exec(cmd)![1]!;
        rmSync(join(avdRoot, `${name}.ini`));
        listed = listed.filter((entry) => entry !== name);
      }
      return '';
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };
  setExecutor({
    run,
    runQuiet: () => null,
    runFile(file, args = [], options) {
      if (file === 'adb' || file === 'emulator' || file === 'avdmanager') return run([file, ...args].join(' '));
      if (file === 'du') return real.runFile(file, args, options);
      if (file === 'xcrun') return JSON.stringify({ devices: {}, devicetypes: [] });
      throw new Error(`Unexpected command: ${file}`);
    },
    runFileQuiet: (file) => (file === 'ps' ? '' : null),
  });
});

afterEach(() => {
  race.afterRename = null;
  resetExecutor();
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
  for (const entry of readdirSync(avdRoot)) {
    const blocked = join(avdRoot, entry, 'blocked');
    if (existsSync(blocked)) chmodSync(blocked, 0o700);
  }
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function gcJson(): Promise<{ actions: { kind: string; outcome: string }[]; failures: number }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ pressure: 'normal', json: true });
  return JSON.parse(String(log.mock.lastCall?.[0]));
}

function orphan(name = 'stim-orphan', root = avdRoot): string {
  const directory = join(root, `${name}.avd`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'userdata.img'), Buffer.alloc(8192, 1));
  writeFileSync(join(directory, 'config.ini'), 'disk.dataPartition.size=8589934592\n');
  if (name.startsWith('stim-')) recordCreatedDevice('android', name);
  return directory;
}

function register(name: string, directory: string): void {
  writeFileSync(join(avdRoot, `${name}.ini`), `path=${directory}\n`);
  listed.push(name);
}

test('orphan deletion refuses a directory replaced by a symlink after survey', async () => {
  const directory = orphan();
  const candidate = listOrphanedAvdDirectories()[0]!;
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'mine');
  writeFileSync(join(outside, 'config.ini'), 'disk.dataPartition.size=8589934592\n');
  rmSync(directory, { recursive: true });
  symlinkSync(outside, directory);
  expect((await teardownOwnedAvd('stim-orphan', { del: true, orphanedDirectory: candidate })).status).toBe('failed');
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('mine');
});

test.each(['workspace', 'pool'])(
  'a partial SDK deletion preserves the %s record and its retry removes the leftover data',
  async (owner) => {
    const directory = orphan();
    register('stim-orphan', directory);
    upsertProject(home, { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
    if (owner === 'pool')
      parkSim({
        platform: 'android',
        projectPath: home,
        max: 1,
        record: {
          udid: 'stim-orphan',
          name: 'stim-orphan',
          systemImage: 'image',
          configuration: 'config',
          parkedAt: new Date().toISOString(),
        },
      });
    deleteRegistration = true;
    const teardown = () =>
      owner === 'pool'
        ? teardownParkedAvd('stim-orphan')
        : teardownOwnedAvd('stim-orphan', { del: true, owner: { projectPath: home } });
    expect(await teardown()).toMatchObject({ status: 'failed', reason: expect.stringContaining('data remains') });
    expect(existsSync(directory)).toBe(true);
    const records = () =>
      owner === 'pool'
        ? readParked('android').map((entry) => entry.name)
        : [getProject(home)?.platforms?.android?.avdName];
    expect(records()).toEqual(['stim-orphan']);
    expect((await teardown()).status).toBe('torn-down');
    expect(existsSync(directory)).toBe(false);
    expect(records()).toEqual(owner === 'pool' ? [] : ['stim-orphan']);
  },
);

test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'GC keeps failed removals discoverable, continues to later devices, and reclaims them on retry (POSIX directory permissions; skipped on win32)',
  async () => {
    const blocked = orphan('stim-a-blocked');
    mkdirSync(join(blocked, 'blocked'));
    writeFileSync(join(blocked, 'blocked', 'data'), 'keep until removable');
    chmodSync(join(blocked, 'blocked'), 0);
    const removable = orphan('stim-z-removable');
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    const payload = await gcJson();
    expect(existsSync(removable)).toBe(false);
    const leftovers = listOrphanedAvdDirectories();
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]!.name).toMatch(/^stim-gc-/);
    expect(payload.actions).toContainEqual(
      expect.objectContaining({ kind: 'delete-orphaned-devices', outcome: 'failed' }),
    );
    expect(payload.failures).toBeGreaterThan(0);
    chmodSync(join(leftovers[0]!.directory, 'blocked'), 0o700);
    await gcJson();
    expect(listOrphanedAvdDirectories()).toEqual([]);
    expect([...readCreatedDevices().android]).toEqual([]);
  },
);

test('AVD data this home did not record is listed with a command that removes the directory', async () => {
  const directory = join(avdRoot, 'stim-other-home.avd');
  mkdirSync(directory);
  writeFileSync(join(directory, 'config.ini'), 'disk.dataPartition.size=8589934592\n');
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const report = await collectDeviceRecords(loadConfig(), []);
  expect(report.orphanedDevices).toEqual([]);
  expect(report.unverifiedDevices.map((device) => gcDevices.unverifiedDeviceCommand(device))).toEqual([
    `rm -rf ${JSON.stringify(directory)}`,
  ]);
});

test.each([
  {
    description: 'emulator update metadata',
    name: 'emu-update-last-check.ini',
    contents: '_version.3D35.6.11.0.26coreVersion.3Dqemu2.25202.12.0 = 123\n',
    removed: true,
  },
  {
    description: 'a malformed registration with the same filename',
    name: 'emu-update-last-check.ini',
    contents: 'path=\n',
    removed: false,
  },
  {
    description: 'an unrelated malformed registration',
    name: 'another.ini',
    contents: 'target=android-35\n',
    removed: false,
  },
  {
    description: 'a real registration with the same filename',
    name: 'emu-update-last-check.ini',
    contents: 'path.rel=avd/stim-orphan.avd\n',
    removed: false,
  },
])('parked AVD teardown distinguishes $description', async ({ name, contents, removed }) => {
  const directory = orphan();
  process.env.ANDROID_EMULATOR_HOME = avdRoot;
  writeFileSync(join(avdRoot, name), contents);
  upsertProject(home, { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
  parkSim({
    platform: 'android',
    projectPath: home,
    max: 1,
    record: {
      udid: 'stim-orphan',
      name: 'stim-orphan',
      systemImage: 'image',
      configuration: 'config',
      parkedAt: new Date().toISOString(),
    },
  });

  const outcome = await teardownParkedAvd('stim-orphan');
  expect(outcome.status).toBe(removed ? 'torn-down' : 'failed');
  expect(existsSync(directory)).toBe(!removed);
  expect(readParked('android').map((entry) => entry.name)).toEqual(removed ? [] : ['stim-orphan']);
  expect(readFileSync(join(avdRoot, name), 'utf8')).toBe(contents);
});

test('an unreadable or symlinked orphan prevents stale device records from being cleared', async () => {
  const outside = join(home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(avdRoot, 'stim-linked.avd'));
  upsertProject(home, { platforms: { android: { avdName: 'stim-linked', owned: true } } });
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const report = await collectDeviceRecords(loadConfig(), []);
  expect(report.staleDeviceRecords).toEqual([]);
  expect(report.notices.join('\n')).toContain('Cannot verify AVD data');
});

test('GC reclaims orphan data after pruning its dead workspace reference', async () => {
  const directory = orphan();
  upsertProject(join(home, 'gone'), { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const payload = await gcJson();
  expect(existsSync(directory)).toBe(false);
  expect(payload.failures).toBe(0);
});

test('a relative alias registration in a symlinked root protects its data when the absolute path is stale', async () => {
  const root = join(home, 'real', 'avd');
  const directory = orphan('stim-retained', root);
  const alias = join(home, 'redirected-avds');
  symlinkSync(root, alias);
  process.env.ANDROID_AVD_HOME = alias;
  const candidate = listOrphanedAvdDirectories()[0]!;
  writeFileSync(
    join(root, 'Personal_Phone.ini'),
    `path=${join(home, 'missing.avd')}\npath.rel=avd/stim-retained.avd\n`,
  );
  listed.push('Personal_Phone');
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const report = await collectDeviceRecords(loadConfig(), []);
  expect(report.orphanedDevices).toEqual([]);
  expect((await teardownOwnedAvd('stim-retained', { del: true, orphanedDirectory: candidate })).status).toBe('failed');
  expect(existsSync(join(directory, 'userdata.img'))).toBe(true);
});

test('detachment holds the config lock and deletion cannot remove a new AVD at the original name', async () => {
  const directory = orphan();
  race.afterRename = (from) => {
    if (from !== directory) return;
    expect(readClaimSet(join(process.env.STIM_HOME!, 'config.lock.claims')).live).toHaveLength(1);
    const replacement = orphan();
    register('stim-orphan', replacement);
    upsertProject(home, { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
  };
  expect((await teardownOwnedAvd('stim-orphan', { del: true })).status).toBe('torn-down');
  expect(existsSync(join(directory, 'userdata.img'))).toBe(true);
  expect(existsSync(join(avdRoot, 'stim-orphan.ini'))).toBe(true);
  expect(getProject(home)?.platforms?.android?.avdName).toBe('stim-orphan');
  expect(readdirSync(avdRoot).some((entry) => entry.startsWith('stim-gc-'))).toBe(false);
});

test.each(['registration', 'workspace', 'pool'])(
  'GC refuses an orphan that gained a %s after survey',
  async (reference) => {
    const directory = orphan();
    const candidate = listOrphanedAvdDirectories()[0]!;
    if (reference === 'registration') register('stim-orphan', directory);
    else {
      upsertProject(home, { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
      if (reference === 'pool')
        parkSim({
          platform: 'android',
          projectPath: home,
          max: 1,
          record: {
            udid: 'stim-orphan',
            name: 'stim-orphan',
            systemImage: 'image',
            configuration: 'config',
            parkedAt: new Date().toISOString(),
          },
        });
    }
    expect((await teardownOwnedAvd('stim-orphan', { del: true, orphanedDirectory: candidate })).status).toMatch(
      /failed|skipped/,
    );
    expect(existsSync(directory)).toBe(true);
  },
);

test.each(['live', 'unverifiable'])('orphan deletion refuses a %s emulator process lock', async (state) => {
  const directory = orphan();
  writeAvdProcessLock(directory, state === 'live' ? String(process.pid) : 'not-a-pid');
  expect((await teardownOwnedAvd('stim-orphan', { del: true })).status).toBe('failed');
  expect(existsSync(directory)).toBe(true);
});
