import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { runHostedDevice } from '../device-host/worker.ts';

const native = vi.hoisted(() => ({
  inventory: vi.fn<() => { udid: string; state: string; name: string; available: boolean }[]>(),
  create: vi.fn<(...args: unknown[]) => { udid: string; name: string }>(),
  boot: vi.fn<(target: string, options: { openViewer: boolean }) => void | Promise<void>>(),
  teardown: vi.fn<(target: string, options?: { del: boolean }) => { status: string; reason?: string }>(),
  privacy: vi.fn<() => void>(),
  keychain: vi.fn<() => void>(),
  apps: vi.fn<() => string[]>(),
  uninstall: vi.fn<(udid: string, bundleId: string) => void>(),
  choice: vi.fn<() => { deviceTypeId: string; runtimeId: string; deviceType: string; runtime: string }>(),
  pressure: vi.fn<() => string | null>(),
}));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => native.pressure() }));
vi.mock('../devices/ios.ts', () => ({
  listAllIosSims: () => native.inventory(),
  resolveIosCreation: () => native.choice(),
  resetIosPrivacy: () => native.privacy(),
  resetIosKeychain: () => native.keychain(),
  listUserApps: () => native.apps(),
  uninstallIosApp: (udid: string, bundleId: string) => native.uninstall(udid, bundleId),
  createOwnedIosSim: (...args: unknown[]) => native.create(...args),
  bootIosSim: (...args: Parameters<typeof native.boot>) => native.boot(...args),
}));
vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedIosSim: (...args: Parameters<typeof native.teardown>) => native.teardown(...args),
}));
let home: string;
let area: string;
const udid = '12345678-1234-1234-1234-123456789abc';
let simulatorState: string | null;

beforeEach(() => {
  vi.resetAllMocks();
  area = mkdtempSync(join(tmpdir(), 'stim-host-worker-'));
  home = join(area, 'home');
  mkdirSync(home);
  process.env.STIM_HOME = home;
  simulatorState = 'Shutdown';
  native.inventory.mockImplementation(() =>
    simulatorState ? [{ udid, name: 'stim-hosted', state: simulatorState, available: true }] : [],
  );
  native.pressure.mockReturnValue('normal');
  native.choice.mockReturnValue({ deviceTypeId: 'iphone', runtimeId: 'ios', deviceType: 'iPhone', runtime: '27.1' });
  native.create.mockImplementation(() => {
    recordCreatedDevice('ios', udid);
    return { udid, name: 'stim-hosted' };
  });
  native.boot.mockImplementation(() => {
    simulatorState = 'Booted';
  });
  native.teardown.mockImplementation(() => {
    simulatorState = null;
    forgetCreatedDevice('ios', udid);
    return { status: 'torn-down' };
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(area, { recursive: true, force: true });
});

test('records exact ownership before boot, keeps the host viewer closed and verifies retirement', async () => {
  native.boot.mockImplementation((target, options) => {
    expect(target).toBe(udid);
    expect(options).toEqual({ openViewer: false });
    expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).ios).toEqual([udid]);
    simulatorState = 'Booted';
  });
  expect(await runHostedDevice('prepare', {})).toMatchObject({ state: 'ready', device: { udid } });
  expect(await runHostedDevice('prepare', {})).toMatchObject({ state: 'unknown' });
  expect(native.create).toHaveBeenCalledTimes(1);
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'stopped', device: { udid } });
  expect(native.teardown).toHaveBeenCalledExactlyOnceWith(udid, { del: true });
});

test.each(['inventory', 'memory'])('refuses unknown or unsafe %s before creation', async (failure) => {
  if (failure === 'inventory')
    native.inventory.mockImplementation(() => {
      throw new Error('bad inventory');
    });
  if (failure === 'memory') native.pressure.mockReturnValue(null);
  expect(await runHostedDevice('prepare', {})).toMatchObject({ state: 'stopped', device: null });
  expect(native.create).not.toHaveBeenCalled();
});

test('retains a lost creation outcome and refuses missing or foreign ledger ownership on stop', async () => {
  native.create.mockImplementation(() => {
    recordCreatedDevice('ios', udid);
    throw new Error('lost create reply');
  });
  expect(await runHostedDevice('prepare', {})).toMatchObject({ state: 'unknown' });
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'unknown' });
  expect(native.teardown).not.toHaveBeenCalled();
  rmSync(join(home, 'created-devices.json'));
  native.create.mockImplementation(() => {
    recordCreatedDevice('ios', udid);
    return { udid, name: 'stim-hosted' };
  });
  await runHostedDevice('prepare', {});
  writeFileSync(
    join(home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: ['foreign'], android: [], web: [] }),
  );
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'unknown' });
  expect(native.teardown).not.toHaveBeenCalled();
});

test('never reports ready or stopped from command success without matching device state', async () => {
  native.boot.mockResolvedValue(undefined);
  expect(await runHostedDevice('prepare', {})).toMatchObject({ state: 'unknown', device: { udid } });
  simulatorState = 'Booted';
  native.teardown.mockReturnValue({ status: 'torn-down' });
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'unknown', device: { udid } });
  expect(await runHostedDevice('park', {})).toMatchObject({ state: 'unknown', device: { udid } });
});

test('a deleted simulator with an empty ledger can complete stop after a lost reply', async () => {
  await runHostedDevice('prepare', {});
  await runHostedDevice('stop', {});
  native.teardown.mockClear();
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'stopped', device: { udid } });
  expect(native.teardown).not.toHaveBeenCalled();
});

test('an empty ledger cannot authorize deletion of a simulator still in inventory', async () => {
  await runHostedDevice('prepare', {});
  forgetCreatedDevice('ios', udid);
  simulatorState = 'Shutdown';
  expect(await runHostedDevice('stop', {})).toMatchObject({
    state: 'unknown',
    device: { udid },
    notice: expect.stringContaining('without ledger ownership'),
  });
  expect(native.teardown).not.toHaveBeenCalled();
});

test('shutdown success cannot report stopped while the simulator still exists', async () => {
  await runHostedDevice('prepare', {});
  native.teardown.mockImplementation(() => {
    simulatorState = 'Shutdown';
    return { status: 'torn-down' };
  });
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'unknown', device: { udid } });
});

test.each(['failed', 'skipped'])(
  'a %s teardown cannot report retirement even if inventory is empty',
  async (status) => {
    await runHostedDevice('prepare', {});
    simulatorState = null;
    native.teardown.mockReturnValue({ status });
    expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'unknown', device: { udid } });
  },
);

test('stop skips stray files and removes app data while retaining receipts and native logs', async () => {
  await runHostedDevice('prepare', {});
  const blobs = join(area, 'blobs');
  const bundle = join(area, 'apps', 'first', 'App.app');
  const legacy = join(area, 'apps', 'first', 'blobs');
  for (const path of [blobs, bundle, legacy, join(home, 'ios-logs')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(blobs, 'digest'), 'app bytes');
  writeFileSync(join(bundle, 'binary'), 'installed bytes');
  writeFileSync(join(area, 'apps', 'stray-file'), 'unrelated bytes');
  symlinkSync(join(area, 'missing'), join(area, 'apps', 'dangling-link'));
  writeFileSync(join(area, 'apps', 'first', 'receipt.json'), '{}');
  writeFileSync(join(home, 'ios-logs', 'device.ndjson'), 'native logs');
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'stopped' });
  expect([blobs, bundle, legacy].map(existsSync)).toEqual([false, false, false]);
  expect(readFileSync(join(area, 'apps', 'first', 'receipt.json'), 'utf8')).toBe('{}');
  expect(readFileSync(join(area, 'apps', 'stray-file'), 'utf8')).toBe('unrelated bytes');
  expect(lstatSync(join(area, 'apps', 'dangling-link')).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(home, 'ios-logs', 'device.ndjson'), 'utf8')).toBe('native logs');
});

async function parkedSimulator() {
  await runHostedDevice('prepare', {});
  native.teardown.mockImplementation(() => {
    simulatorState = 'Shutdown';
    return { status: 'torn-down' };
  });
  return runHostedDevice('park', {});
}

test('park shuts down without deleting, renaming or moving ledger ownership and keeps the session blob store but removes app copies', async () => {
  mkdirSync(join(area, 'blobs'));
  mkdirSync(join(area, 'apps', 'first', 'App.app'), { recursive: true });
  expect(await parkedSimulator()).toMatchObject({ state: 'parked', device: { udid, name: 'stim-hosted' } });
  expect(native.teardown).toHaveBeenCalledExactlyOnceWith(udid);
  expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).ios).toEqual([udid]);
  expect(simulatorState).toBe('Shutdown');
  expect(existsSync(join(area, 'blobs'))).toBe(true);
  expect(existsSync(join(area, 'apps', 'first', 'App.app'))).toBe(false);
  expect(existsSync(join(home, 'config.json'))).toBe(false);
});

test('inspect keeps compatible and incompatible simulators shut down without resetting them', async () => {
  await parkedSimulator();
  native.boot.mockClear();
  expect(await runHostedDevice('inspect', {})).toMatchObject({ state: 'compatible' });
  native.choice.mockReturnValue({ deviceTypeId: 'tablet', runtimeId: 'ios', deviceType: 'iPad', runtime: '27.1' });
  expect(await runHostedDevice('inspect', { deviceType: 'iPad' })).toMatchObject({ state: 'incompatible' });
  expect(simulatorState).toBe('Shutdown');
  expect(native.boot).not.toHaveBeenCalled();
  expect(native.privacy).not.toHaveBeenCalled();
});

test.each(['ledger', 'missing', 'renamed', 'running', 'unavailable'])(
  'inspect refuses an unusable simulator: %s',
  async (failure) => {
    await parkedSimulator();
    if (failure === 'ledger') forgetCreatedDevice('ios', udid);
    if (failure === 'missing') simulatorState = null;
    if (failure === 'running') simulatorState = 'Booted';
    if (failure === 'unavailable')
      native.inventory.mockReturnValue([{ udid, name: 'stim-hosted', state: 'Shutdown', available: false }]);
    if (failure === 'renamed')
      native.inventory.mockReturnValue([{ udid, name: 'foreign', state: 'Shutdown', available: true }]);
    expect(await runHostedDevice('inspect', {})).toMatchObject({ state: 'unusable', notice: expect.any(String) });
  },
);

test('adoption removes every third-party app before ready and clears hosted delivery data', async () => {
  await parkedSimulator();
  const apps = new Set(['com.example.old', 'com.example.other']);
  native.apps.mockImplementation(() => [...apps]);
  native.uninstall.mockImplementation((_udid, bundleId) => {
    apps.delete(bundleId);
  });
  mkdirSync(join(area, 'blobs'));
  expect(await runHostedDevice('adopt', {})).toMatchObject({ state: 'ready', device: { udid } });
  expect([...apps]).toEqual([]);
  expect(native.privacy).toHaveBeenCalledOnce();
  expect(native.keychain).toHaveBeenCalledOnce();
  expect(existsSync(join(area, 'blobs'))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, 'hosted-device.json'), 'utf8')).udid).toBe(udid);
});

test('an adoption that cannot list apps retains an unknown owned device for explicit stop', async () => {
  await parkedSimulator();
  native.apps.mockImplementation(() => {
    throw new Error('apps unavailable');
  });
  expect(await runHostedDevice('adopt', {})).toMatchObject({ state: 'unknown', device: { udid } });
  expect(JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8')).ios).toEqual([udid]);
});

test('unavailable requested selectors leave a healthy parked simulator incompatible', async () => {
  await parkedSimulator();
  native.choice.mockImplementation(() => {
    throw new Error('requested runtime unavailable');
  });
  expect(await runHostedDevice('inspect', { runtime: '99' })).toMatchObject({ state: 'incompatible' });
  expect(simulatorState).toBe('Shutdown');
});

test('a parked simulator of another architecture is incompatible even with the same model and runtime', async () => {
  await parkedSimulator();
  const path = join(home, 'hosted-device.json');
  const device = JSON.parse(readFileSync(path, 'utf8'));
  device.architecture = device.architecture === 'arm64' ? 'x86_64' : 'arm64';
  writeFileSync(path, JSON.stringify(device));
  expect(await runHostedDevice('inspect', {})).toMatchObject({ state: 'incompatible' });
});
