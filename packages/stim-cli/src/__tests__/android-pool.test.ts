import { vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, loadConfig, setDevice, upsertProject } from '../config.ts';
import { ensureOwnedDevice } from '../engine/device.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { adoptParked, parkSim, readParked, removeParkedAfter } from '../sim-pool.ts';
import { avdPoolConfiguration, hostSystemImageArch, resetAdoptedAvd } from '../sim/android.ts';
import { teardownOwnedAvd, teardownParkedAvd } from '../teardown.ts';
import { collectParkedAvds, deleteParkedAvds, findOrphanedDevices } from '../commands/gc/devices.ts';

let home: string;
let saved: Record<string, string | undefined>;
let avds: Set<string>;
let running: string | null;
let calls: string[];
let failDelete: boolean;
let packageOutput: string;
let cleanupResult: string;
const image = `system-images;android-36;google_apis;${hostSystemImageArch()}`;
const configuration = avdPoolConfiguration(8, {});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-android-pool-'));
  saved = Object.fromEntries(
    ['STIM_HOME', 'STIM_POOL_ANDROID_PARKED_MAX', 'ANDROID_HOME', 'ANDROID_AVD_HOME', 'DISPLAY'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.STIM_HOME = home;
  process.env.STIM_POOL_ANDROID_PARKED_MAX = '1';
  process.env.ANDROID_HOME = join(home, 'sdk');
  process.env.ANDROID_AVD_HOME = join(home, 'avd');
  process.env.DISPLAY = ':0';
  mkdirSync(join(home, 'sdk', ...image.split(';')), { recursive: true });
  avds = new Set();
  running = null;
  calls = [];
  failDelete = false;
  packageOutput = 'package:com.example.app\npackage:com.example.other';
  cleanupResult = 'Success';
  const run = (cmd: string): string => {
    calls.push(cmd);
    if (cmd === 'emulator -list-avds') return [...avds].join('\n');
    if (cmd === 'adb devices') return `List of devices attached\n${running ? 'emulator-5554\tdevice\n' : ''}`;
    if (cmd.includes('emu avd name')) return `${running}\nOK`;
    if (cmd.includes('getprop sys.boot_completed')) return '1';
    if (cmd.includes('getprop ')) return '';
    if (cmd.includes('shell sync')) return '';
    if (cmd.includes('emu kill')) {
      running = null;
      return '';
    }
    if (cmd.includes('delete avd')) {
      if (failDelete) throw new Error('AVD deletion failed');
      avds.delete(/-n "([^"]+)"/.exec(cmd)![1]!);
      return '';
    }
    if (cmd.includes('create avd')) {
      makeAvd(/-n "([^"]+)"/.exec(cmd)![1]!);
      return '';
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };
  setExecutor({
    run,
    runQuiet: run,
    runFile(file, args = []) {
      calls.push([file, ...args].join(' '));
      if (args.includes('list')) return packageOutput;
      if (args.includes('clear') || args.includes('uninstall')) return cleanupResult;
      throw new Error(`Unexpected file command: ${file} ${args.join(' ')}`);
    },
    spawn(_file, args = []) {
      running = args[args.indexOf('-avd') + 1]!;
      return { pid: 9999, unref() {} };
    },
  });
});

afterEach(() => {
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeAvd(name: string): void {
  avds.add(name);
  const directory = join(home, 'avd', `${name}.avd`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, 'avd', `${name}.ini`), `path=${directory}\n`);
  writeFileSync(
    join(directory, 'config.ini'),
    `image.sysdir.1=${image.split(';').join('/')}\ndisk.dataPartition.size=8589934592\n`,
  );
}

function park(name = 'stim-source', overrides = {}) {
  makeAvd(name);
  upsertProject('/source', { platforms: { android: { avdName: name, owned: true } } });
  return parkSim({
    platform: 'android',
    projectPath: '/source',
    max: 1,
    record: { udid: name, name, systemImage: image, configuration, parkedAt: new Date().toISOString(), ...overrides },
  });
}

test('a new workspace adopts a compatible stopped AVD and retains cleanup state across a retry', async () => {
  park();
  upsertProject('/adopter', {});
  const options = { platform: 'android', projectPath: '/adopter', label: 'adopter', settings: {} };
  const adopted = await ensureOwnedDevice(options);
  expect(adopted).toMatchObject({
    avdName: 'stim-source',
    adopted: true,
    adoptionPending: true,
    poolConfiguration: configuration,
  });
  expect(readParked('android')).toEqual([]);
  expect(calls.some((call) => call.includes('create avd'))).toBe(false);
  running = null;
  const retried = await ensureOwnedDevice({ ...options, project: getProject('/adopter') });
  expect(retried.adoptionPending).toBe(true);
  expect(getProject('/adopter')?.platforms?.android?.adoptionPending).toBe(true);
});

test.each([
  { systemImage: image.replace('android-36', 'android-35') },
  { configuration: avdPoolConfiguration(10, {}) },
  { configuration: avdPoolConfiguration(8, { 'hw.ramSize': '4096' }) },
])('an incompatible parked AVD stays parked and its name cannot be recovered by creation: %j', async (overrides) => {
  park('stim-source', overrides);
  upsertProject('/adopter', {});
  const result = await ensureOwnedDevice({
    platform: 'android',
    projectPath: '/adopter',
    label: 'source',
    settings: {},
  });
  expect(result.created).toBe(true);
  expect(result.avdName).not.toBe('stim-source');
  expect(readParked('android').map((record) => record.name)).toEqual(['stim-source']);
});

test('a missing parked AVD loses only its pool record before a fresh device is created', async () => {
  park();
  avds.clear();
  upsertProject('/adopter', {});
  const result = await ensureOwnedDevice({ platform: 'android', projectPath: '/adopter', label: 'new', settings: {} });
  expect(result.created).toBe(true);
  expect(readParked('android')).toEqual([]);
  expect(calls.some((call) => call.includes('delete avd'))).toBe(false);
});

test('an emulator with a live process but no adb connection stays parked', async () => {
  park();
  writeFileSync(join(home, 'avd', 'stim-source.avd', 'hardware-qemu.ini.lock'), String(process.pid));
  upsertProject('/adopter', {});
  const result = await ensureOwnedDevice({ platform: 'android', projectPath: '/adopter', label: 'new', settings: {} });
  expect(result.created).toBe(true);
  expect(readParked('android').map((record) => record.name)).toEqual(['stim-source']);
  expect(calls.some((call) => call.includes('delete avd'))).toBe(false);
});

test('a concurrent adoption cannot be overwritten by a new AVD creation using an older workspace record', async () => {
  park();
  upsertProject('/adopter', {});
  const previous = getProject('/adopter');
  expect(
    adoptParked({
      platform: 'android',
      projectPath: '/adopter',
      udid: 'stim-source',
      device: { avdName: 'stim-source', owned: true, adoptionPending: true },
    }),
  ).not.toBeNull();
  await expect(
    ensureOwnedDevice({ platform: 'android', projectPath: '/adopter', project: previous, label: 'new', settings: {} }),
  ).rejects.toThrow('Another Stim run assigned AVD');
  expect(getProject('/adopter')?.platforms?.android?.avdName).toBe('stim-source');
  expect(calls.some((call) => call.includes('create avd'))).toBe(false);
});

test('an AVD parked between failed creation and recovery cannot bypass adoption', async () => {
  upsertProject('/adopter', {});
  const previous = getExecutor();
  let creationFailed = false;
  setExecutor({
    ...previous,
    run(cmd) {
      if (cmd.includes('create avd')) {
        creationFailed = true;
        throw new Error('AVD stim-source already exists');
      }
      if (cmd === 'emulator -list-avds' && creationFailed) {
        creationFailed = false;
        park();
      }
      return previous.run(cmd);
    },
  });
  await expect(
    ensureOwnedDevice({ platform: 'android', projectPath: '/adopter', label: 'source', settings: {} }),
  ).rejects.toThrow('was parked by another Stim run');
  expect(getProject('/adopter')?.platforms?.android).toBeUndefined();
  expect(readParked('android').map((record) => record.name)).toEqual(['stim-source']);
  expect(running).toBeNull();
});

test('parking shuts down an owned AVD and overflow deletion failures keep both ownership records', () => {
  park('stim-old');
  makeAvd('stim-new');
  setDevice('/source', 'android', { avdName: 'stim-new', owned: true });
  running = 'stim-new';
  failDelete = true;
  const result = teardownOwnedAvd('stim-new', {
    del: true,
    park: { projectPath: '/source', max: 1, configuration },
    waitForShutdown: (_name, shutdown) => shutdown(1000),
  });
  expect(result.parked?.name).toBe('stim-new');
  expect(result.evictionFailures).toEqual([expect.stringContaining('AVD deletion failed')]);
  expect(getProject('/source')?.platforms?.android).toBeUndefined();
  expect(readParked('android')).toHaveLength(2);
  expect(running).toBeNull();
  failDelete = false;
  expect(teardownParkedAvd('stim-old').status).toBe('torn-down');
  expect(readParked('android').map((record) => record.name)).toEqual(['stim-new']);
});

test('pool deletion excludes adoption and an adopted emulator cannot be deleted by a stale GC report', () => {
  park();
  upsertProject('/adopter', {});
  const request = {
    platform: 'android' as const,
    projectPath: '/adopter',
    udid: 'stim-source',
    device: { avdName: 'stim-source', owned: true },
  };
  expect(() =>
    removeParkedAfter('android', 'stim-source', () => {
      expect(adoptParked(request)).toBeNull();
      throw new Error('retain for retry');
    }),
  ).toThrow('retain for retry');
  const report = collectParkedAvds({ directorySize: () => 1024 });
  expect(adoptParked(request)?.name).toBe('stim-source');
  expect(deleteParkedAvds(report)).toBe(0);
  expect(avds.has('stim-source')).toBe(true);
});

test('GC protects parked emulators from the orphan sweep and keeps an unverifiable listing', () => {
  park();
  expect(findOrphanedDevices({ config: loadConfig(), avds: ['stim-source'] })).toMatchObject({
    orphaned: [],
    kept: [{ reason: 'referenced by the emulator pool' }],
  });
  const report = collectParkedAvds({
    listAvds: () => {
      throw new Error('SDK unavailable');
    },
    directorySize: () => 1024,
  });
  expect(report[0]?.listed).toBeNull();
  expect(deleteParkedAvds(report)).toBe(1);
  expect(readParked('android')).toHaveLength(1);
});

test('adoption clears the retained app and uninstalls other third-party apps, with a failed clear refusing reuse', async () => {
  makeAvd('stim-source');
  running = 'stim-source';
  await resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app');
  expect(calls).toContain('adb -s emulator-5554 shell pm clear com.example.app');
  expect(calls).toContain('adb -s emulator-5554 uninstall com.example.other');
  expect(calls).not.toContain('adb -s emulator-5554 uninstall com.example.app');
  expect(calls.some((cmd) => cmd.includes('getprop '))).toBe(false);
  cleanupResult = 'Failed';
  await expect(resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app')).rejects.toThrow('Could not clean');
  packageOutput = 'Error: package manager unavailable';
  await expect(resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app')).rejects.toThrow(
    'Could not read installed apps',
  );
});

test('an AVD whose configured disk size changed is evicted rather than adopted', async () => {
  park();
  const config = join(home, 'avd', 'stim-source.avd', 'config.ini');
  writeFileSync(config, readFileSync(config, 'utf8').replace('8589934592', '10737418240'));
  upsertProject('/adopter', {});
  const result = await ensureOwnedDevice({ platform: 'android', projectPath: '/adopter', label: 'new', settings: {} });
  expect(result.created).toBe(true);
  expect(avds.has('stim-source')).toBe(false);
  expect(readParked('android')).toEqual([]);
});

describe('adoption transport recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    makeAvd('stim-source');
    running = 'stim-source';
  });
  afterEach(() => vi.useRealTimers());

  test.each(['list', 'clear', 'uninstall'])(
    're-lists packages after a transient %s failure and waits only on failure',
    async (operation) => {
      const exec = getExecutor();
      let failed = false;
      setExecutor({
        ...exec,
        runFile(file, args = [], options) {
          if (!failed && args.includes(operation)) {
            failed = true;
            if (operation === 'uninstall') packageOutput = 'package:com.example.app';
            throw Object.assign(new Error('adb command failed'), { stderr: 'error: closed' });
          }
          return exec.runFile(file, args, options);
        },
      });
      const cleanup = resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app');
      await vi.runAllTimersAsync();
      await cleanup;
      expect(failed).toBe(true);
      expect(calls).toContain('adb -s emulator-5554 shell pm clear com.example.app');
      expect(calls.some((cmd) => cmd.includes('getprop sys.boot_completed'))).toBe(true);
      expect(calls.includes('adb -s emulator-5554 uninstall com.example.other')).toBe(operation !== 'uninstall');
    },
  );

  test('stops before destructive retry when another AVD takes the serial', async () => {
    const exec = getExecutor();
    setExecutor({
      ...exec,
      runFile() {
        running = 'stim-replacement';
        throw Object.assign(new Error('adb command failed'), { stderr: 'adb: device offline' });
      },
    });
    const cleanup = resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app');
    await Promise.all([expect(cleanup).rejects.toThrow('no longer running'), vi.runAllTimersAsync()]);
    expect(calls.some((cmd) => cmd.includes('pm clear') || cmd.includes('uninstall'))).toBe(false);
  });

  test('retries an unavailable identity without touching the device until its identity returns', async () => {
    const exec = getExecutor();
    let names = 0;
    setExecutor({
      ...exec,
      runQuiet(cmd, options) {
        if (cmd.includes('emu avd name') && names++ === 0) return null;
        return exec.runQuiet(cmd, options);
      },
    });
    const cleanup = resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app');
    expect(calls.some((cmd) => cmd.includes('pm clear'))).toBe(false);
    await vi.runAllTimersAsync();
    await cleanup;
    expect(calls).toContain('adb -s emulator-5554 shell pm clear com.example.app');
  });

  test.each(['adb: device offline', 'error: closed'])(
    'bounds repeated %s failures and retains child diagnostics',
    async (stderr) => {
      const exec = getExecutor();
      let attempts = 0;
      setExecutor({
        ...exec,
        runFile() {
          attempts++;
          throw Object.assign(new Error('adb command failed'), { stderr });
        },
      });
      const cleanup = resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app');
      await Promise.all([expect(cleanup).rejects.toThrow(stderr), vi.runAllTimersAsync()]);
      expect(attempts).toBeGreaterThan(1);
      expect(attempts).toBeLessThanOrEqual(31);
    },
  );

  test('reports an unrelated command failure without waiting or retrying', async () => {
    const exec = getExecutor();
    setExecutor({
      ...exec,
      runFile() {
        throw Object.assign(new Error('adb command failed'), { stdout: 'SecurityException: permission denied' });
      },
    });
    await expect(resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app')).rejects.toThrow(
      'SecurityException: permission denied',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

test('adoption recovery gives ownership and readiness probes the remaining timeout budget', async () => {
  vi.useFakeTimers();
  try {
    makeAvd('stim-source');
    running = 'stim-source';
    const exec = getExecutor();
    const timeouts: number[] = [];
    let failed = false;
    setExecutor({
      ...exec,
      run(cmd, options) {
        expect(options?.timeoutMs).toBeGreaterThan(0);
        timeouts.push(options!.timeoutMs!);
        return exec.run(cmd, options);
      },
      runQuiet(cmd, options) {
        expect(options?.timeoutMs).toBeGreaterThan(0);
        timeouts.push(options!.timeoutMs!);
        return exec.runQuiet(cmd, options);
      },
      runFile(file, args, options) {
        expect(options?.timeoutMs).toBeGreaterThan(0);
        if (!failed) {
          failed = true;
          throw new Error('error: closed');
        }
        expect(options!.timeoutMs!).toBeLessThan(30000);
        return exec.runFile(file, args, options);
      },
    });
    const cleanup = resetAdoptedAvd('stim-source', 'emulator-5554', 'com.example.app');
    await vi.runAllTimersAsync();
    await cleanup;
    expect(timeouts.every((value) => value <= 30000)).toBe(true);
    expect(timeouts.at(-1)).toBeLessThan(30000);
  } finally {
    vi.useRealTimers();
  }
});
