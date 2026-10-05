import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectHostedDevice } from '../device-host/offer.ts';
import type { SystemImage } from '../devices/android.ts';

const native = vi.hoisted(() => ({
  runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>(),
  pressure: vi.fn<() => string | null>(),
  ios: vi.fn<(selectors: unknown) => object>(),
  images: vi.fn<() => SystemImage[]>(),
  create: vi.fn<() => void>(),
  boot: vi.fn<() => void>(),
}));
vi.mock('../exec.ts', () => ({ getExecutor: () => ({ runFile: native.runFile }) }));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => native.pressure() }));
vi.mock('../devices/ios.ts', () => ({
  listAllIosSims: () => [],
  resolveIosCreation: (selectors: unknown) => native.ios(selectors),
  createOwnedIosSim: native.create,
  bootIosSim: native.boot,
}));
vi.mock('../devices/android.ts', async (original) => ({
  ...(await original<typeof import('../devices/android.ts')>()),
  hostSystemImageArch: () => 'arm64-v8a',
  listInstalledSystemImages: () => native.images(),
  listAvdDeviceProfiles: () => ['pixel_6'],
  createOwnedAvd: native.create,
  bootAndroidEmulator: native.boot,
}));
let home: string;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' }, arch: { value: 'arm64' } }));
  home = mkdtempSync(join(tmpdir(), 'stim-host-offer-'));
  process.env.STIM_HOME = home;
  native.pressure.mockReturnValue('normal');
  native.runFile.mockReturnValue('27.0');
  native.ios.mockImplementation((selectors) => {
    if ((selectors as { runtime?: string }).runtime === 'missing') throw new Error('Runtime not installed.');
    return { deviceTypeId: 'iphone', runtimeId: 'ios', deviceType: 'iPhone', runtime: '27.1' };
  });
  native.images.mockReturnValue([
    { pkg: 'system-images;android-30;google_apis;arm64-v8a', api: 30, tag: 'google_apis', arch: 'arm64-v8a' },
    { pkg: 'system-images;android-36;google_apis;x86_64', api: 36, tag: 'google_apis', arch: 'x86_64' },
  ]);
});
afterEach(() => {
  delete process.env.STIM_HOME;
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

test('reports selected installed SDK metadata without native or filesystem mutation', () => {
  expect(inspectHostedDevice({ platform: 'ios' })).toMatchObject({
    choice: { runtime: '27.1', deviceTypeId: 'iphone', architecture: 'arm64' },
    declined: null,
  });
  expect(inspectHostedDevice({ platform: 'android' })).toMatchObject({
    choice: { systemImage: 'system-images;android-30;google_apis;arm64-v8a', deviceProfile: 'pixel_6' },
    declined: null,
  });
  expect(inspectHostedDevice({ platform: 'ios', runtime: 'missing' })).toMatchObject({
    choice: null,
    declined: 'Runtime not installed.',
  });
  expect(
    inspectHostedDevice({ platform: 'android', systemImage: 'system-images;android-36;google_apis;x86_64' }),
  ).toMatchObject({
    choice: null,
    declined: 'No compatible installed Android image.',
  });
  expect(inspectHostedDevice({ platform: 'android', deviceProfile: 'missing' })).toMatchObject({
    choice: null,
    declined: 'The Android device profile is not installed.',
  });
  expect(inspectHostedDevice({ platform: 'macos' })).toMatchObject({
    choice: { architecture: 'arm64', macosVersion: '27.0' },
    declined: null,
  });
  expect(native.create).not.toHaveBeenCalled();
  expect(native.boot).not.toHaveBeenCalled();
  expect(readdirSync(home)).toEqual([]);
});

test.each([null, 'warning', 'critical'])(
  'unknown or elevated pressure %s declines before SDK selection',
  (pressure) => {
    native.pressure.mockReturnValue(pressure);
    for (const platform of ['ios', 'android', 'macos'] as const)
      expect(inspectHostedDevice({ platform })).toMatchObject({
        choice: null,
        declined: 'Host memory pressure is unknown or elevated.',
        resources: { memoryPressure: pressure },
      });
    expect(native.ios).not.toHaveBeenCalled();
    expect(native.images).not.toHaveBeenCalled();
  },
);
