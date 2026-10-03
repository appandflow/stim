import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHostedAndroidApp } from '../device-host/android-app.ts';
import type { HostedAndroidDevice } from '@stim-cli/core/state';

const native = vi.hoisted(() => ({
  runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>(),
  runQuiet: vi.fn<(command: string) => string>(),
}));
vi.mock('../exec.ts', () => ({ getExecutor: () => native }));
vi.mock('../commands/android/support.ts', () => ({
  findAapt: () => ({ path: '/fixture/aapt', tool: 'aapt', version: '36' }),
}));
let root: string;
let home: string;
let area: string;
let launched: boolean;
let badging: string;
let running: string;
const session = '12345678-1234-1234-1234-123456789abc';
const packageName = 'dev.stim.android_app';
const sdkAdbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
const device: HostedAndroidDevice = {
  avdName: `stim-hosted-${session}`,
  serial: 'emulator-5554',
  consolePort: 5554,
  systemImage: 'system-images;android-30;google_apis;arm64-v8a',
  deviceProfile: 'pixel_6',
  architecture: 'arm64-v8a',
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-hosted-apk-'));
  home = join(root, 'home');
  area = join(root, 'apps', 'app');
  process.env.STIM_HOME = home;
  mkdirSync(home);
  mkdirSync(join(area, 'blobs'), { recursive: true });
  const sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  writeFileSync(join(sdk, 'platform-tools', sdkAdbName), 'fixture');
  vi.stubEnv('ANDROID_HOME', sdk);
  writeFileSync(join(home, 'hosted-device.json'), JSON.stringify(device));
  writeFileSync(
    join(home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: [], android: [device.avdName], web: [] }),
  );
  launched = false;
  running = device.avdName;
  badging = `package: name='${packageName}' versionCode='1'\nsdkVersion:'21'\nnative-code: 'arm64-v8a'`;
  native.runFile.mockReset();
  native.runQuiet.mockReset();
  native.runQuiet.mockImplementation((command) => (command.includes('emu avd name') ? running + '\nOK' : 'arm64-v8a'));
  native.runFile.mockImplementation((file, args = []) => {
    if (file === '/fixture/aapt') return badging;
    if (args.includes('getprop')) return 'arm64-v8a';
    if (args.includes('resolve-activity')) return packageName + '/.MainActivity';
    if (args.includes('start')) launched = true;
    if (args.includes('pidof')) return launched ? '321' : '';
    return '';
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function receipt(mode = 'release') {
  const apk = Buffer.from('verified APK fixture');
  const sha256 = hash(apk);
  writeFileSync(join(area, 'blobs', sha256), apk);
  const manifest = Buffer.from(JSON.stringify([{ path: 'App.apk', kind: 'file', size: apk.length, sha256 }]));
  const digest = hash(manifest);
  writeFileSync(join(area, 'blobs', digest), manifest);
  writeFileSync(
    join(area, 'receipt.json'),
    JSON.stringify({
      session,
      attempt: 'app',
      bundleId: packageName,
      mode,
      manifest: { sha256: digest, size: manifest.length },
      state: 'installing',
      launched: null,
    }),
  );
  return sha256;
}
const effects = () =>
  native.runFile.mock.calls.filter(([, args]) => args?.includes('install') || args?.includes('start'));

test('verifies bytes and package metadata, drives the exact AVD and proves a release process', async () => {
  receipt();
  expect(await installHostedAndroidApp(home, session, 'app', device)).toBe(true);
  expect(readFileSync(join(area, 'App.apk'), 'utf8')).toBe('verified APK fixture');
  expect(effects().map(([, args]) => args?.slice(0, 2))).toEqual([
    ['-s', device.serial],
    ['-s', device.serial],
  ]);
  expect(effects().map(([file]) => file)).toEqual(Array(2).fill(join(root, 'sdk', 'platform-tools', sdkAdbName)));
});

test('development launch remains unverified despite a live native process', async () => {
  receipt('development');
  expect(await installHostedAndroidApp(home, session, 'app', device)).toBe('unverified');
});

test.each(['package', 'SDK', 'ABI'])('incompatible %s metadata refuses before installation', async (kind) => {
  receipt();
  if (kind === 'package') badging = badging.replace(packageName, 'dev.foreign');
  if (kind === 'SDK') badging = badging.replace("sdkVersion:'21'", "sdkVersion:'31'");
  if (kind === 'ABI') badging = badging.replace("'arm64-v8a'", "'x86_64'");
  await expect(installHostedAndroidApp(home, session, 'app', device)).rejects.toThrow(/incompatible|native library/);
  expect(effects()).toEqual([]);
});

test('corrupt upload bytes refuse before SDK or native effects', async () => {
  const digest = receipt();
  writeFileSync(join(area, 'blobs', digest), 'corrupt');
  await expect(installHostedAndroidApp(home, session, 'app', device)).rejects.toThrow(/differs/);
  expect(native.runFile).not.toHaveBeenCalled();
});

test('a reused serial refuses effects before install and rechecks before launch', async () => {
  receipt();
  running = 'foreign';
  await expect(installHostedAndroidApp(home, session, 'app', device)).rejects.toThrow(/identity/);
  expect(effects()).toEqual([]);
  running = device.avdName;
  native.runFile.mockImplementation((file, args = []) => {
    if (file === '/fixture/aapt') return badging;
    if (args.includes('getprop')) return 'arm64-v8a';
    if (args.includes('install')) running = 'foreign';
    return '';
  });
  await expect(installHostedAndroidApp(home, session, 'app', device)).rejects.toThrow(/identity/);
  expect(effects()).toHaveLength(1);
});
