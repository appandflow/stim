import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetCreatedDevice, recordCreatedDevice } from '../devices/created-devices.ts';
import { runHostedDevice } from '../device-host/worker.ts';

const native = vi.hoisted(() => ({
  inventory: vi.fn<() => { udid: string; state: string }[]>(),
  create: vi.fn<(...args: unknown[]) => { udid: string; name: string }>(),
  boot: vi.fn<(target: string, options: { openViewer: boolean }) => void | Promise<void>>(),
  teardown: vi.fn<(target: string, options: { del: boolean }) => { status: string; reason?: string }>(),
  pressure: vi.fn<() => string | null>(),
}));
vi.mock('../host-memory.ts', () => ({ readHostMemoryPressure: () => native.pressure() }));
vi.mock('../devices/ios.ts', () => ({
  listAllIosSims: () => native.inventory(),
  resolveIosCreation: () => ({ deviceTypeId: 'iphone', runtimeId: 'ios', deviceType: 'iPhone', runtime: '27.1' }),
  createOwnedIosSim: (...args: unknown[]) => native.create(...args),
  bootIosSim: (...args: Parameters<typeof native.boot>) => native.boot(...args),
}));
vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedIosSim: (...args: Parameters<typeof native.teardown>) => native.teardown(...args),
}));
let home: string;
const udid = '12345678-1234-1234-1234-123456789abc';
let simulatorState: string;
let deleted: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  home = mkdtempSync(join(tmpdir(), 'stim-host-worker-'));
  process.env.STIM_HOME = home;
  simulatorState = 'Shutdown';
  deleted = false;
  native.inventory.mockImplementation(() => (deleted ? [] : [{ udid, state: simulatorState }]));
  native.pressure.mockReturnValue('normal');
  native.create.mockImplementation(() => {
    recordCreatedDevice('ios', udid);
    return { udid, name: 'stim-hosted' };
  });
  native.boot.mockImplementation(() => {
    simulatorState = 'Booted';
  });
  native.teardown.mockImplementation((_target, options) => {
    deleted = options.del;
    if (deleted) forgetCreatedDevice('ios', udid);
    return { status: 'torn-down' };
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('records exact ownership before boot, keeps the host viewer closed and deletes instead of parking at stop', async () => {
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
  native.teardown.mockImplementation(() => {
    simulatorState = 'Shutdown';
    return { status: 'torn-down' };
  });
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'unknown', device: { udid } });
});

test('an empty ledger cannot authorize stopping a simulator that still exists', async () => {
  await runHostedDevice('prepare', {});
  forgetCreatedDevice('ios', udid);
  expect(await runHostedDevice('stop', {})).toMatchObject({
    state: 'unknown',
    notice: expect.stringContaining('ownership ledger'),
  });
  expect(native.teardown).not.toHaveBeenCalled();
});

test('a lost deletion verification can be reconciled on the next stop after the ledger is cleared', async () => {
  await runHostedDevice('prepare', {});
  native.inventory
    .mockImplementationOnce(() => [{ udid, state: 'Booted' }])
    .mockImplementationOnce(() => {
      throw new Error('inventory unavailable after deletion');
    });
  expect(await runHostedDevice('stop', {})).toMatchObject({
    state: 'unknown',
    notice: 'inventory unavailable after deletion',
  });
  expect(await runHostedDevice('stop', {})).toMatchObject({ state: 'stopped', device: { udid } });
  expect(native.teardown).toHaveBeenCalledTimes(1);
});
