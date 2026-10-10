import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { runHostedAndroidDevice } from '../device-host/android.ts';
import { loadConfig, saveConfig, withConfigLock } from '../workspace/config.ts';
import { getExecutor, type Executor } from '../exec.ts';
import type { BootResult } from '../devices/android.ts';

const native = vi.hoisted(() => ({
  create: vi.fn<(_label: string, options: { spawn: Executor['spawn'] }) => Promise<void>>(),
  boot: vi.fn<(...args: unknown[]) => void>(),
  wait: vi.fn<() => Promise<BootResult>>(),
  teardown: vi.fn<(target: string, options: { del?: boolean }) => { status: string; reason?: string }>(),
  avds: vi.fn<() => string[]>(),
  name: vi.fn<() => string | null>(),
  abi: vi.fn<() => string | null>(),
  adb: vi.fn<
    () => { emulators: { consolePort: number; serial?: string }[]; unhealthy: { consolePort: number | null }[] }
  >(),
  stopped: vi.fn<() => void>(),
  reset: vi.fn<(_avd: string, _serial: string, keep: string) => Promise<void>>(),
  image: vi.fn<() => string | null>(),
  resolved: vi.fn<() => { notRunning?: true; missing?: true; notOwned?: true; serial?: string }>(),
  pressure: vi.fn<() => string | null>(),
}));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => native.pressure() }));
vi.mock('../devices/android.ts', () => ({
  DEFAULT_AVD_DEVICE_PROFILE: 'pixel_6',
  hostSystemImageArch: () => 'arm64-v8a',
  listInstalledSystemImages: () =>
    [30, 31].map((api) => ({ pkg: `system-images;android-${api};google_apis;arm64-v8a`, arch: 'arm64-v8a' })),
  pickDefaultSystemImage: (images: { pkg: string }[], request: { systemImage?: string }) =>
    images.find((image) => !request.systemImage || image.pkg === request.systemImage),
  listAvdDeviceProfiles: () => ['pixel_6', 'pixel_7'],
  listAvds: () => native.avds(),
  ownedAvdName: (label: string) => `stim-${label}`,
  listAdbDevices: () => native.adb(),
  createOwnedAvd: (label: string, options: { spawn: Executor['spawn'] }) => native.create(label, options),
  bootAndroidEmulator: (...args: unknown[]) => native.boot(...args),
  waitForBoot: () => native.wait(),
  getAvdNameForSerial: () => native.name(),
  androidDeviceAbi: () => native.abi(),
  avdStorageRoots: () => [home],
  assertOwnedAvdStopped: () => native.stopped(),
  ownedAvdSystemImage: () => native.image(),
  resolveOwnedAvdSerial: () => native.resolved(),
  resetAdoptedAvd: (avd: string, serial: string, keep: string) => native.reset(avd, serial, keep),
  avdPathExists: (path: string) => existsSync(path),
}));
vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedAvd: (...args: Parameters<typeof native.teardown>) => native.teardown(...args),
}));

let home: string;
let area: string;
const session = '12345678-1234-1234-1234-123456789abc';
const avd = `stim-hosted-${session}`;
const request = { session, consolePort: 5554 };
beforeEach(() => {
  vi.resetAllMocks();
  area = mkdtempSync(join(tmpdir(), 'stim-hosted-android-'));
  home = join(area, 'home');
  mkdirSync(home);
  process.env.STIM_HOME = home;
  native.pressure.mockReturnValue('normal');
  native.wait.mockResolvedValue({ ok: true });
  native.image.mockReturnValue('system-images;android-30;google_apis;arm64-v8a');
  native.resolved.mockReturnValue({ notRunning: true });
  native.adb.mockReturnValue({ emulators: [], unhealthy: [] });
  native.avds.mockReturnValue([]);
  native.name.mockReturnValue(avd);
  native.abi.mockReturnValue('arm64-v8a');
  native.create.mockImplementation(async (_label: string, options: { spawn: Executor['spawn'] }) => {
    recordCreatedDevice('android', avd);
    native.avds.mockReturnValue([avd]);
    const child = options.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  });
  native.teardown.mockImplementation(() => {
    native.name.mockReturnValue(null);
    native.avds.mockReturnValue([]);
    forgetCreatedDevice('android', avd);
    return { status: 'torn-down' };
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(area, { recursive: true, force: true });
});

test('persists exact ownership before a viewer-free boot and stops only that AVD', async () => {
  native.boot.mockImplementation(() => {
    expect(JSON.parse(readFileSync(join(home, 'hosted-device.json'), 'utf8'))).toMatchObject({
      avdName: avd,
      serial: 'emulator-5554',
    });
    expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).android).toEqual([avd]);
  });
  expect(await runHostedAndroidDevice('prepare', request)).toMatchObject({
    state: 'ready',
    device: { avdName: avd, architecture: 'arm64-v8a' },
  });
  expect(native.boot).toHaveBeenCalledWith(avd, 5554, expect.objectContaining({ openViewer: false }));
  expect(await runHostedAndroidDevice('prepare', request)).toMatchObject({ state: 'unknown' });
  expect(native.create).toHaveBeenCalledTimes(1);
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'stopped', device: { avdName: avd } });
  expect(native.teardown).toHaveBeenCalledExactlyOnceWith(avd, { del: true });
});

test('an occupied console port refuses before any native creation', async () => {
  native.adb.mockReturnValue({ emulators: [{ consolePort: 5554, serial: 'emulator-5554' }], unhealthy: [] });
  expect(await runHostedAndroidDevice('prepare', request)).toMatchObject({ state: 'stopped', device: null });
  expect(native.create).not.toHaveBeenCalled();
  expect(native.boot).not.toHaveBeenCalled();
});

test.each(['name', 'abi'] as const)(
  'a successful boot with the wrong %s retains its device and refuses ready',
  async (property) => {
    native[property].mockReturnValue('foreign');
    expect(await runHostedAndroidDevice('prepare', request)).toMatchObject({
      state: 'unknown',
      device: { avdName: avd },
    });
  },
);

test.each(['prepare', 'adopt'] as const)('a failed %s boot retains its observations and owned device', async (mode) => {
  if (mode === 'adopt') await parkedEmulator();
  native.teardown.mockClear();
  const diagnostic = {
    devices: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\nother-physical-device\tdevice',
    sysBoot: '1',
    devBoot: '',
    bootAnim: 'running',
    packageManager: '',
  };
  native.wait.mockResolvedValue({ ok: false, diagnostic });
  const result = await runHostedAndroidDevice(mode, request);
  expect(result).toMatchObject({
    state: 'unknown',
    device: { avdName: avd, serial: 'emulator-5554' },
    notice: expect.stringContaining(
      JSON.stringify({ sysBoot: '1', devBoot: '', bootAnim: 'running', packageManager: '' }),
    ),
  });
  expect(result.notice).not.toContain('emulator-5556');
  expect(result.notice).not.toContain('other-physical-device');
  expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).android).toEqual([avd]);
  expect(native.reset).not.toHaveBeenCalled();
  expect(native.teardown).not.toHaveBeenCalled();
});

test('foreign ledger ownership refuses teardown and retains the exact record', async () => {
  await runHostedAndroidDevice('prepare', request);
  writeFileSync(
    join(home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: [], android: ['foreign'], web: [] }),
  );
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'unknown', device: { avdName: avd } });
  expect(native.teardown).not.toHaveBeenCalled();
});

test('AVD creation remains in the worker process group', { skip: process.platform === 'win32' }, async () => {
  const groupFile = join(home, 'manager-group');
  const script = `const {execFileSync}=require('node:child_process'); require('node:fs').writeFileSync(process.argv[1],execFileSync('ps',['-o','pgid=','-p',String(process.pid)]));`;
  native.create.mockImplementation(async (_label: string, options: { spawn: Executor['spawn'] }) => {
    recordCreatedDevice('android', avd);
    const child = options.spawn(process.execPath, ['-e', script, groupFile], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  });
  expect(await runHostedAndroidDevice('prepare', request)).toMatchObject({ state: 'ready' });
  const workerGroup = getExecutor()
    .runFile('ps', ['-o', 'pgid=', '-p', String(process.pid)], { timeoutMs: 60_000 })
    .trim();
  expect(readFileSync(groupFile, 'utf8').trim()).toBe(workerGroup);
});

test.each(['absent', 'existing'])(
  'stop can delete in a private home with an %s config without replacing existing settings',
  async (config) => {
    await runHostedAndroidDevice('prepare', request);
    if (config === 'existing')
      withConfigLock(() => saveConfig({ version: 2, projects: {}, repos: {}, concurrency: { maxDevices: 7 } }));
    const before = config === 'existing' ? readFileSync(join(home, 'config.json'), 'utf8') : null;
    native.teardown.mockImplementation(() => {
      expect(loadConfig()).toMatchObject({ version: 2, projects: {}, repos: {} });
      native.avds.mockReturnValue([]);
      native.name.mockReturnValue(null);
      forgetCreatedDevice('android', avd);
      return { status: 'torn-down' };
    });
    expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'stopped' });
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(
      before ?? JSON.stringify({ version: 2, projects: {}, repos: {} }, null, 2) + '\n',
    );
  },
);

test('a deleted AVD with an empty ledger completes stop after a lost reply', async () => {
  await runHostedAndroidDevice('prepare', request);
  await runHostedAndroidDevice('stop', request);
  native.teardown.mockClear();
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'stopped', device: { avdName: avd } });
  expect(native.teardown).not.toHaveBeenCalled();
});

test.each(['AVD', 'emulator'])('an empty ledger refuses a remaining %s without deleting it', async (remaining) => {
  await runHostedAndroidDevice('prepare', request);
  forgetCreatedDevice('android', avd);
  native.avds.mockReturnValue(remaining === 'AVD' ? [avd] : []);
  native.name.mockReturnValue(remaining === 'emulator' ? avd : null);
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({
    state: 'unknown',
    device: { avdName: avd },
    notice: expect.any(String),
  });
  expect(native.teardown).not.toHaveBeenCalled();
  expect(loadConfig()).toBeNull();
});

test.each(['AVD', 'emulator'])('teardown success cannot report stopped while the %s remains', async (remaining) => {
  await runHostedAndroidDevice('prepare', request);
  native.teardown.mockImplementation(() => {
    native.avds.mockReturnValue(remaining === 'AVD' ? [avd] : []);
    native.name.mockReturnValue(remaining === 'emulator' ? avd : null);
    return { status: 'torn-down' };
  });
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'unknown', device: { avdName: avd } });
});

test('an empty ledger refuses to report stopped while the AVD data remains on disk', async () => {
  await runHostedAndroidDevice('prepare', request);
  forgetCreatedDevice('android', avd);
  native.avds.mockReturnValue([]);
  native.name.mockReturnValue(null);
  mkdirSync(join(home, `${avd}.avd`));
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'unknown' });
  expect(native.teardown).not.toHaveBeenCalled();
});

test('stop removes session blobs and materialized apps while retaining receipts and native logs', async () => {
  await runHostedAndroidDevice('prepare', request);
  const blobs = join(area, 'blobs');
  const bundle = join(area, 'apps', 'first', 'App.apk');
  const temporary = `${bundle}.tmp`;
  const legacy = join(area, 'apps', 'first', 'blobs');
  for (const path of [blobs, legacy, join(home, 'ios-logs')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(blobs, 'digest'), 'app bytes');
  writeFileSync(bundle, 'installed bytes');
  writeFileSync(temporary, 'unfinished bytes');
  writeFileSync(join(area, 'apps', 'first', 'receipt.json'), '{}');
  writeFileSync(join(home, 'ios-logs', 'device.ndjson'), 'native logs');
  expect(await runHostedAndroidDevice('stop', request)).toMatchObject({ state: 'stopped' });
  expect([blobs, bundle, temporary, legacy].map(existsSync)).toEqual([false, false, false, false]);
  expect(readFileSync(join(area, 'apps', 'first', 'receipt.json'), 'utf8')).toBe('{}');
  expect(readFileSync(join(home, 'ios-logs', 'device.ndjson'), 'utf8')).toBe('native logs');
});

async function parkedEmulator() {
  await runHostedAndroidDevice('prepare', request);
  native.teardown.mockImplementation(() => {
    native.name.mockReturnValue(null);
    return { status: 'torn-down' };
  });
  return runHostedAndroidDevice('park', request);
}

test('park shuts down without deletion or a local pool entry and keeps the private ledger', async () => {
  mkdirSync(join(area, 'blobs'));
  expect(await parkedEmulator()).toMatchObject({ state: 'parked', device: { avdName: avd } });
  expect(native.teardown).toHaveBeenCalledExactlyOnceWith(avd, {});
  expect(native.avds()).toEqual([avd]);
  expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).android).toEqual([avd]);
  expect(existsSync(join(home, 'config.json'))).toBe(false);
  expect(existsSync(join(area, 'blobs'))).toBe(true);
});

test.each([{ deviceProfile: 'pixel_7' }, { systemImage: 'system-images;android-31;google_apis;arm64-v8a' }])(
  'inspect distinguishes compatible from different selectors without booting: %j',
  async (selectors) => {
    await parkedEmulator();
    native.boot.mockClear();
    expect(await runHostedAndroidDevice('inspect', request)).toMatchObject({ state: 'compatible' });
    expect(await runHostedAndroidDevice('inspect', { ...request, ...selectors })).toMatchObject({
      state: 'incompatible',
    });
    expect(native.boot).not.toHaveBeenCalled();
  },
);

test.each(['ledger', 'missing', 'running', 'image'])('inspect refuses an unusable emulator: %s', async (failure) => {
  await parkedEmulator();
  if (failure === 'ledger') forgetCreatedDevice('android', avd);
  if (failure === 'missing') native.avds.mockReturnValue([]);
  if (failure === 'running')
    native.stopped.mockImplementation(() => {
      throw new Error('still running');
    });
  if (failure === 'image') native.image.mockReturnValue('other');
  expect(await runHostedAndroidDevice('inspect', request)).toMatchObject({
    state: 'unusable',
    notice: expect.any(String),
  });
});

test('adoption removes all third-party apps and persists the newly reserved console port', async () => {
  await parkedEmulator();
  const apps = new Set(['com.example.old', 'com.example.other']);
  native.reset.mockImplementation(async (_avd, _serial, keep) => {
    for (const app of apps) if (app !== keep) apps.delete(app);
  });
  native.boot.mockImplementation(() => {
    native.name.mockReturnValue(avd);
  });
  mkdirSync(join(area, 'blobs'));
  expect(await runHostedAndroidDevice('adopt', { ...request, consolePort: 5556 })).toMatchObject({
    state: 'ready',
    device: { avdName: avd, consolePort: 5556, serial: 'emulator-5556' },
  });
  expect([...apps]).toEqual([]);
  expect(JSON.parse(readFileSync(join(home, 'hosted-device.json'), 'utf8'))).toMatchObject({
    avdName: avd,
    consolePort: 5556,
    serial: 'emulator-5556',
  });
  expect(existsSync(join(area, 'blobs'))).toBe(true);
});

test('adoption refuses an occupied new port before boot and keeps partial reset failures unknown', async () => {
  await parkedEmulator();
  native.boot.mockClear();
  native.adb.mockReturnValue({ emulators: [{ consolePort: 5556 }], unhealthy: [] });
  expect(await runHostedAndroidDevice('adopt', { ...request, consolePort: 5556 })).toMatchObject({ state: 'unknown' });
  expect(native.boot).not.toHaveBeenCalled();
  native.adb.mockReturnValue({ emulators: [], unhealthy: [] });
  native.boot.mockImplementation(() => {
    native.name.mockReturnValue(avd);
  });
  native.reset.mockRejectedValue(new Error('uninstall failed'));
  expect(await runHostedAndroidDevice('adopt', { ...request, consolePort: 5556 })).toMatchObject({
    state: 'unknown',
    device: { avdName: avd },
  });
  expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).android).toEqual([avd]);
});
