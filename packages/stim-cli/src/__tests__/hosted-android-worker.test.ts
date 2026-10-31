import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { runHostedAndroidDevice } from '../device-host/android.ts';
import { loadConfig } from '../workspace/config.ts';
import { type Executor } from '../exec.ts';
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
  mute: vi.fn<(serial: string, avdName: string) => Promise<void>>(),
}));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => null }));
vi.mock('../devices/android.ts', () => ({
  DEFAULT_AVD_DEVICE_PROFILE: 'pixel_6',
  hostSystemImageArch: () => 'arm64-v8a',
  listInstalledSystemImages: () =>
    [30, 31].map((api) => ({ pkg: `system-images;android-${api};google_apis;arm64-v8a`, arch: 'arm64-v8a' })),
  pickDefaultSystemImage: (images: { pkg: string }[], request: { systemImage?: string }) =>
    images.find((image) => !request.systemImage || image.pkg === request.systemImage),
  listAvdDeviceProfiles: () => ['pixel_6', 'pixel_7'],
  listAvds: () => native.avds(),
  listAvdsAsync: async () => native.avds(),
  ownedAvdName: (label: string) => `stim-${label}`,
  listAdbDevices: () => native.adb(),
  listAdbDevicesAsync: async () => native.adb(),
  createOwnedAvd: (label: string, options: { spawn: Executor['spawn'] }) => native.create(label, options),
  bootAndroidEmulator: (...args: unknown[]) => native.boot(...args),
  waitForBoot: () => native.wait(),
  getAvdNameForSerial: () => native.name(),
  getAvdNameForSerialAsync: async () => native.name(),
  androidDeviceAbi: async () => native.abi(),
  avdStorageRoots: () => [home],
  assertOwnedAvdStopped: () => native.stopped(),
  ownedAvdSystemImage: () => native.image(),
  resolveOwnedAvdSerial: () => native.resolved(),
  resolveOwnedAvdSerialAsync: async () => native.resolved(),
  resetAdoptedAvd: (avd: string, serial: string, keep: string) => native.reset(avd, serial, keep),
  avdPathExists: (path: string) => existsSync(path),
}));
vi.mock('../engine/device-android.ts', () => ({
  muteBootedEmulator: (serial: string, avdName: string) => native.mute(serial, avdName),
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

test('an occupied console port refuses before any native creation', async () => {
  native.adb.mockReturnValue({ emulators: [{ consolePort: 5554, serial: 'emulator-5554' }], unhealthy: [] });
  expect(await runHostedAndroidDevice('prepare', request)).toMatchObject({ state: 'stopped', device: null });
  expect(native.create).not.toHaveBeenCalled();
  expect(native.boot).not.toHaveBeenCalled();
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

async function parkedEmulator() {
  await runHostedAndroidDevice('prepare', request);
  native.teardown.mockImplementation(() => {
    native.name.mockReturnValue(null);
    return { status: 'torn-down' };
  });
  return runHostedAndroidDevice('park', request);
}

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
