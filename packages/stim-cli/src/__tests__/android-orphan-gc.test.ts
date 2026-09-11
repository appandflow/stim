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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGcReport, runGc } from '../commands/gc.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import { ensureConfig, getProject, upsertProject } from '../config.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { listOrphanedAvdDirectories } from '../sim/android.ts';
import { parkSim, readParked } from '../sim-pool.ts';
import { teardownOwnedAvd, teardownParkedAvd } from '../teardown.ts';

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
const deps = {
  findProjectRoot: () => null,
  precollectedEasSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-orphan-avds-')));
  avdRoot = join(home, 'avd');
  mkdirSync(avdRoot);
  const keys = [
    'STIM_HOME',
    'HOME',
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
        const name = /-n "([^"]+)"/.exec(cmd)![1]!;
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
    runFile(file, args, options) {
      if (file === 'du') return real.runFile(file, args, options);
      if (file === 'xcrun') return JSON.stringify({ devices: {}, devicetypes: [] });
      throw new Error(`Unexpected command: ${file}`);
    },
    runFileQuiet: () => null,
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

function orphan(name = 'stim-orphan', root = avdRoot): string {
  const directory = join(root, `${name}.avd`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'userdata.img'), Buffer.alloc(8192, 1));
  return directory;
}

function register(name: string, directory: string): void {
  writeFileSync(join(avdRoot, `${name}.ini`), `path=${directory}\n`);
  listed.push(name);
}

test('GC reports and sizes unreferenced owned data even when the emulator listing is empty', async () => {
  const directory = orphan();
  orphan('Personal_Phone');
  const retained = orphan('stim-retained');
  upsertProject(home, { platforms: { android: { avdName: 'stim-retained', owned: true } } });

  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const report = await collectGcReport({}, deps);

  expect(report.orphanedDevices).toEqual([
    expect.objectContaining({
      name: 'stim-orphan',
      bytes: expect.any(Number),
      orphanedDirectory: expect.objectContaining({ directory }),
    }),
  ]);
  expect(report.orphanedDevices[0]!.bytes).toBeGreaterThan(0);
  expect(report.staleDeviceRecords).toEqual([]);
  expect(existsSync(directory)).toBe(true);
  expect(existsSync(retained)).toBe(true);
});

test('orphan sizing uses the bounded size path and tolerates its failure', async () => {
  orphan();
  const size = vi.fn<typeof import('../fs-util.ts').directorySize>(() => {
    throw new Error('unreadable');
  });
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const report = await collectGcReport({}, { ...deps, directorySize: size });
  expect(size).toHaveBeenCalledWith(join(avdRoot, 'stim-orphan.avd'), { timeoutMs: 5000 });
  expect(report.orphanedDevices).toEqual([expect.objectContaining({ name: 'stim-orphan' })]);
  expect(report.orphanedDevices[0]!.bytes).toBeUndefined();
});

test.each(['scoped', 'no-config'])('orphan discovery preserves the %s GC sweep guard', async (guard) => {
  const directory = orphan();
  if (guard === 'no-config') rmSync(join(process.env.STIM_HOME!, 'config.json'));
  const report = await collectGcReport({}, deps);
  expect(report.orphanedDevices).toEqual([]);
  expect(existsSync(directory)).toBe(true);
});

test('stop keeps unregistered data and delete refuses user-created names', () => {
  const directory = orphan();
  const personal = orphan('Personal_Phone');
  expect(teardownOwnedAvd('stim-orphan').status).toBe('skipped');
  expect(teardownOwnedAvd('Personal_Phone', { del: true }).kind).toBe('not-owned');
  expect(existsSync(directory)).toBe(true);
  expect(existsSync(personal)).toBe(true);
});

test.each(['live', 'unverifiable'])('orphan deletion refuses a %s emulator process lock', (state) => {
  const directory = orphan();
  writeFileSync(join(directory, 'hardware-qemu.ini.lock'), state === 'live' ? String(process.pid) : 'not-a-pid');
  expect(teardownOwnedAvd('stim-orphan', { del: true }).status).toBe('failed');
  expect(existsSync(directory)).toBe(true);
});

test('orphan deletion refuses a directory replaced by a symlink after survey', () => {
  const directory = orphan();
  const candidate = listOrphanedAvdDirectories()[0]!;
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'mine');
  rmSync(directory, { recursive: true });
  symlinkSync(outside, directory);
  expect(teardownOwnedAvd('stim-orphan', { del: true, orphanedDirectory: candidate }).status).toBe('failed');
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('mine');
});

test.each(['registration', 'workspace', 'pool'])('GC refuses an orphan that gained a %s after survey', (reference) => {
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
  expect(teardownOwnedAvd('stim-orphan', { del: true, orphanedDirectory: candidate }).status).toMatch(/failed|skipped/);
  expect(existsSync(directory)).toBe(true);
});

test('detachment holds the config lock and deletion cannot remove a new AVD at the original name', () => {
  const directory = orphan();
  race.afterRename = (from) => {
    if (from !== directory) return;
    expect(existsSync(join(process.env.STIM_HOME!, 'config.lock'))).toBe(true);
    const replacement = orphan();
    register('stim-orphan', replacement);
    upsertProject(home, { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
  };
  expect(teardownOwnedAvd('stim-orphan', { del: true }).status).toBe('torn-down');
  expect(existsSync(join(directory, 'userdata.img'))).toBe(true);
  expect(existsSync(join(avdRoot, 'stim-orphan.ini'))).toBe(true);
  expect(getProject(home)?.platforms?.android?.avdName).toBe('stim-orphan');
  expect(readdirSync(avdRoot).some((entry) => entry.startsWith('stim-gc-'))).toBe(false);
});

test.each(['workspace', 'pool'])(
  'a partial SDK deletion preserves the %s record and its retry removes the leftover data',
  (owner) => {
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
    expect(teardown()).toMatchObject({ status: 'failed', reason: expect.stringContaining('data remains') });
    expect(existsSync(directory)).toBe(true);
    const records = () =>
      owner === 'pool'
        ? readParked('android').map((entry) => entry.name)
        : [getProject(home)?.platforms?.android?.avdName];
    expect(records()).toEqual(['stim-orphan']);
    expect(teardown().status).toBe('torn-down');
    expect(existsSync(directory)).toBe(false);
    expect(records()).toEqual(owner === 'pool' ? [] : ['stim-orphan']);
  },
);

test.skipIf(process.getuid?.() === 0)(
  'GC keeps failed removals discoverable, continues to later devices, and reclaims them on retry',
  async () => {
    const blocked = orphan('stim-a-blocked');
    mkdirSync(join(blocked, 'blocked'));
    writeFileSync(join(blocked, 'blocked', 'data'), 'keep until removable');
    chmodSync(join(blocked, 'blocked'), 0);
    const removable = orphan('stim-z-removable');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    await runGc({ delete: true }, deps);
    expect(existsSync(removable)).toBe(false);
    const leftovers = listOrphanedAvdDirectories();
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]!.name).toMatch(/^stim-gc-/);
    expect(log.mock.calls.flat().join('\n')).toContain('Failed to delete android device stim-a-blocked');
    chmodSync(join(leftovers[0]!.directory, 'blocked'), 0o700);
    await runGc({ delete: true }, deps);
    expect(listOrphanedAvdDirectories()).toEqual([]);
  },
);

test('an unreadable or symlinked orphan prevents stale device records from being cleared', async () => {
  const outside = join(home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(avdRoot, 'stim-linked.avd'));
  upsertProject(home, { platforms: { android: { avdName: 'stim-linked', owned: true } } });
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  const report = await collectGcReport({}, deps);
  expect(report.staleDeviceRecords).toEqual([]);
  expect(report.deviceSweepNotices.join('\n')).toContain('Cannot verify AVD data');
});

test('GC reclaims orphan data after pruning its dead workspace reference', async () => {
  const directory = orphan();
  upsertProject(join(home, 'gone'), { platforms: { android: { avdName: 'stim-orphan', owned: true } } });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
  await runGc({ delete: true }, deps);
  expect(existsSync(directory)).toBe(false);
  expect(log.mock.calls.flat().join('\n')).not.toContain('Failed to delete');
});

test.each(['absolute', 'relative', 'symlink'])(
  'an alias-named registration protects its canonical %s data target during survey and deletion',
  async (target) => {
    const directory = orphan();
    const candidate = listOrphanedAvdDirectories()[0]!;
    let registration = `path=${directory}\n`;
    if (target === 'relative') registration = 'path.rel=avd/stim-orphan.avd\n';
    if (target === 'symlink') {
      const alias = join(home, 'data-alias');
      symlinkSync(directory, alias);
      registration = `path=${alias}\n`;
    }
    writeFileSync(join(avdRoot, 'Personal_Phone.ini'), registration);
    listed.push('Personal_Phone');
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    const report = await collectGcReport({}, deps);
    expect(report.orphanedDevices).toEqual([]);
    expect(teardownOwnedAvd('stim-orphan', { del: true, orphanedDirectory: candidate }).status).toBe('failed');
    expect(readFileSync(join(directory, 'userdata.img')).length).toBe(8192);
  },
);

describe.skipIf(process.getuid?.() === 0)('unverifiable registrations', () => {
  test.each(['unreadable', 'malformed'])('an %s registration keeps unverified orphan data', async (failure) => {
    const directory = orphan();
    const registration = join(avdRoot, 'Personal_Phone.ini');
    writeFileSync(registration, failure === 'malformed' ? 'avd.ini.encoding=UTF-8\n' : `path=${directory}\n`);
    if (failure === 'unreadable') chmodSync(registration, 0);
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    const report = await collectGcReport({}, deps);
    expect(report.orphanedDevices).toEqual([]);
    expect(report.deviceSweepNotices.join('\n')).toContain('android data sweep skipped');
    expect(teardownOwnedAvd('stim-orphan', { del: true }).status).toBe('failed');
    expect(existsSync(directory)).toBe(true);
  });
});

test.each(['ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_SDK_HOME'])(
  'a user alias in %s protects data in another AVD root',
  async (variable) => {
    const directory = orphan();
    const candidate = listOrphanedAvdDirectories()[0]!;
    process.env[variable] = join(home, variable.toLowerCase());
    const root =
      variable === 'ANDROID_SDK_HOME'
        ? join(process.env[variable]!, '.android', 'avd')
        : join(process.env[variable]!, 'avd');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'Personal_Phone.ini'), `path=${directory}\n`);
    listed.push('Personal_Phone');
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    const report = await collectGcReport({}, deps);
    expect(report.orphanedDevices).toEqual([]);
    expect(teardownOwnedAvd('stim-orphan', { del: true, orphanedDirectory: candidate }).status).toBe('failed');
    expect(existsSync(join(directory, 'userdata.img'))).toBe(true);
  },
);

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
  const report = await collectGcReport({}, deps);
  expect(report.orphanedDevices).toEqual([]);
  expect(teardownOwnedAvd('stim-retained', { del: true, orphanedDirectory: candidate }).status).toBe('failed');
  expect(existsSync(join(directory, 'userdata.img'))).toBe(true);
});
