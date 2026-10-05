import type { ChildProcess } from 'node:child_process';
import type { Executor } from '../exec.ts';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHostedDeviceLedger,
  deviceHostRoot,
  parseHostedMacosDevice,
  parseHostedOfferRequest,
  readHostedSessions,
  readMacosRecord,
  type HostedMacosDevice,
} from '@stim-cli/core/state';
import { runHostedMacosApp } from '../device-host/macos.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';

const native = vi.hoisted(() => ({
  runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>(),
  quiet: vi.fn<Executor['runFileQuiet']>(),
  spawn: vi.fn<Executor['spawn']>(),
  pressure: vi.fn<() => string | null>(),
  identity: vi.fn<(record: unknown) => string>(),
  stop: vi.fn<(root: string) => Promise<boolean>>(),
}));
vi.mock('../exec.ts', () => ({
  getExecutor: () => ({ runFile: native.runFile, runFileQuiet: native.quiet, spawn: native.spawn }),
}));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => native.pressure() }));
vi.mock('../macos/state.ts', async (original) => ({
  ...(await original<typeof import('../macos/state.ts')>()),
  macosProcess: (pid: number) => ({ pid, processToken: 'worker', startedAtMicros: 1 }),
}));
vi.mock('../process-identity.ts', async (original) => ({
  ...(await original<typeof import('../process-identity.ts')>()),
  inspectProcessIdentity: (record: unknown) => native.identity(record),
}));
vi.mock('../macos/stop.ts', () => ({ stopMacosAppHeld: (root: string) => native.stop(root) }));

let root: string;
let home: string;
let area: string;
let plist: Record<string, unknown>;
let arch: string;
let build: string;
const session = '12345678-1234-1234-1234-123456789abc';
const bundleId = 'dev.stim.fixture';
const request = { session, appSlot: 3 };
const device: HostedMacosDevice = { architecture: 'arm64', macosVersion: '27.0', appSlot: 3 };

beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), 'stim-hosted-macos-'));
  home = join(root, 'home');
  area = join(root, 'apps', 'app');
  process.env.STIM_HOME = home;
  mkdirSync(home);
  mkdirSync(join(area, 'blobs'), { recursive: true });
  writeFileSync(join(home, 'hosted-device.json'), JSON.stringify(device));
  plist = { CFBundleIdentifier: bundleId, CFBundleExecutable: 'Fixture', LSMinimumSystemVersion: '26.0' };
  arch = 'arm64 x86_64';
  build = 'platform MACOS\n minos 26.0\n sdk 27.0';
  native.pressure.mockReturnValue('normal');
  native.identity.mockReturnValue('same');
  native.runFile.mockImplementation((file, args = []) => {
    if (file === 'sw_vers') return '27.0';
    if (file === 'plutil') return JSON.stringify(plist);
    if (args[0] === 'lipo') return arch;
    if (args[0] === 'vtool') return build;
    return '';
  });
  native.spawn.mockImplementation((_file, args = []) => {
    const runRoot = args[1]!;
    const record = readMacosRecord(runRoot)!;
    writeWorkspaceState(runRoot, {
      macos: {
        ...record,
        supervisor: { pid: 101, processToken: 'supervisor', startedAtMicros: 1 },
        app: { pid: 102, processToken: 'app', startedAtMicros: 1 },
      },
    });
    return Object.assign(new EventEmitter(), {
      unref: vi.fn<() => void>(),
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

function receipt() {
  const files = [
    { path: 'Contents/Info.plist', kind: 'file', content: 'plist fixture' },
    { path: 'Contents/MacOS/Fixture', kind: 'exec', content: 'native binary' },
    { path: 'Contents/Frameworks/Dependency.framework/Dependency', kind: 'exec', content: 'framework binary' },
  ].map(({ path, kind, content }) => {
    const bytes = Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(area, 'blobs', sha256), bytes);
    return { path, kind, sha256, size: bytes.length };
  });
  const manifest = Buffer.from(JSON.stringify(files));
  const sha256 = createHash('sha256').update(manifest).digest('hex');
  writeFileSync(join(area, 'blobs', sha256), manifest);
  writeFileSync(
    join(area, 'receipt.json'),
    JSON.stringify({
      session,
      attempt: 'app',
      bundleId,
      mode: 'release',
      manifest: { sha256, size: manifest.length },
      state: 'installing',
      launched: null,
    }),
  );
}

test.each([
  'identity',
  'architecture',
  'minos',
  'platform',
  'plist minimum',
  'URL schemes',
  'update feed',
  'executable',
])('refuses incompatible macOS %s before signing or launching', async (failure) => {
  receipt();
  if (failure === 'identity') plist.CFBundleIdentifier = 'different.app';
  if (failure === 'architecture') arch = 'x86_64';
  if (failure === 'minos') build = 'platform MACOS\n minos 27.0.1';
  if (failure === 'platform') build = 'platform IOSSIMULATOR\n minos 26.0';
  if (failure === 'plist minimum') plist.LSMinimumSystemVersion = '28';
  if (failure === 'URL schemes') plist.CFBundleURLTypes = [];
  if (failure === 'update feed') plist.SUFeedURL = 'https://example.test';
  if (failure === 'executable') plist.CFBundleExecutable = '../Fixture';
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({
    state: 'unknown',
    device,
    notice: expect.any(String),
  });
  expect(native.runFile.mock.calls.some(([file]) => file === 'codesign' || file === '/usr/libexec/PlistBuddy')).toBe(
    false,
  );
  expect(native.spawn).not.toHaveBeenCalled();
});

test('stamps and signs verified bytes, launches with an isolated home, and deletes only its recorded preference domain after stop', async () => {
  receipt();
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toEqual({
    state: 'installed',
    device,
    launched: true,
  });
  const bundle = join(area, 'App.app');
  expect(native.runFile).toHaveBeenCalledWith(
    '/usr/libexec/PlistBuddy',
    ['-c', `Set :CFBundleIdentifier ${bundleId}.hosted3`, join(bundle, 'Contents', 'Info.plist')],
    expect.anything(),
  );
  expect(native.runFile.mock.calls.filter(([file]) => file === 'codesign').map(([, args]) => args)).toEqual([
    ['--force', '--sign', '-', join(bundle, 'Contents', 'Frameworks', 'Dependency.framework')],
    ['--force', '--sign', '-', bundle],
  ]);
  expect(native.spawn).toHaveBeenCalledWith(
    process.execPath,
    [expect.stringMatching(/macos[/-]run\.(ts|mjs)$/), realpathSync(join(home, 'macos-app')), expect.any(String)],
    expect.objectContaining({
      detached: true,
      env: expect.objectContaining({
        STIM_HOME: home,
        HOME: join(home, 'app-home'),
        CFFIXED_USER_HOME: join(home, 'app-home'),
        TMPDIR: join(home, 'app-home', 'tmp'),
      }),
    }),
  );
  expect(readMacosRecord(realpathSync(join(home, 'macos-app')))).toMatchObject({
    bundleId: `${bundleId}.hosted3`,
    arguments: [],
    build: { state: 'ok' },
  });
  expect(await runHostedMacosApp('stop', request)).toEqual({ state: 'stopped', device });
  expect(native.stop).toHaveBeenCalledExactlyOnceWith(realpathSync(join(home, 'macos-app')));
  expect(native.quiet).toHaveBeenCalledExactlyOnceWith(
    'defaults',
    ['delete', `${bundleId}.hosted3`],
    expect.anything(),
  );
});

test('does not claim a launch when registration lacks a verified process', async () => {
  receipt();
  native.identity.mockReturnValue('unknown');
  const spawn = native.spawn.getMockImplementation()!;
  native.spawn.mockImplementation((...args) => {
    const child = spawn(...args);
    Object.assign(child, { exitCode: 1 });
    return child;
  });
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({
    state: 'unknown',
    notice: expect.stringContaining('did not register'),
  });
});

test('stop without an app skips defaults and refuses a foreign preference domain', async () => {
  expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'stopped' });
  expect(native.quiet).not.toHaveBeenCalled();
  writeFileSync(join(home, 'hosted-macos-app.json'), JSON.stringify({ bundleId: 'com.apple.fixture.hosted3' }));
  expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'unknown' });
  expect(native.quiet).not.toHaveBeenCalled();
});

test('prepare records its app slot without a device ledger and refuses replacement or memory pressure', async () => {
  rmSync(join(home, 'hosted-device.json'));
  native.pressure.mockReturnValue('warning');
  expect(await runHostedMacosApp('prepare', request)).toMatchObject({ state: 'stopped', device: null });
  native.pressure.mockReturnValue('normal');
  expect(await runHostedMacosApp('prepare', request)).toMatchObject({
    state: 'ready',
    device: { macosVersion: '27.0', appSlot: 3 },
  });
  expect(existsSync(join(home, 'created-devices.json'))).toBe(false);
  expect(await runHostedMacosApp('prepare', request)).toMatchObject({ state: 'unknown' });
});

test('macOS device parsing rejects foreign devices, invalid slots and selector requests', () => {
  expect(parseHostedMacosDevice(device)).toEqual(device);
  for (const invalid of [
    { udid: 'foreign' },
    { avdName: 'foreign' },
    { extra: true },
    { appSlot: 0 },
    { appSlot: 65 },
    { appSlot: 1.5 },
    { macosVersion: '27.beta' },
  ]) {
    expect(parseHostedMacosDevice({ ...device, ...invalid })).toBeNull();
  }
  expect(parseHostedOfferRequest({ platform: 'macos' })).toEqual({ platform: 'macos' });
  for (const selector of ['deviceType', 'runtime', 'systemImage', 'deviceProfile'])
    expect(parseHostedOfferRequest({ platform: 'macos', [selector]: 'selector' })).toBeNull();
  expect(() => assertHostedDeviceLedger(home, 'macos-3', 'macos')).not.toThrow();
  writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [], android: [], web: [] }));
  expect(() => assertHostedDeviceLedger(home, 'macos-3', 'macos')).not.toThrow();
  writeFileSync(
    join(home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: ['foreign'], android: [], web: [] }),
  );
  expect(() => assertHostedDeviceLedger(home, 'macos-3', 'macos')).toThrow('ownership ledger');
});

test('journal rejects missing, foreign and mismatched macOS app slots', () => {
  mkdirSync(deviceHostRoot(), { recursive: true });
  const record = {
    ...request,
    platform: 'macos',
    workspace: '/client/worktree',
    slot: 'default',
    attempt: 'first',
    id: session,
    client: 'client',
    state: 'ready',
    device,
    createdAt: new Date().toISOString(),
  };
  const write = (value: object) =>
    writeFileSync(join(deviceHostRoot(), 'sessions.json'), JSON.stringify({ version: 1, sessions: [value] }));
  write(record);
  expect(readHostedSessions()).toEqual([record]);
  for (const invalid of [
    { appSlot: undefined },
    { appSlot: 0 },
    { appSlot: 2 },
    { platform: 'ios', device: null, state: 'preparing' },
  ]) {
    write({ ...record, ...invalid });
    expect(() => readHostedSessions()).toThrow('Malformed hosted session record');
  }
});
