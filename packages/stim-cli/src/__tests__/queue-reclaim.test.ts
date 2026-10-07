import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeviceIdleShutdowns } from '@stim-cli/core/state';
import { collectOwnedDeviceActivity, workspaceBuildInProgress, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { setExecutor, resetExecutor } from '../exec.ts';
import { reclaimIdleDevice } from '../devices/queue-reclaim.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../devices/teardown.ts';
import { tryAcquireClaim, releaseClaim } from '../ownership-claim.ts';
import { workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

vi.mock('../commands/gc/idle.ts', () => ({
  collectOwnedDeviceActivity: vi.fn<typeof import('../commands/gc/idle.ts').collectOwnedDeviceActivity>(),
  workspaceBuildInProgress: vi.fn<typeof import('../commands/gc/idle.ts').workspaceBuildInProgress>(() => false),
}));
vi.mock('../devices/ios.ts', async (original) => ({
  ...(await original<typeof import('../devices/ios.ts')>()),
  listAllIosSims: () => [],
}));
vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedIosSim: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedIosSim>(),
  teardownOwnedAvd: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedAvd>(),
}));

const NOW = Date.parse('2026-10-07T12:00:00Z');
const MINUTE = 60_000;
let home: string;
let waiter: string;
let devices: OwnedDeviceActivity[];
let skipped: Set<string>;
let out: ReturnType<typeof vi.fn<(line: string) => void>>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-reclaim-')));
  process.env.STIM_HOME = home;
  waiter = join(home, 'waiter');
  mkdirSync(waiter);
  devices = [];
  skipped = new Set();
  out = vi.fn<(line: string) => void>();
  vi.mocked(workspaceBuildInProgress).mockReset().mockReturnValue(false);
  vi.mocked(collectOwnedDeviceActivity)
    .mockReset()
    .mockImplementation((config) => devices.filter((device) => Boolean(config?.projects[device.project])));
  vi.mocked(teardownOwnedIosSim)
    .mockReset()
    .mockImplementation((id) => {
      devices = devices.filter((device) => device.id !== id);
      return { status: 'torn-down', label: `stim-${id}` };
    });
});
afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function add(id: string, idleMinutes: number, root = join(home, id)): OwnedDeviceActivity {
  mkdirSync(root, { recursive: true });
  upsertProject(root, { label: id, platforms: { ios: { deviceUdid: id, owned: true } } });
  const device: OwnedDeviceActivity = {
    kind: 'ios',
    id,
    name: `stim-${id}`,
    project: root,
    slot: 'default',
    activity: {
      state: 'idle',
      basis: ['workspace-use'],
      lastActivityAt: new Date(NOW - idleMinutes * MINUTE).toISOString(),
    },
  };
  devices.push(device);
  return device;
}
const reclaim = () => reclaimIdleDevice(waiter, 10 * MINUTE, out, () => NOW, skipped);

test('reclaims exactly the longest-idle eligible device across workspaces and records the reason and log', async () => {
  add('younger', 14);
  const oldest = add('oldest', 25);
  add('own', 90, waiter);
  const alias = join(home, 'alias');
  symlinkSync(waiter, alias, process.platform === 'win32' ? 'junction' : 'dir');
  add('own-alias', 100, alias);
  await expect(reclaim()).resolves.toBe(1);
  expect(teardownOwnedIosSim).toHaveBeenCalledTimes(1);
  expect(teardownOwnedIosSim).toHaveBeenCalledWith('oldest', { label: 'stim-oldest', workspace: oldest.project });
  expect(readDeviceIdleShutdowns(readWorkspaceState(oldest.project))).toEqual({
    ios: { at: new Date(NOW).toISOString(), idleMinutes: 25, reason: 'reclaimed for a waiting run' },
  });
  expect(out).toHaveBeenCalledWith(
    'device      reclaimed iOS simulator stim-oldest (workspace oldest, idle 25m) for this waiting run',
  );
  const entries = readFileSync(join(workspaceLogsDir(oldest.project), 'metro.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(entries).toMatchObject([
    { event: 'device_idle_shutdown', msg: expect.stringContaining('reclaimed for a waiting run') },
  ]);
});

test('driven, locked, building, viewed, recent and unavailable-workspace devices stay up', async () => {
  for (const basis of ['driver-process', 'device-lock', 'agent-device-lease']) {
    const device = add(basis, 90);
    device.activity = { ...device.activity, state: 'driven', basis: [basis] };
  }
  const unknown = add('unknown', 90);
  unknown.activity = { ...unknown.activity, state: 'unknown', basis: ['agent-device-claim'] };
  const viewed = add('viewed', 90);
  viewed.activity = { state: 'active', lastActivityAt: new Date(NOW).toISOString(), basis: ['viewer'] };
  const building = add('building', 90);
  vi.mocked(workspaceBuildInProgress).mockImplementation((root) => root === building.project);
  add('recent', 9);
  const unavailable = add('unavailable', 90);
  rmSync(unavailable.project, { recursive: true });
  await expect(reclaim()).resolves.toBe(0);
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
});

test('a live native-run lock is skipped, and a later poll tries the next candidate', async () => {
  const locked = add('locked', 40);
  const next = add('next', 20);
  const attempt = tryAcquireClaim({
    root: workspaceProcessLockPath(workspaceDir(locked.project), 'native-run', true),
    mode: 'exclusive',
    label: 'native run',
  });
  if (!attempt.acquired) throw new Error('fixture lock unavailable');
  try {
    await expect(reclaim()).resolves.toBe(0);
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledWith(expect.stringContaining('could not reclaim stim-locked'));
    await expect(reclaim()).resolves.toBe(1);
    expect(teardownOwnedIosSim).toHaveBeenCalledWith('next', { label: 'stim-next', workspace: next.project });
  } finally {
    releaseClaim(attempt.acquired);
  }
});

test('activity is rechecked after locking, so a newly opened viewer prevents reclaim', async () => {
  const device = add('viewed', 40);
  vi.mocked(collectOwnedDeviceActivity)
    .mockImplementationOnce(() => [device])
    .mockImplementation(() => [
      {
        ...device,
        activity: { state: 'active', lastActivityAt: new Date(NOW).toISOString(), basis: ['viewer'] },
      },
    ]);
  await expect(reclaim()).resolves.toBe(0);
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
  expect(readDeviceIdleShutdowns(readWorkspaceState(device.project))).toEqual({});
});

test('ownership refusal and teardown errors leave no shutdown record and do not fail the waiter', async () => {
  const refused = add('refused', 40);
  const failed = add('failed', 20);
  vi.mocked(teardownOwnedIosSim)
    .mockReturnValueOnce({
      status: 'skipped',
      kind: 'not-owned',
      reason: 'simulator ownership changed before shutdown',
    })
    .mockImplementationOnce(() => {
      throw new Error('shutdown failed');
    });
  await expect(reclaim()).resolves.toBe(0);
  await expect(reclaim()).resolves.toBe(0);
  expect(readDeviceIdleShutdowns(readWorkspaceState(refused.project))).toEqual({});
  expect(readDeviceIdleShutdowns(readWorkspaceState(failed.project))).toEqual({});
  expect(out).toHaveBeenCalledWith(expect.stringContaining('ownership changed'));
  expect(out).toHaveBeenCalledWith(expect.stringContaining('shutdown failed'));
});

test('an older Android device in a named slot is shut down and recorded in its target slot', async () => {
  add('ios', 20);
  const android = add('android', 40);
  android.kind = 'android';
  android.slot = 'fold';
  upsertProject(android.project, {
    platforms: {},
    deviceSlots: { fold: { android: { avdName: android.id, owned: true } } },
  });
  vi.mocked(teardownOwnedAvd).mockReturnValueOnce({ status: 'torn-down', label: android.name });
  await expect(reclaim()).resolves.toBe(1);
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
  expect(teardownOwnedAvd).toHaveBeenCalledWith(android.id, {
    owner: { projectPath: android.project, slot: 'fold' },
    workspace: android.project,
  });
  expect(readDeviceIdleShutdowns(readWorkspaceState(android.project))).toMatchObject({
    'android:fold': { reason: 'reclaimed for a waiting run', idleMinutes: 40 },
  });
});

test('central teardown re-resolves ownership after selection and refuses a device this home no longer owns', async () => {
  const device = add('lost', 40);
  const actual = await vi.importActual<typeof import('../devices/teardown.ts')>('../devices/teardown.ts');
  vi.mocked(teardownOwnedIosSim).mockImplementation(actual.teardownOwnedIosSim);
  vi.mocked(collectOwnedDeviceActivity)
    .mockImplementationOnce(() => [device])
    .mockImplementation(() => {
      upsertProject(device.project, { platforms: { ios: { deviceUdid: device.id, owned: false } } });
      return [device];
    });
  const destructive = vi.fn<() => never>(() => {
    throw new Error('unowned device must not be touched');
  });
  setExecutor({
    run: destructive,
    runQuiet: destructive,
    runFile: () =>
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
            {
              udid: device.id,
              name: device.name,
              state: 'Booted',
              isAvailable: true,
              deviceTypeIdentifier: 'iphone',
            },
          ],
        },
      }),
  });
  await expect(reclaim()).resolves.toBe(0);
  expect(destructive).not.toHaveBeenCalled();
  expect(readDeviceIdleShutdowns(readWorkspaceState(device.project))).toEqual({});
  expect(out).toHaveBeenCalledWith(expect.stringContaining('not Stim-owned'));
});
