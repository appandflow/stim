import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { runHostedAndroidDevice } from '../device-host/android.ts';
import { loadConfig, saveConfig, withConfigLock } from '../workspace/config.ts';
import { getExecutor, type Executor } from '../exec.ts';

const native = vi.hoisted(() => ({
  create: vi.fn<(_label: string, options: { spawn: Executor['spawn'] }) => Promise<void>>(),
  boot: vi.fn<(...args: unknown[]) => void>(),
  teardown: vi.fn<(target: string, options: { del: boolean }) => { status: string; reason?: string }>(),
  avds: vi.fn<() => string[]>(),
  name: vi.fn<() => string | null>(),
  abi: vi.fn<() => string | null>(),
  adb: vi.fn<
    () => { emulators: { consolePort: number; serial?: string }[]; unhealthy: { consolePort: number | null }[] }
  >(),
  pressure: vi.fn<() => string | null>(),
}));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => native.pressure() }));
vi.mock('../devices/android.ts', () => ({
  DEFAULT_AVD_DEVICE_PROFILE: 'pixel_6',
  hostSystemImageArch: () => 'arm64-v8a',
  listInstalledSystemImages: () => [{ pkg: 'system-images;android-30;google_apis;arm64-v8a', arch: 'arm64-v8a' }],
  pickDefaultSystemImage: (images: unknown[]) => images[0],
  listAvdDeviceProfiles: () => ['pixel_6'],
  listAvds: () => native.avds(),
  ownedAvdName: (label: string) => `stim-${label}`,
  listAdbDevices: () => native.adb(),
  createOwnedAvd: (label: string, options: { spawn: Executor['spawn'] }) => native.create(label, options),
  bootAndroidEmulator: (...args: unknown[]) => native.boot(...args),
  waitForBoot: () => Promise.resolve({ ok: true }),
  getAvdNameForSerial: () => native.name(),
  androidDeviceAbi: () => native.abi(),
}));
vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedAvd: (...args: Parameters<typeof native.teardown>) => native.teardown(...args),
}));

let home: string;
const session = '12345678-1234-1234-1234-123456789abc';
const avd = `stim-hosted-${session}`;
const request = { session, consolePort: 5554 };
beforeEach(() => {
  vi.resetAllMocks();
  home = mkdtempSync(join(tmpdir(), 'stim-hosted-android-'));
  process.env.STIM_HOME = home;
  native.pressure.mockReturnValue('normal');
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
  rmSync(home, { recursive: true, force: true });
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
    .runFile('ps', ['-o', 'pgid=', '-p', String(process.pid)])
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
