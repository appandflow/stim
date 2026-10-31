import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_IDLE_SHUTDOWN_KEY, readDeviceIdleShutdowns, type DeviceActivity } from '@stim-cli/core/state';
import { clearDeviceIdleShutdown, idleShutdownDueMs } from '../devices/idle-shutdown.ts';

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

describe('idleShutdownDueMs', () => {
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

  test('a run waits for a workspace state lock held by another process without blocking the event loop', async () => {
    const root = join(stimHome, 'app');
    writeWorkspaceState(root, { [DEVICE_IDLE_SHUTDOWN_KEY]: { ios: { at: at(0), idleMinutes: 30 } } });
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          const { withWorkspaceStateLock } = await import(process.argv[1]);
          withWorkspaceStateLock(process.argv[2], () => {
            process.stdout.write('held');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
          });
        `,
        new URL('../workspace/workspace-state.ts', import.meta.url).href,
        root,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = once(holder, 'exit');
    try {
      await once(holder.stdout, 'data');
      let ticks = 0;
      const timer = setInterval(() => ticks++, 20);
      try {
        await clearDeviceIdleShutdown(root, 'ios');
      } finally {
        clearInterval(timer);
      }
      expect(ticks).toBeGreaterThan(5);
      expect(readDeviceIdleShutdowns(readWorkspaceState(root))).toEqual({});
    } finally {
      holder.kill('SIGKILL');
      await exited;
    }
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
