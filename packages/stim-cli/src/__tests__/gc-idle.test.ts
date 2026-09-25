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

const { findIdleDevices, idleShutdownCandidates, parseIdleDuration, shutDownIdleDevices } =
  await import('../commands/gc/idle.ts');

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

test('lists only owned, booted devices whose activity is idle, with idle time per slot', () => {
  const devices = collect({
    A: idle(3),
    B: { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: null }, basis: ['agent-device-lease'] },
    'emulator-5554': idle(1),
    U: idle(9),
  });
  expect(devices.map((d) => [d.kind, d.id, d.slot, d.idleForMs])).toEqual([
    ['ios', 'A', 'default', 3 * HOUR],
    ['android', 'stim-a', 'default', HOUR],
  ]);
});

test('unknown activity is never listed as idle', () => {
  expect(collect({ A: { state: 'unknown', basis: ['agent-device-lease'] } })).toEqual([]);
});

test('shutdown candidates need the full idle duration, a known idle time, and no build in progress', () => {
  const devices = collect({ A: idle(3), 'emulator-5554': idle(1) });
  expect(idleShutdownCandidates(devices, 2 * HOUR).map((d) => d.id)).toEqual(['A']);
  expect(idleShutdownCandidates(collect({ A: idle(3) }, true), HOUR)).toEqual([]);
  expect(idleShutdownCandidates(collect({ A: { state: 'idle', basis: [] } }), HOUR)).toEqual([]);
});

test('parses minute, hour, and day durations and rejects the rest', () => {
  expect(parseIdleDuration('30m')).toBe(30 * 60_000);
  expect(parseIdleDuration('2h')).toBe(2 * HOUR);
  expect(parseIdleDuration('1d')).toBe(24 * HOUR);
  expect(parseIdleDuration('0h')).toBeNull();
  expect(parseIdleDuration('90')).toBeNull();
});

test('shuts down through teardown, never deleting, and keeps a device that became active since the report', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const report = collect({ A: idle(3), 'emulator-5554': idle(3) });
    const failures = shutDownIdleDevices(report, 2 * HOUR, () => collect({ A: idle(3) }));
    expect(failures).toBe(0);
    expect(teardown.teardownOwnedIosSim).toHaveBeenCalledWith('A', { label: 'stim-a (iPhone 27.0)' });
    expect(teardown.teardownOwnedAvd).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
