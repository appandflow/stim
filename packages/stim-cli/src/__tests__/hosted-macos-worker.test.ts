import type { Executor } from '../exec.ts';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
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
  hostedMacosLogsDir,
  parseHostedMacosDevice,
  parseHostedOfferRequest,
  readMacosRecord,
  type HostedMacosDevice,
} from '@stim-cli/core/state';
import { runHostedMacosApp } from '../device-host/macos.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { macosAppStderr, macosAppStdout, macosRuntimeClaim } from '../macos/state.ts';
import { makeChildProcess } from './_factories.ts';
import * as macosState from '../macos/state.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';

const native = vi.hoisted(() => ({
  runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>(),
  quiet: vi.fn<Executor['runFileQuiet']>(),
  spawn: vi.fn<Executor['spawn']>(),
  pressure: vi.fn<() => string | null>(),
  identity: vi.fn<(record: unknown) => string>(),
  stop: vi.fn<(root: string) => Promise<boolean>>(),
  stopApps: vi.fn<(area: string) => Promise<void>>(),
  launches: new Array<{ stdout: string; stderr: string; claim: { root: string } }>(),
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
vi.mock('../engine/spawn-owned.ts', () => ({
  stopOwnedProcess: async () => true,
  spawnOwned: (launch: {
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdout: string;
    stderr: string;
    claim: { root: string };
  }) => {
    native.launches.push(launch);
    const child = native.spawn(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, detached: true });
    return { pid: child.pid, processToken: 'worker', child };
  },
}));
vi.mock('../macos/stop.ts', () => ({
  stopMacosApp: (root: string) => native.stop(root),
  stopMacosAppHeld: (root: string) => native.stop(root),
  stopHostedBundleInstances: (area: string) => native.stopApps(area),
  stopMacosChildren: async () => {},
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
  native.launches = [];
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
  native.spawn.mockImplementation(() => makeChildProcess({ pid: 102 }));
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
      runId: 'hosted-initiator',
      ...(args ? { arguments: args } : {}),
      manifest: { sha256, size: manifest.length },
      state: 'installing',
      launched: null,
    }),
  );
}

test.each(['identity', 'architecture', 'platform', 'executable'])(
  'refuses incompatible macOS %s before signing or launching',
  async (failure) => {
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
  },
);

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
    realpathSync(join(bundle, 'Contents', 'MacOS', 'Fixture')),
    offeredArguments,
    expect.objectContaining({
      cwd: realpathSync(join(home, 'macos-app')),
      detached: true,
      env: expect.objectContaining({
        STIM_HOME: home,
        HOME: join(home, 'app-home'),
        CFFIXED_USER_HOME: join(home, 'app-home'),
        TMPDIR: join(home, 'app-home', 'tmp'),
      }),
    }),
  );
  const runRoot = realpathSync(join(home, 'macos-app'));
  const launchedRecord = readMacosRecord(runRoot);
  expect(launchedRecord).not.toBeNull();
  expect(native.launches).toEqual([
    expect.objectContaining({
      stdout: macosAppStdout(runRoot, launchedRecord!.launchId),
      stderr: macosAppStderr(runRoot, launchedRecord!.launchId),
      claim: expect.objectContaining({ root: macosRuntimeClaim(runRoot) }),
    }),
  ]);
  expect(hostedMacosLogsDir(home)).toBe(workspaceLogsDir(runRoot));
  expect(readMacosRecord(realpathSync(join(home, 'macos-app')))).toMatchObject({
    bundleId: `${bundleId}.hosted3`,
    arguments: offeredArguments,
    runId: 'hosted-initiator',
    build: { state: 'ok' },
  });
  expect(readFileSync(join(workspaceLogsDir(runRoot), 'macos.ndjson'), 'utf8')).toContain('"runId":"hosted-initiator"');
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
  expect(readFileSync(log, 'utf8')).toBe('app output');
});

test('an unpublished hosted app retains its launch declaration after best-effort cleanup', async () => {
  receipt();
  const update = vi.spyOn(macosState, 'updateMacosRecord').mockImplementation(() => {
    throw new Error('record write failed');
  });
  const runRoot = join(home, 'macos-app');
  let claimRoot: string | undefined;
  try {
    expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({
      state: 'unknown',
      notice: expect.stringContaining('unrecorded hosted macOS app'),
    });
    claimRoot = workspaceProcessLockPath(workspaceDir(realpathSync(runRoot)), 'macos-launch', true);
    expect(readMacosRecord(runRoot)?.app).toBeUndefined();
    expect(readClaimSet(claimRoot).live).toMatchObject([{ childDeclared: true, childPending: true }]);
    expect(tryAcquireClaim({ root: claimRoot, mode: 'exclusive' }).held).toBeDefined();
  } finally {
    update.mockRestore();
    if (claimRoot)
      for (const holder of readClaimSet(claimRoot).live) releaseClaim({ ...holder, root: claimRoot, label: 'fixture' });
  }
});

test('replacement validation leaves the previous app alone on invalid input and rematerializes valid input', async () => {
  receipt();
  plist.CFBundleIdentifier = 'different';
  expect(await runHostedMacosApp('stop-app', request, { attempt: 'app' })).toMatchObject({ state: 'unknown' });
  expect(native.stop).not.toHaveBeenCalled();
  expect(native.stopApps).not.toHaveBeenCalled();
  plist.CFBundleIdentifier = bundleId;
  expect(await runHostedMacosApp('stop-app', request, { attempt: 'app' })).toMatchObject({ state: 'stopped' });
  expect(native.stopApps).toHaveBeenCalledOnce();
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({ state: 'installed' });
});

test('stops the matching unobserved app without rematerializing a broken bundle', async () => {
  receipt();
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({ state: 'installed' });
  const runRoot = join(realpathSync(home), 'macos-app');
  const record = readMacosRecord(runRoot);
  assert(record?.app);
  rmSync(join(home, '..', 'blobs'), { recursive: true, force: true });
  native.runFile.mockClear();
  native.stop.mockClear();
  native.stopApps.mockClear();
  expect(
    await runHostedMacosApp('stop-current', {
      ...request,
      expectedApp: { pid: record.app.pid, token: record.app.processToken, launchId: record.launchId },
    }),
  ).toMatchObject({ state: 'stopped' });
  expect(native.stop).toHaveBeenCalledWith(runRoot);
  expect(native.stopApps).toHaveBeenCalledExactlyOnceWith(realpathSync(join(home, '..')));
  expect(native.runFile.mock.calls.some(([file]) => file === 'codesign' || file === 'plutil')).toBe(false);
  native.stop.mockClear();
  native.stopApps.mockClear();
  expect(
    await runHostedMacosApp('stop-current', {
      ...request,
      expectedApp: { pid: record.app.pid, token: 'wrong', launchId: record.launchId },
    }),
  ).toMatchObject({ state: 'unknown', notice: expect.stringContaining('record changed') });
  expect(native.stop).not.toHaveBeenCalled();
  expect(native.stopApps).not.toHaveBeenCalled();
  native.stopApps.mockRejectedValueOnce(new Error('bundle stop failed'));
  expect(
    await runHostedMacosApp('stop-current', {
      ...request,
      expectedApp: { pid: record.app.pid, token: record.app.processToken, launchId: record.launchId },
    }),
  ).toMatchObject({ state: 'unknown', notice: 'bundle stop failed' });
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
    NSUnbufferedIO: 'YES',
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

test('stop ends copies of the session bundles before deleting them, and keeps them when one will not stop', async () => {
  receipt();
  await runHostedMacosApp('install', request, { attempt: 'app' });
  native.stopApps.mockClear();
  native.stopApps.mockRejectedValueOnce(new Error('Copy did not exit'));
  expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'unknown', notice: 'Copy did not exit' });
  expect(existsSync(join(area, 'App.app'))).toBe(true);
  expect(existsSync(join(home, 'app-home'))).toBe(true);
  native.stopApps.mockImplementationOnce(() => {
    expect(existsSync(join(area, 'App.app'))).toBe(true);
    return Promise.resolve();
  });
  expect(await runHostedMacosApp('stop', request)).toMatchObject({ state: 'stopped' });
  expect(native.stopApps).toHaveBeenLastCalledWith(realpathSync(root));
  expect(existsSync(join(area, 'App.app'))).toBe(false);
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

test('does not record a launch whose app process cannot be verified', async () => {
  receipt();
  native.spawn.mockImplementation(() => {
    throw new Error('Could not verify the hosted macOS app process; it was stopped.');
  });
  expect(await runHostedMacosApp('install', request, { attempt: 'app' })).toMatchObject({
    state: 'unknown',
    notice: expect.stringContaining('Could not verify'),
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
