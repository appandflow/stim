import type { ChildProcess } from 'node:child_process';
import type { Executor } from '../exec.ts';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { workspaceLogsDir } from '../workspace/paths.ts';

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
  const offeredArguments = ['-autopilot.enabled', 'true', '', 'ENV=value'];
  receipt(offeredArguments);
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toEqual({
    state: 'installed',
    device,
    launched: true,
    pid: 102,
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
    [expect.stringMatching(/macos[/\\-]run\.(ts|mjs)$/), realpathSync(join(home, 'macos-app')), expect.any(String)],
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
    arguments: offeredArguments,
    build: { state: 'ok' },
  });
  const preferences = join(process.env.HOME!, 'Library', 'Preferences');
  writeFileSync(join(preferences, `${bundleId}.hosted3.plist`), '{}');
  writeFileSync(join(preferences, `${bundleId}.plist`), 'original preferences');
  writeFileSync(join(preferences, `${bundleId}.hosted4.plist`), 'another slot');
  symlinkSync(preferences, join(bundle, 'shared-preferences'));
  const previous = join(root, 'apps', 'previous');
  mkdirSync(join(previous, 'App.app'), { recursive: true });
  mkdirSync(join(previous, 'blobs'));
  writeFileSync(join(previous, 'receipt.json'), '{}');
  writeFileSync(join(previous, 'manifest.json'), '[]');
  const logs = workspaceLogsDir(realpathSync(join(home, 'macos-app')));
  mkdirSync(logs, { recursive: true });
  const log = join(logs, 'macos.ndjson');
  writeFileSync(log, 'app output');
  expect(await runHostedMacosApp('stop', request)).toEqual({ state: 'stopped', device });
  expect(native.stop).toHaveBeenCalledExactlyOnceWith(realpathSync(join(home, 'macos-app')));
  expect(native.quiet).toHaveBeenCalledExactlyOnceWith(
    'defaults',
    ['delete', `${bundleId}.hosted3`],
    expect.anything(),
  );
  expect(existsSync(join(preferences, `${bundleId}.hosted3.plist`))).toBe(false);
  expect(readFileSync(join(preferences, `${bundleId}.plist`), 'utf8')).toBe('original preferences');
  expect(readFileSync(join(preferences, `${bundleId}.hosted4.plist`), 'utf8')).toBe('another slot');
  expect(existsSync(join(home, 'app-home'))).toBe(false);
  for (const attempt of [area, previous]) {
    expect(existsSync(join(attempt, 'App.app'))).toBe(false);
    expect(existsSync(join(attempt, 'blobs'))).toBe(false);
    expect(existsSync(join(attempt, 'receipt.json'))).toBe(true);
  }
  expect(existsSync(join(previous, 'manifest.json'))).toBe(true);
  expect(existsSync(join(home, 'macos-supervisor.log'))).toBe(true);
  expect(readFileSync(log, 'utf8')).toBe('app output');
});

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

test('launch passes only allowed environment variables and isolated paths to client code', async () => {
  receipt();
  vi.stubEnv('PATH', '/usr/bin');
  vi.stubEnv('LANG', 'en_US.UTF-8');
  vi.stubEnv('LC_ALL', 'en_US.UTF-8');
  vi.stubEnv('LC_CTYPE', 'UTF-8');
  vi.stubEnv('USER', 'fixture');
  vi.stubEnv('LOGNAME', 'fixture');
  vi.stubEnv('SHELL', '/bin/zsh');
  vi.stubEnv('TERM', undefined);
  vi.stubEnv('SERVER_TOKEN', 'secret');
  vi.stubEnv('NODE_OPTIONS', '--inspect');
  vi.stubEnv('STIM_SECRET', 'secret');
  vi.stubEnv('CFFIXED_USER_HOME', '/host/home');
  vi.stubEnv('TMPDIR', '/host/tmp');
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({ state: 'installed' });
  expect(native.spawn.mock.calls[0]![2]!.env).toEqual({
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    USER: 'fixture',
    LOGNAME: 'fixture',
    SHELL: '/bin/zsh',
    STIM_HOME: home,
    HOME: join(home, 'app-home'),
    CFFIXED_USER_HOME: join(home, 'app-home'),
    TMPDIR: join(home, 'app-home', 'tmp'),
  });
});

test.each(['app-home', 'attempt', 'bundle', 'blobs', 'apps'])(
  'stop refuses %s links outside the private area without deleting their targets',
  async (target) => {
    const outside = mkdtempSync(join(tmpdir(), 'stim-hosted-outside-'));
    try {
      writeFileSync(join(outside, 'keep'), 'private bytes');
      const path =
        target === 'app-home'
          ? join(home, 'app-home')
          : target === 'attempt'
            ? area
            : target === 'apps'
              ? join(root, 'apps')
              : target === 'bundle'
                ? join(area, 'App.app')
                : join(home, '..', 'blobs');
      rmSync(path, { recursive: true, force: true });
      symlinkSync(outside, path);
      expect(await runHostedMacosApp('stop', request)).toMatchObject({
        state: 'unknown',
        notice: expect.stringContaining('outside'),
      });
      expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('private bytes');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

test('stop retains app data and preferences when process shutdown cannot be verified', async () => {
  receipt();
  await runHostedMacosApp('install', request, { attempt: 'app' });
  native.stop.mockRejectedValue(new Error('Owner unresolved'));
  expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'unknown', notice: 'Owner unresolved' });
  expect(native.quiet).not.toHaveBeenCalled();
  expect(existsSync(join(home, 'app-home'))).toBe(true);
  expect(existsSync(join(area, 'App.app'))).toBe(true);
  expect(existsSync(join(home, '..', 'blobs'))).toBe(true);
});

test('a preference plist removal failure leaves stop unresolved and app data intact', async () => {
  receipt();
  await runHostedMacosApp('install', request, { attempt: 'app' });
  mkdirSync(join(process.env.HOME!, 'Library', 'Preferences', `${bundleId}.hosted3.plist`));
  expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'unknown' });
  expect(existsSync(join(home, 'app-home'))).toBe(true);
  expect(existsSync(join(area, 'App.app'))).toBe(true);
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

test.each(['foo.hosted4', `${'a'.repeat(242)}.hosted3`])(
  'stop refuses tampered preference identity %s without deleting preferences or app data',
  async (id) => {
    receipt();
    await runHostedMacosApp('install', request, { attempt: 'app' });
    const file = join(process.env.HOME!, 'Library', 'Preferences', 'foo.hosted4.plist');
    writeFileSync(file, 'another slot');
    writeFileSync(join(home, 'hosted-macos-app.json'), JSON.stringify({ bundleId: id }));
    expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'unknown' });
    expect(native.quiet).not.toHaveBeenCalled();
    expect(native.runFile.mock.calls.some(([command]) => command === 'defaults')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('another slot');
    expect(existsSync(join(home, 'app-home'))).toBe(true);
    expect(existsSync(join(area, 'App.app'))).toBe(true);
    expect(existsSync(join(home, '..', 'blobs'))).toBe(true);
  },
);

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
