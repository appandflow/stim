import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHostedApp } from '../device-host/app.ts';
import type { HostedAppFile, HostedIosDevice } from '@stim-cli/core/state';

const native = vi.hoisted(() => ({ runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>() }));
vi.mock('../exec.ts', () => ({ getExecutor: () => ({ runFile: native.runFile }) }));
let root: string;
let home: string;
let area: string;
let launched: boolean;
let platform: string;
const session = '12345678-1234-1234-1234-123456789abc';
const bundleId = 'dev.stim.fixture';
const device: HostedIosDevice = {
  udid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'stim-owned',
  deviceTypeId: 'iphone',
  runtimeId: 'ios',
  deviceType: 'iPhone',
  runtime: '27.0',
  architecture: 'arm64',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-app-worker-'));
  home = join(root, 'home');
  area = join(root, 'apps', 'app');
  process.env.STIM_HOME = home;
  mkdirSync(home);
  mkdirSync(area, { recursive: true });
  mkdirSync(join(home, '..', 'blobs'), { recursive: true });
  writeFileSync(join(home, 'hosted-device.json'), JSON.stringify(device));
  writeFileSync(
    join(home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: [device.udid], android: [], web: [] }),
  );
  launched = false;
  platform = 'IOSSIMULATOR';
  native.runFile.mockReset();
  native.runFile.mockImplementation((file, args = []) => {
    if (file === '/usr/libexec/PlistBuddy') {
      const values: Record<string, string> = {
        CFBundleIdentifier: bundleId,
        DTPlatformName: 'iphonesimulator',
        CFBundleSupportedPlatforms: 'Array {\n iPhoneSimulator\n}',
        CFBundleExecutable: 'Fixture',
        MinimumOSVersion: '26.0',
      };
      return values[(args[1] ?? '').replace('Print :', '')] ?? '';
    }
    if (args[0] === 'lipo') return 'arm64';
    if (args[0] === 'vtool')
      return `Load command 5\n cmd LC_BUILD_VERSION\n platform ${platform}\n minos 26.0\n sdk 27.0`;
    if (args[1] === 'launch') {
      launched = true;
      return `${bundleId}: 321`;
    }
    if (args.includes('launchctl')) return launched ? `321 0 UIKitApplication:${bundleId}[abc]` : '';
    return '';
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

function receipt(extra: { path: string; kind: HostedAppFile['kind']; content: string }[] = [], mode = 'release') {
  const entries = [
    { path: 'Info.plist', kind: 'file' as const, content: 'plist fixture' },
    { path: 'Fixture', kind: 'exec' as const, content: 'native binary fixture' },
    ...extra,
  ];
  const files = entries.map((entry) => {
    const bytes = Buffer.from(entry.content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(home, '..', 'blobs', sha256), bytes);
    return { path: entry.path, kind: entry.kind, sha256, size: bytes.length };
  });
  const manifest = Buffer.from(JSON.stringify(files));
  const sha256 = createHash('sha256').update(manifest).digest('hex');
  writeFileSync(join(home, '..', 'blobs', sha256), manifest);
  writeFileSync(
    join(area, 'receipt.json'),
    JSON.stringify({
      session,
      attempt: 'app',
      bundleId,
      mode,
      manifest: { sha256, size: manifest.length },
      state: 'installing',
      launched: null,
    }),
  );
}

test('materializes verified files and contained links, drives only the recorded UDID, and proves a release process', async () => {
  receipt([
    { path: 'Resources/data', kind: 'file', content: 'payload' },
    { path: 'data-link', kind: 'link', content: 'Resources/data' },
  ]);
  expect(await installHostedApp(home, session, 'app', device)).toBe(true);
  expect(readFileSync(join(area, 'App.app', 'data-link'), 'utf8')).toBe('payload');
  expect(
    native.runFile.mock.calls
      .filter(([, args]) => args?.[0] === 'simctl' && ['install', 'launch'].includes(args[1] ?? ''))
      .map(([, args]) => args?.slice(0, 3)),
  ).toEqual([
    ['simctl', 'install', device.udid],
    ['simctl', 'launch', device.udid],
  ]);
});

test('keeps development launch unverified despite a live native process', async () => {
  receipt([], 'development');
  expect(await installHostedApp(home, session, 'app', device, 14321)).toBe('unverified');
  expect(native.runFile).toHaveBeenCalledWith(
    'xcrun',
    ['simctl', 'spawn', device.udid, 'defaults', 'write', bundleId, 'RCT_jsLocation', 'localhost:14321'],
    expect.anything(),
  );
});

test('routes an Expo development client to the worker loopback origin without claiming bundle delivery', async () => {
  receipt([], 'development');
  const path = join(area, 'receipt.json');
  const offered = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...offered, devClientScheme: 'stim-dev' }));
  expect(await installHostedApp(home, session, 'app', device, 14321)).toBe('unverified');
  expect(native.runFile).toHaveBeenCalledWith(
    'xcrun',
    [
      'simctl',
      'spawn',
      device.udid,
      'defaults',
      'write',
      'com.apple.launchservices.schemeapproval',
      'com.apple.CoreSimulator.CoreSimulatorBridge-->stim-dev',
      '-string',
      bundleId,
    ],
    expect.anything(),
  );
  const opened = native.runFile.mock.calls.find(([, args]) => args?.[1] === 'openurl');
  expect(opened?.[1]?.slice(0, 3)).toEqual(['simctl', 'openurl', device.udid]);
  const url = new URL(opened![1]![3]!);
  expect(url.protocol).toBe('stim-dev:');
  expect(new URL(url.searchParams.get('url')!).origin).toBe('http://localhost:14321');
});

test.each(['../outside', '/tmp/outside', 'missing'])(
  'refuses app link %s before native installation',
  async (target) => {
    receipt([{ path: 'link', kind: 'link', content: target }]);
    await expect(installHostedApp(home, session, 'app', device)).rejects.toThrow(/escapes|ENOENT/);
    expect(native.runFile).not.toHaveBeenCalled();
  },
);

test('rejects a device Mach-O disguised by simulator plist metadata without installing it', async () => {
  receipt();
  platform = 'IOS';
  await expect(installHostedApp(home, session, 'app', device)).rejects.toThrow('incompatible');
  expect(native.runFile.mock.calls.some(([, args]) => args?.[0] === 'simctl')).toBe(false);
});

test('refuses altered bytes and a lost device ledger before installing onto a simulator', async () => {
  receipt();
  const sha256 = createHash('sha256').update('plist fixture').digest('hex');
  writeFileSync(join(home, '..', 'blobs', sha256), 'altered');
  await expect(installHostedApp(home, session, 'app', device)).rejects.toThrow('digest');
  expect(native.runFile).not.toHaveBeenCalled();
  receipt();
  rmSync(join(home, 'created-devices.json'));
  await expect(installHostedApp(home, session, 'app', device)).rejects.toThrow(/ENOENT/);
  expect(native.runFile.mock.calls.some(([, args]) => args?.[0] === 'simctl')).toBe(false);
});
