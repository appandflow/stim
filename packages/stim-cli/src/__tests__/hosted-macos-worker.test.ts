import type { ChildProcess } from 'node:child_process';
import type { Executor } from '../exec.ts';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHostedDeviceLedger,
  HOSTED_MACOS_APP_SLOTS,
  parseHostedMacosDevice,
  parseHostedOfferRequest,
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
  stopApps: vi.fn<(area: string) => Promise<void>>(),
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
vi.mock('../macos/stop.ts', () => ({
  stopMacosAppHeld: (root: string) => native.stop(root),
  stopHostedBundleInstances: (area: string) => native.stopApps(area),
}));

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
  vi.stubEnv('HOME', join(root, 'user-home'));
  vi.stubEnv('USERPROFILE', join(root, 'user-home'));
  mkdirSync(join(process.env.HOME!, 'Library', 'Preferences'), { recursive: true });
  mkdirSync(home);
  mkdirSync(area, { recursive: true });
  mkdirSync(join(home, '..', 'blobs'), { recursive: true });
  writeFileSync(join(home, 'hosted-device.json'), JSON.stringify(device));
  plist = { CFBundleIdentifier: bundleId, CFBundleExecutable: 'Fixture', LSMinimumSystemVersion: '26.0' };
  arch = 'arm64 x86_64';
  build = 'platform MACOS\n minos 26.0\n sdk 27.0';
  native.pressure.mockReturnValue('normal');
  native.identity.mockReturnValue('same');
  native.runFile.mockImplementation((file, args = []) => {
    if (file === 'defaults' && args[0] === 'read') throw new Error(`Domain ${args[1]} not found.`);
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
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function receipt(args?: string[]) {
  const files = [
    { path: 'Contents/Info.plist', kind: 'file', content: 'plist fixture' },
    { path: 'Contents/MacOS/Fixture', kind: 'exec', content: 'native binary' },
    { path: 'Contents/Frameworks/Dependency.framework/Dependency', kind: 'exec', content: 'framework binary' },
  ].map(({ path, kind, content }) => {
    const bytes = Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(home, '..', 'blobs', sha256), bytes);
    return { path, kind, sha256, size: bytes.length };
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
      mode: 'release',
      ...(args ? { arguments: args } : {}),
      manifest: { sha256, size: manifest.length },
      state: 'installing',
      launched: null,
    }),
  );
}

test('replacing an app identity removes the stopped identity preferences before recording the new launch', async () => {
  receipt();
  await runHostedMacosApp('install', request, { attempt: 'app' });
  const oldId = 'dev.stim.previous.hosted3';
  const preferences = join(process.env.HOME!, 'Library', 'Preferences');
  writeFileSync(join(preferences, `${bundleId}.hosted3.plist`), 'current preferences');
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({ state: 'installed' });
  expect(native.quiet).not.toHaveBeenCalled();
  expect(readFileSync(join(preferences, `${bundleId}.hosted3.plist`), 'utf8')).toBe('current preferences');
  writeFileSync(join(home, 'hosted-macos-app.json'), JSON.stringify({ bundleId: oldId }));
  writeFileSync(join(preferences, `${oldId}.plist`), '{}');
  native.stop.mockClear();
  native.quiet.mockImplementation(() => {
    expect(native.stop).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(home, 'hosted-macos-app.json'), 'utf8'))).toEqual({ bundleId: oldId });
    return '';
  });
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({ state: 'installed' });
  expect(native.quiet).toHaveBeenCalledExactlyOnceWith('defaults', ['delete', oldId], expect.anything());
  expect(existsSync(join(preferences, `${oldId}.plist`))).toBe(false);
  expect(readFileSync(join(preferences, `${bundleId}.hosted3.plist`), 'utf8')).toBe('current preferences');
  expect(JSON.parse(readFileSync(join(home, 'hosted-macos-app.json'), 'utf8'))).toEqual({
    bundleId: `${bundleId}.hosted3`,
  });
});

test.each([
  ['read succeeds', null, 'unknown', 'still readable'],
  ['read times out', 'defaults read timed out', 'unknown', 'timed out'],
  ['read fails unexpectedly', 'Permission denied', 'unknown', 'Permission denied'],
  ['domain not found', 'Domain dev.stim.fixture.hosted3 not found.', 'stopped', null],
  ['domain does not exist', 'Domain does not exist', 'stopped', null],
])('stop requires verified preference deletion when %s', async (_outcome, error, state, notice) => {
  writeFileSync(join(home, 'hosted-macos-app.json'), JSON.stringify({ bundleId: `${bundleId}.hosted3` }));
  const file = join(process.env.HOME!, 'Library', 'Preferences', `${bundleId}.hosted3.plist`);
  writeFileSync(file, '{}');
  native.runFile.mockImplementation(() => {
    if (error) throw new Error(error);
    return '{}';
  });
  const result = await runHostedMacosApp('stop', request);
  expect(result.state).toBe(state);
  expect(result.notice ?? '').toContain(notice ?? '');
  expect(result.notice === undefined).toBe(notice === null);
  expect(existsSync(file)).toBe(false);
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
  expect(await runHostedMacosApp('prepare', request)).toMatchObject({
    state: 'stopped',
    device: null,
    notice: 'Host memory pressure is warning; hosted sessions wait until it is normal.',
  });
  native.pressure.mockReturnValue(null);
  expect(await runHostedMacosApp('prepare', request)).toMatchObject({
    state: 'stopped',
    notice: 'Host memory pressure could not be read; retry shortly.',
  });
  native.pressure.mockReturnValueOnce(null).mockReturnValue('normal');
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
    { appSlot: HOSTED_MACOS_APP_SLOTS + 1 },
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
