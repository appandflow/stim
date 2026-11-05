import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERACTIONS_KEY, readDeferredShutdowns, readDeviceIdleShutdowns } from '@stim-cli/core/state';
import { processContext } from '../cli-operation.ts';
import {
  collectOwnedDeviceActivityAsync,
  workspaceBuildInProgress,
  type OwnedDeviceActivity,
} from '../commands/gc/idle.ts';
import { resetExecutor } from '../exec.ts';
import { reclaimForBootWaiters } from '../daemon/reclaim.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { recordDeferredShutdown } from '../devices/deferred-shutdown.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { shutDownBootedParkedIosSim, teardownOwnedIosSim, teardownOwnedAvd } from '../devices/teardown.ts';
import { parkSim } from '../devices/sim-pool.ts';
import { tryAcquireClaim, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { liveWaiters, takeWaitTicket } from '../engine/wait-queue.ts';
import { workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { serveShareList, shareRow } from './_share-list-server.ts';

vi.mock('../commands/gc/idle.ts', () => ({
  collectOwnedDeviceActivityAsync: vi.fn<typeof import('../commands/gc/idle.ts').collectOwnedDeviceActivityAsync>(),
  workspaceBuildInProgress: vi.fn<typeof import('../commands/gc/idle.ts').workspaceBuildInProgress>(() => false),
}));
vi.mock('../devices/ios.ts', async (original) => ({
  ...(await original<typeof import('../devices/ios.ts')>()),
  listAllIosSimsAsync: async () => [],
}));
vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedIosSim: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedIosSim>(),
  teardownOwnedAvd: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedAvd>(),
  shutDownBootedParkedIosSim: vi.fn<typeof import('../devices/teardown.ts').shutDownBootedParkedIosSim>(),
}));

const NOW = Date.parse('2026-10-07T12:00:00Z');
const MINUTE = 60_000;
let home: string;
let waiter: string;
let devices: OwnedDeviceActivity[];
let otherSims: IosSimRecord[];
let ticket: ClaimHandle | undefined;
let operation: ReturnType<typeof processContext>;
const log = vi.fn<(level: string, event: string, msg: string) => void>();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-reclaim-')));
  process.env.STIM_HOME = home;
  waiter = join(home, 'waiter');
  operation = processContext(home);
  mkdirSync(waiter);
  devices = [];
  otherSims = [];
  log.mockReset();
  vi.setSystemTime(NOW);
  process.env.STIM_MAX_DEVICES = '2';
  ticket = takeWaitTicket('boot', { platform: 'ios', key: 'new', root: waiter, displayName: 'waiter' }, []);
  vi.mocked(workspaceBuildInProgress).mockReset().mockReturnValue(false);
  vi.mocked(collectOwnedDeviceActivityAsync)
    .mockReset()
    .mockImplementation(async (config) => devices.filter((device) => Boolean(config?.projects[device.project])));
  vi.mocked(teardownOwnedIosSim)
    .mockReset()
    .mockImplementation(async (id) => {
      devices = devices.filter((device) => device.id !== id);
      return { status: 'torn-down', label: `stim-${id}` };
    });
});
afterEach(() => {
  releaseClaim(ticket);
  delete process.env.STIM_MAX_DEVICES;
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function bootedSim(udid: string, name: string): IosSimRecord {
  return { udid, name, state: 'Booted', runtime: 'iOS 27.0', deviceTypeIdentifier: 'iPhone', available: true };
}

function add(id: string, idleMinutes: number, root = join(home, id), owned = true): OwnedDeviceActivity {
  mkdirSync(root, { recursive: true });
  if (owned) recordCreatedDevice('ios', id);
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
const reclaim = (act = true) =>
  reclaimForBootWaiters({
    devices,
    operation,
    sims: [
      ...devices.filter((device) => device.kind === 'ios').map((device) => bootedSim(device.id, device.name)),
      ...otherSims,
    ],
    act,
    log,
    now: NOW,
  });

test('shuts a parked simulator kept booted down before any workspace device, however long that one idled', async () => {
  add('idle', 90);
  upsertProject(join(home, 'parker'), { platforms: { ios: { deviceUdid: 'PARKED', owned: true } } });
  parkSim({
    platform: 'ios',
    projectPath: join(home, 'parker'),
    max: 3,
    record: {
      udid: 'PARKED',
      name: 'stim-parked (iPhone) park',
      deviceTypeIdentifier: 'iPhone',
      runtimeIdentifier: 'iOS 27.0',
      parkedAt: new Date(NOW - MINUTE).toISOString(),
      bootedUntil: new Date(NOW + 10 * MINUTE).toISOString(),
      simslimManaged: false,
    },
  });
  otherSims.push(bootedSim('PARKED', 'stim-parked (iPhone) park'));
  vi.mocked(shutDownBootedParkedIosSim).mockResolvedValue({ status: 'torn-down', label: 'stim-parked' });
  await expect(reclaim()).resolves.toMatchObject({ kind: 'reclaim-device', target: 'PARKED', outcome: 'done' });
  expect(shutDownBootedParkedIosSim).toHaveBeenCalledWith('PARKED', expect.objectContaining({ operation }));
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
});

test('shuts a simulator that stop left booted down before any workspace device, however recently its workspace stopped', async () => {
  add('idle', 90);
  const stopped = add('stopped', 1);
  await recordDeferredShutdown(stopped.project, 'default', {
    udid: 'stopped',
    until: new Date(NOW + 10 * MINUTE).toISOString(),
  });
  await expect(reclaim()).resolves.toMatchObject({ kind: 'reclaim-device', target: 'stopped', outcome: 'done' });
  expect(teardownOwnedIosSim).toHaveBeenCalledTimes(1);
  expect(teardownOwnedIosSim).toHaveBeenCalledWith('stopped', expect.objectContaining({ workspace: stopped.project }));
  expect(readDeferredShutdowns(readWorkspaceState(stopped.project))).toEqual({});
});

test('shuts down exactly the longest-idle device of another workspace and records the reason and log', async () => {
  add('younger', 4);
  const oldest = add('oldest', 25);
  add('own', 90, waiter);
  const alias = join(home, 'alias');
  symlinkSync(waiter, alias, process.platform === 'win32' ? 'junction' : 'dir');
  add('own-alias', 100, alias);
  await expect(reclaim()).resolves.toMatchObject({ kind: 'reclaim-device', target: 'oldest', outcome: 'done' });
  expect(teardownOwnedIosSim).toHaveBeenCalledTimes(1);
  expect(teardownOwnedIosSim).toHaveBeenCalledWith('oldest', {
    label: 'stim-oldest',
    workspace: oldest.project,
    operation,
  });
  expect(readDeviceIdleShutdowns(readWorkspaceState(oldest.project))).toEqual({
    ios: { at: new Date(NOW).toISOString(), idleMinutes: 25, reason: 'reclaimed for a waiting run' },
  });
  const entries = readFileSync(join(workspaceLogsDir(oldest.project), 'metro.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(entries).toMatchObject([
    { event: 'device_idle_shutdown', msg: expect.stringContaining('reclaimed for a waiting run') },
  ]);
});

test('a device idle under 2 minutes, or one the caps leave room for, is never shut down', async () => {
  add('fresh', 1);
  add('also-fresh', 1);
  await expect(reclaim()).resolves.toBeNull();
  process.env.STIM_MAX_DEVICES = '3';
  devices = [];
  add('idle', 30);
  add('other', 30);
  await expect(reclaim()).resolves.toBeNull();
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
});

test('a device of another Stim home counts toward the cap, and only a device this home created is reclaimed', async () => {
  otherSims = [bootedSim('foreign', 'stim-foreign')];
  add('unledgered', 60, undefined, false);
  const mine = add('mine', 30);
  devices = devices.filter((device) => device.id !== 'unledgered');
  await expect(reclaim()).resolves.toMatchObject({ target: 'mine', outcome: 'done' });
  expect(teardownOwnedIosSim).toHaveBeenCalledWith('mine', { label: 'stim-mine', workspace: mine.project, operation });

  vi.mocked(teardownOwnedIosSim).mockClear();
  otherSims = [];
  add('unledgered-2', 60, undefined, false);
  add('mine-2', 30);
  await expect(reclaim()).resolves.toMatchObject({ target: 'mine-2', outcome: 'done' });
  expect(teardownOwnedIosSim).not.toHaveBeenCalledWith('unledgered-2', expect.anything());
});

test.skipIf(process.platform === 'win32')(
  'a device whose workspace has a live web share is never reclaimed, and the waiting run stays queued',
  async () => {
    const shared = add('shared', 30);
    add('fresh', 1);
    const server = await serveShareList(() => ({
      shares: [shareRow(shared.project, new Date(NOW + 30 * MINUTE).toISOString())],
    }));
    onTestFinished(() => server.close());

    await expect(reclaim()).resolves.toBeNull();
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
    expect(devices.map((device) => device.id)).toContain('shared');
    expect(liveWaiters('boot').map((holder) => holder.claimId)).toEqual([ticket?.claimId]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a share that goes live before the workspace lock is taken keeps the device, named in the kept action',
  async () => {
    const shared = add('shared', 30);
    add('fresh', 1);
    const expiresAt = new Date(NOW + 30 * MINUTE).toISOString();
    let reads = 0;
    const server = await serveShareList(() => ({ shares: reads++ === 0 ? [] : [shareRow(shared.project, expiresAt)] }));
    onTestFinished(() => server.close());

    await expect(reclaim()).resolves.toMatchObject({
      target: 'shared',
      outcome: 'kept',
      detail: `kept iOS simulator stim-shared: it has a live web share (ios until ${expiresAt}); stim share stop ends it`,
    });
    expect(reads).toBe(2);
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'warn',
      'device_reclaim_kept',
      expect.stringContaining('live web share'),
      expect.anything(),
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'a share list stim-server cannot give reclaims nothing and says why',
  async () => {
    add('idle', 30);
    add('other', 40);
    const server = await serveShareList(() => ({ error: { code: 'internal', message: 'The share hub is closing.' } }));
    onTestFinished(() => server.close());

    await expect(reclaim()).resolves.toBeNull();
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'warn',
      'device_reclaim_kept',
      "no device reclaimed for a waiting run: this home's web shares cannot be listed (The share hub is closing)",
    );
  },
);

test('a failed simulator listing reclaims nothing', async () => {
  add('idle', 30);
  add('other', 40);
  await expect(reclaimForBootWaiters({ devices, sims: null, act: true, log, operation, now: NOW })).resolves.toBeNull();
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
});

test('with no run waiting, nothing is reclaimed', async () => {
  releaseClaim(ticket);
  ticket = undefined;
  add('idle', 30);
  add('other', 40);
  await expect(reclaim()).resolves.toBeNull();
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
});

test('daemon.mode report logs the device it would reclaim and shuts nothing down', async () => {
  add('idle', 30);
  add('other', 40);
  await expect(reclaim(false)).resolves.toMatchObject({ target: 'other', outcome: 'would' });
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    'info',
    'device_would_reclaim',
    expect.stringContaining('stim-other'),
    expect.anything(),
  );
});

test('a full platform cap reclaims only a device of that platform', async () => {
  process.env.STIM_MAX_DEVICES = '8';
  process.env.STIM_MAX_IOS_DEVICES = '1';
  try {
    add('ios-young', 20);
    const android = add('android-old', 60);
    android.kind = 'android';
    await expect(reclaim()).resolves.toMatchObject({ target: 'ios-young', outcome: 'done' });
    expect(teardownOwnedAvd).not.toHaveBeenCalled();
  } finally {
    delete process.env.STIM_MAX_IOS_DEVICES;
  }
});

test('a live native-run lock keeps the device, and the next tick takes the next candidate', async () => {
  const locked = add('locked', 40);
  const next = add('next', 20);
  const attempt = tryAcquireClaim({
    root: workspaceProcessLockPath(workspaceDir(locked.project), 'native-run', true),
    mode: 'exclusive',
    label: 'native run',
  });
  if (!attempt.acquired) throw new Error('fixture lock unavailable');
  try {
    await expect(reclaim()).resolves.toMatchObject({ target: 'locked', outcome: 'kept' });
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
    devices = devices.filter((device) => device !== locked);
    process.env.STIM_MAX_DEVICES = '1';
    await expect(reclaim()).resolves.toMatchObject({ target: 'next', outcome: 'done' });
    expect(teardownOwnedIosSim).toHaveBeenCalledWith('next', {
      label: 'stim-next',
      workspace: next.project,
      operation,
    });
  } finally {
    releaseClaim(attempt.acquired);
  }
});

test('recent use of its Simulator window prevents reclaim', async () => {
  const device = add('window', 40);
  add('busy', 1);
  writeWorkspaceState(device.project, { [INTERACTIONS_KEY]: { ios: new Date(NOW).toISOString() } });
  await expect(reclaim()).resolves.toBeNull();
  expect(teardownOwnedIosSim).not.toHaveBeenCalled();
});

test('a recent client log does not prevent reclaim', async () => {
  const device = add('client', 40);
  add('busy', 1);
  const logFile = join(workspaceLogsDir(device.project), 'client.ndjson');
  mkdirSync(workspaceLogsDir(device.project), { recursive: true });
  writeFileSync(logFile, '{}\n');
  utimesSync(logFile, NOW / 1000, NOW / 1000);
  await expect(reclaim()).resolves.toMatchObject({ target: 'client', outcome: 'done' });
});
