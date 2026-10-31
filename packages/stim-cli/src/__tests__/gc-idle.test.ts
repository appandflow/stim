import { vi } from 'vitest';
import type { DeviceActivity } from '../devices/activity.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import type { Config } from '../workspace/config.ts';

const teardown = vi.hoisted(() => ({
  teardownOwnedIosSim: vi.fn<(udid: string, options: object) => { status: 'torn-down' }>(() => ({
    status: 'torn-down',
  })),
  teardownOwnedAvd: vi.fn<(name: string, options: object) => { status: 'torn-down' }>(() => ({
    status: 'torn-down',
  })),
}));
vi.mock('../devices/teardown.ts', () => teardown);

const { findIdleDevices, parseIdleDuration, shutDownIdleDevices } = await import('../commands/gc/idle.ts');

const NOW = Date.parse('2026-09-24T12:00:00Z');
const HOUR = 3_600_000;

const config = {
  projects: {
    '/p/a': {
      platforms: { ios: { deviceUdid: 'A', owned: true }, android: { avdName: 'stim-a', owned: true } },
      deviceSlots: { ipad: { ios: { deviceUdid: 'B', owned: true } } },
    },
    '/p/user': { platforms: { ios: { deviceUdid: 'U', owned: false } } },
  },
} as unknown as Config;

const sim = (udid: string, name: string): IosSimRecord => ({
  udid,
  name,
  state: 'Booted',
  runtime: 'iOS-27-0',
  deviceTypeIdentifier: 'iPhone',
  available: true,
});
const sims = [sim('A', 'stim-a (iPhone 27.0)'), sim('B', 'stim-a-ipad (iPad 27.0)'), sim('U', 'My iPhone')];

function idle(hours: number): DeviceActivity {
  return { state: 'idle', lastActivityAt: new Date(NOW - hours * HOUR).toISOString(), basis: ['device-log'] };
}

function collect(activity: Record<string, DeviceActivity>, building = false) {
  return findIdleDevices({
    config,
    sims,
    now: NOW,
    androidSerial: (avd) => (avd === 'stim-a' ? 'emulator-5554' : null),
    readActivity: (target) => activity[target.id] ?? { state: 'active', basis: [] },
    buildInProgress: () => building,
  });
}

test('parses minute, hour, and day durations and rejects the rest', () => {
  expect(parseIdleDuration('30m')).toBe(30 * 60_000);
  expect(parseIdleDuration('2h')).toBe(2 * HOUR);
  expect(parseIdleDuration('1d')).toBe(24 * HOUR);
  expect(parseIdleDuration('0h')).toBeNull();
  expect(parseIdleDuration('90')).toBeNull();
});

test('a caller output receives the shutdown lines and records instead of console.log and gc results', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const lines: string[] = [];
  const records: string[] = [];
  try {
    const report = collect({ A: idle(3), 'emulator-5554': idle(3) });
    await shutDownIdleDevices(report, 2 * HOUR, () => collect({ A: idle(3) }), {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      record: (_kind, status, label) => records.push(`${status} ${label}`),
      fail: () => {},
    });
    expect(lines.join('\n')).toMatch(/Shut down ios stim-a/);
    expect(records).toEqual(['done stim-a (iPhone 27.0)', 'kept stim-a']);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test.each(['recollection', 'teardown'] as const)(
  'cancellation during %s prevents the next device shutdown',
  async (phase) => {
    teardown.teardownOwnedIosSim.mockClear();
    teardown.teardownOwnedAvd.mockClear();
    const abort = new AbortController();
    const reason = new Error('cancel idle shutdown');
    const report = collect({ A: idle(3), 'emulator-5554': idle(3) });
    if (phase === 'teardown')
      teardown.teardownOwnedIosSim.mockImplementationOnce(() => {
        abort.abort(reason);
        return { status: 'torn-down' };
      });
    await expect(
      shutDownIdleDevices(
        report,
        2 * HOUR,
        async () => {
          if (phase === 'recollection') abort.abort(reason);
          return report;
        },
        { log: () => {}, error: () => {}, record: () => {}, fail: () => {} },
        abort.signal,
      ),
    ).rejects.toThrow(reason);
    expect(teardown.teardownOwnedIosSim).toHaveBeenCalledTimes(phase === 'teardown' ? 1 : 0);
    expect(teardown.teardownOwnedAvd).not.toHaveBeenCalled();
  },
);
