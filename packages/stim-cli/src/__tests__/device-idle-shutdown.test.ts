import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_IDLE_SHUTDOWN_KEY, readDeviceIdleShutdowns, type DeviceActivity } from '@stim-cli/core/state';
import { clearDeviceIdleShutdown, idleShutdownDueMs, shutDownIdleDevices } from '../devices/idle-shutdown.ts';
import { teardownOwnedIosSim } from '../devices/teardown.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { upsertProject } from '../workspace/config.ts';

vi.mock('../devices/teardown.ts', () => ({
  teardownOwnedIosSim: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedIosSim>(),
  teardownOwnedAvd: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedAvd>(),
}));
vi.mock('../devices/ios.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../devices/ios.ts')>()),
  listAllIosSims: () =>
    ['MINE', 'OTHER'].map((udid) => ({
      udid,
      name: `stim-${udid}`,
      state: 'Booted',
      runtime: 'iOS 27.0',
      deviceTypeIdentifier: 'iPhone',
      available: true,
    })),
}));
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const MINUTE = 60_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const due = (activity: DeviceActivity, buildInProgress = false) =>
  idleShutdownDueMs(activity, {
    idleMs: 2 * MINUTE,
    now: NOW,
    buildInProgress,
  });

describe('idleShutdownDueMs', () => {
  test('a device with no activity for the threshold is due, one used more recently is not', () => {
    expect(
      due({
        state: 'active',
        lastActivityAt: at(2 * MINUTE),
        basis: ['workspace-use'],
      }),
    ).toBe(2 * MINUTE);
    expect(
      due({
        state: 'idle',
        lastActivityAt: at(3 * 3_600_000),
        basis: ['device-log'],
      }),
    ).toBe(3 * 3_600_000);
    expect(
      due({
        state: 'active',
        lastActivityAt: at(2 * MINUTE - 1),
        basis: ['device-log'],
      }),
    ).toBe(null);
  });

  test('an open viewer is activity now, so the device stays up', () => {
    expect(
      due({
        state: 'active',
        lastActivityAt: at(0),
        recent: { viewer: at(0) },
        basis: ['viewer'],
      }),
    ).toBe(null);
  });

  test('a driver, a Stim or agent-device lock, or unreadable evidence keeps an old device up', () => {
    const old = at(5 * 3_600_000);
    const driven = (tool: string, basis: string): DeviceActivity => ({
      state: 'driven',
      driver: { tool, pid: null, since: old },
      lastActivityAt: old,
      basis: [basis],
    });
    expect(due(driven('agent-device', 'agent-device-lease'))).toBe(null);
    expect(due(driven('stim device lock', 'device-lock'))).toBe(null);
    expect(due(driven('maestro', 'driver-process'))).toBe(null);
    expect(
      due({
        state: 'unknown',
        lastActivityAt: old,
        basis: ['agent-device-claim'],
      }),
    ).toBe(null);
  });

  test('a build in the workspace keeps an old device up', () => {
    expect(
      due(
        {
          state: 'idle',
          lastActivityAt: at(5 * 3_600_000),
          basis: ['device-log'],
        },
        true,
      ),
    ).toBe(null);
  });

  test('on Windows, the missing ps probe alone does not keep a device up', () => {
    const activity: DeviceActivity = {
      state: 'unknown',
      lastActivityAt: at(5 * MINUTE),
      basis: ['driver-process'],
    };
    const opts = { idleMs: 2 * MINUTE, now: NOW, buildInProgress: false };
    expect(idleShutdownDueMs(activity, { ...opts, platform: 'win32' })).toBe(5 * MINUTE);
    expect(idleShutdownDueMs(activity, { ...opts, platform: 'darwin' })).toBe(null);
    expect(
      idleShutdownDueMs({ ...activity, basis: ['driver-process', 'instrumentation'] }, { ...opts, platform: 'win32' }),
    ).toBe(null);
  });

  test('a device with no dated activity cannot be proven idle', () => {
    expect(due({ state: 'idle', basis: [] })).toBe(null);
  });
});

describe('clearDeviceIdleShutdown', () => {
  let stimHome: string;

  beforeEach(() => {
    stimHome = mkdtempSync(join(tmpdir(), 'stim-idle-shutdown-'));
    process.env.STIM_HOME = stimHome;
  });

  afterEach(() => {
    rmSync(stimHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test("a run that boots one slot's device forgets only that slot's idle shutdown", () => {
    const root = join(stimHome, 'app');
    const record = { at: at(0), idleMinutes: 30 };
    writeWorkspaceState(root, {
      [DEVICE_IDLE_SHUTDOWN_KEY]: { ios: record, 'ios:fold': record },
      lastUsedAt: at(0),
    });

    clearDeviceIdleShutdown(root, 'ios');
    expect(readDeviceIdleShutdowns(readWorkspaceState(root))).toEqual({
      'ios:fold': record,
    });

    clearDeviceIdleShutdown(root, 'ios', 'fold');
    expect(readWorkspaceState(root)).toEqual({ lastUsedAt: at(0) });
  });
});

describe('shutDownIdleDevices', () => {
  let stimHome: string;
  let home: string | undefined;

  beforeEach(() => {
    stimHome = mkdtempSync(join(tmpdir(), 'stim-idle-sweep-'));
    process.env.STIM_HOME = stimHome;
    home = process.env.HOME;
    process.env.HOME = stimHome;
    setExecutor({ runFileQuiet: () => '' } as never);
    vi.mocked(teardownOwnedIosSim).mockReset();
  });

  afterEach(() => {
    resetExecutor();
    process.env.HOME = home;
    rmSync(stimHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  function setup() {
    const mine = join(stimHome, 'mine');
    const other = join(stimHome, 'other');
    upsertProject(mine, { platforms: { ios: { deviceUdid: 'MINE', owned: true } } });
    upsertProject(other, { platforms: { ios: { deviceUdid: 'OTHER', owned: true } } });
    for (const root of [mine, other]) writeWorkspaceState(root, { lastUsedAt: at(10 * MINUTE) });
    return mine;
  }

  test("shuts down only its own workspace's idle device, without deleting it, and records why", () => {
    const mine = setup();
    vi.mocked(teardownOwnedIosSim).mockReturnValue({ status: 'torn-down', label: 'stim-MINE' });
    const log: { event: string; msg: string }[] = [];
    expect(shutDownIdleDevices(mine, 2 * MINUTE, (entry) => log.push(entry), NOW)).toBe(1);
    expect(vi.mocked(teardownOwnedIosSim).mock.calls).toEqual([['MINE', { label: 'stim-MINE', workspace: mine }]]);
    expect(readDeviceIdleShutdowns(readWorkspaceState(mine))).toEqual({ ios: { at: at(0), idleMinutes: 10 } });
    expect(log).toEqual([
      { level: 'info', event: 'device_idle_shutdown', msg: 'shut down simulator stim-MINE, idle 10m' },
    ]);
  });

  test('a teardown that is refused records nothing and logs why; a device already gone is silent', () => {
    const mine = setup();
    vi.mocked(teardownOwnedIosSim).mockReturnValueOnce({ status: 'skipped', kind: 'not-owned', reason: 'not ours' });
    const log: { event: string }[] = [];
    expect(shutDownIdleDevices(mine, 2 * MINUTE, (entry) => log.push(entry), NOW)).toBe(0);
    expect(log).toMatchObject([{ event: 'device_idle_shutdown_failed', msg: expect.stringMatching(/not ours/) }]);
    expect(readDeviceIdleShutdowns(readWorkspaceState(mine))).toEqual({});

    vi.mocked(teardownOwnedIosSim).mockReturnValueOnce({ status: 'missing' });
    log.length = 0;
    shutDownIdleDevices(mine, 2 * MINUTE, (entry) => log.push(entry), NOW);
    expect(log).toEqual([]);
  });

  test('recent client activity keeps the device up without probing processes', () => {
    const mine = setup();
    const file = join(workspaceLogsDir(mine), 'client.ndjson');
    mkdirSync(workspaceLogsDir(mine), { recursive: true });
    writeFileSync(file, '{}\n');
    utimesSync(file, NOW / 1000, NOW / 1000);
    const probe = vi.fn<() => string>(() => '');
    setExecutor({ runFileQuiet: probe } as never);
    expect(shutDownIdleDevices(mine, 2 * MINUTE, () => {}, NOW)).toBe(0);
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  test('a device used within the threshold is left alone', () => {
    const mine = setup();
    expect(shutDownIdleDevices(mine, 20 * MINUTE, () => {}, NOW)).toBe(0);
    expect(teardownOwnedIosSim).not.toHaveBeenCalled();
  });
});

test('idle shutdown records preserve a reclaim reason and accept legacy records without one', () => {
  const old = { at: at(0), idleMinutes: 30 };
  expect(
    readDeviceIdleShutdowns({
      deviceIdleShutdowns: {
        ios: old,
        android: { ...old, reason: 'reclaimed for a waiting run' },
        'ios:fold': { ...old, reason: 'idle' },
        'ios:unknown': { ...old, reason: 'future-reason' },
      },
    }),
  ).toEqual({
    ios: old,
    android: { ...old, reason: 'reclaimed for a waiting run' },
    'ios:fold': { ...old, reason: 'idle' },
    'ios:unknown': { ...old, reason: 'future-reason' },
  });
});
