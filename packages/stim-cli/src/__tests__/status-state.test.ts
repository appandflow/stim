import assert from 'node:assert';
import { join } from 'node:path';
import {
  activityLabel,
  addReverseMissingIssue,
  deviceLeaseLines,
  deviceLeaseStates,
  diskLine,
  environmentState,
  metroReverseTargets,
  remoteDeviceState,
  statusActivity,
  type DeviceLeaseState,
  type EnvironmentState,
} from '../status.ts';
import type { LeaseFileEntry } from '../engine/device-lease.ts';
import {
  androidPhysicalReading,
  iosPhysicalReading,
  physicalDeviceLine,
  physicalDeviceStates,
} from '../physical-devices.ts';
import { makeEnvironmentState } from './_factories.ts';
import { metroLastStop } from '../supervisor/stop-cause.ts';

const BOOTED = { udid: 'U1', name: 'stim-app', state: 'Booted' };
const SHUTDOWN = { udid: 'U1', name: 'stim-app', state: 'Shutdown' };

function project(over = {}) {
  return {
    __path: '/proj/a',
    metroPort: 8082,
    platforms: { ios: { deviceUdid: 'U1', owned: true } },
    ...over,
  };
}

test("another process on a running workspace's port is warned about once, not per slot", () => {
  const s = environmentState(project({ deviceSlots: { tablet: { ios: { deviceUdid: 'U1', owned: true } } } }), {
    simsByUdid: { U1: BOOTED },
    metro: { notOurs: 'pid 99 runs from /other/app', pid: 99, cwd: '/other/app' },
    supervisor: { pid: 4242, status: 'ours', healthy: false },
  });
  assert(s.metro);
  expect(s.metro.running).toBe(false);
  const issues = s.issues.filter((i) => i.code === 'port-not-ours');
  expect(issues).toEqual([expect.objectContaining({ severity: 'warning', remedy: 'stim stop' })]);
});

test("a port held by another workspace's Metro names that workspace", () => {
  const s = environmentState(project(), {
    metro: { notOurs: 'pid 99 runs from another workspace', pid: 99, cwd: join('/proj', 'b', 'app') },
    workspaces: [join('/proj', 'a'), join('/proj', 'b')],
  });
  expect(s.issues[0]?.message).toMatch(/^port 8082 is in use by Metro for workspace b;/);
});

test('a supervisor record that cannot be verified keeps a warning with its reason and remedy', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: SHUTDOWN },
    metro: { missing: true },
    supervisor: { pid: 4242, status: 'unverified', reason: 'identities disagree', healthy: false },
  });
  expect(s.issues).toEqual([
    {
      code: 'supervisor-unverified',
      severity: 'error',
      message: 'supervisor pid 4242 could not be verified: identities disagree',
      remedy: 'stim guide errors teardown',
      workspace: '/proj/a',
    },
  ]);
  expect(s.warnings).toEqual([
    'supervisor pid 4242 could not be verified: identities disagree; run `stim guide errors teardown`',
  ]);
});

test('one volume keeps the free-of-total form', () => {
  expect(diskLine([{ volume: '/', disk: { availableMb: 38 * 1024, totalMb: 926 * 1024 } }])).toBe(
    '38 GB free of 926 GB on disk.',
  );
});

test('a project on another volume gets both volumes, named', () => {
  expect(
    diskLine([
      { volume: '/', disk: { availableMb: 38 * 1024, totalMb: 926 * 1024 } },
      {
        volume: '/Volumes/ExternalSSD',
        disk: { availableMb: Math.round(1.5 * 1024 * 1024), totalMb: 2 * 1024 * 1024 },
      },
    ]),
  ).toBe('38 GB free on /, 1.5 TB free on /Volumes/ExternalSSD.');
});

describe('device lease state', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');
  const entry = (over: Partial<LeaseFileEntry> = {}): LeaseFileEntry => ({
    path: '/h/device-locks/ios-U.json',
    name: 'ios-U.json',
    platform: 'ios',
    id: 'U',
    lease: {
      version: 1,
      platform: 'ios',
      id: 'U',
      deviceName: 'Old iPhone',
      holder: '/w/a',
      token: 't',
      grantedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    },
    ...over,
  });

  test('a file that does not parse keeps its name and claims nothing', () => {
    const [state] = deviceLeaseStates([entry({ lease: null })], { root: '/w/a', now });
    expect(state).toMatchObject({ platform: 'ios', id: 'U', holder: null, expiresAt: null, parsed: false });
    expect(deviceLeaseLines([state as DeviceLeaseState], now).join('\n')).toMatch(/unreadable lease file/);
  });
});

describe('physical device state', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');
  const lease = (platform: 'ios' | 'android', id: string, over: Record<string, unknown> = {}): LeaseFileEntry => ({
    path: `/h/device-locks/${platform}-${id}.json`,
    name: `${platform}-${id}.json`,
    platform,
    id,
    lease: {
      version: 1,
      platform,
      id,
      deviceName: 'Leased name',
      holder: '/w/a',
      token: `t-${id}`,
      grantedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      ...over,
    },
  });
  const connected = { name: 'Old iPhone', model: 'iPhone 12 Pro', connection: 'connected' as const };
  const states = (
    entries: LeaseFileEntry[],
    held: Parameters<typeof physicalDeviceStates>[1],
    simulatorUdids: string[] = [],
  ) =>
    physicalDeviceStates(entries, held, {
      root: '/w/a',
      now,
      simulatorUdids: new Set(simulatorUdids),
      read: (platform) => (platform === 'ios' ? connected : { name: null, model: null, connection: 'disconnected' }),
    });

  test('a lease another holder took over, an expired one, or a simulator or emulator lease is left out', () => {
    const devices = states(
      [
        lease('ios', 'TAKEN', { holder: '/w/b', token: 't-other' }),
        lease('ios', 'OLD', { expiresAt: new Date(now).toISOString() }),
        lease('ios', 'SIM-UDID'),
        lease('android', 'emulator-5554'),
      ],
      {
        ios: { id: 'TAKEN', token: 't-TAKEN', kind: 'declared' },
        'ios:old': { id: 'OLD', token: 't-OLD', kind: 'declared' },
        'ios:sim': { id: 'SIM-UDID', token: 't-SIM-UDID', kind: 'declared' },
        android: { id: 'emulator-5554', token: 't-emulator-5554', kind: 'declared' },
      },
      ['SIM-UDID'],
    );
    expect(devices).toEqual([]);
  });

  test('devicectl readings: unreadable is unknown, absent or unreachable is disconnected', () => {
    const phone = {
      udid: 'ABC',
      name: 'Old iPhone',
      bootState: 'booted',
      developerModeStatus: 'enabled',
      pairingState: 'paired',
      transportType: 'localNetwork',
      tunnelState: 'connected',
      model: 'iPhone 12 Pro',
    };
    expect(iosPhysicalReading(null, 'ABC').connection).toBe('unknown');
    expect(iosPhysicalReading([], 'ABC').connection).toBe('disconnected');
    expect(iosPhysicalReading([{ ...phone, tunnelState: 'unavailable' }], 'abc').connection).toBe('disconnected');
    expect(iosPhysicalReading([phone], 'abc')).toEqual({
      name: 'Old iPhone',
      model: 'iPhone 12 Pro',
      connection: 'connected',
    });
  });

  test('adb readings: only a serial adb lists as device is connected, and the model comes from the lease', () => {
    const devices = {
      emulators: [],
      physical: [{ serial: 'R5' }],
      unhealthy: [{ serial: 'R6', kind: 'physical' as const, status: 'unauthorized' }],
    };
    expect(androidPhysicalReading(null, 'R5').connection).toBe('unknown');
    expect(androidPhysicalReading(devices, 'R6').connection).toBe('disconnected');
    expect(androidPhysicalReading(devices, 'R5').connection).toBe('connected');
  });

  test('the plain line names the device, its model, the connection and the time left', () => {
    const [device] = states([lease('ios', 'PHONE')], { 'ios:phone': { id: 'PHONE', token: 't-PHONE', kind: 'run' } });
    expect(physicalDeviceLine(device!, now)).toMatch(
      /^ios \[phone\]: Old iPhone \(physical, iPhone 12 Pro\) connected -- leased until \d\d:\d\d:\d\d \(1m00s left\)$/,
    );
  });
});

describe('remote device state', () => {
  const record = {
    platform: 'android' as const,
    sessionId: 'drs_7',
    startedAt: '2026-09-24T00:00:00.000Z',
    webPreviewUrl: 'https://preview.example/7',
  };

  test('a recorded session is claimed only when the ledger names this workspace', () => {
    const claims = new Map([['drs_7', { workspaceRoot: '/proj/a' }]]);
    expect(remoteDeviceState(record, { claims, safe: true }, '/proj/a')?.state).toBe('claimed');
    expect(remoteDeviceState(record, { claims, safe: true }, '/proj/b')?.state).toBe('unclaimed');
    expect(remoteDeviceState(record, { claims: new Map(), safe: false }, '/proj/a')?.state).toBe('unknown');
    expect(remoteDeviceState(null, { claims, safe: true }, '/proj/a')).toBe(null);
  });
});

test('device activity labels name the driver and its duration, and an unknown state never reads as idle', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  expect(
    activityLabel(
      {
        state: 'driven',
        driver: { tool: 'agent-device', pid: 1, since: '2026-09-24T11:48:00Z' },
        basis: ['agent-device-lease'],
      },
      now,
    ),
  ).toBe('driven by agent-device for 12m');
  expect(activityLabel({ state: 'idle', lastActivityAt: '2026-09-24T09:00:00Z', basis: ['device-log'] }, now)).toBe(
    'idle 3h',
  );
  expect(activityLabel({ state: 'unknown', basis: ['agent-device-lease'] }, now)).toBe(
    'activity unknown (agent-device-lease)',
  );
});

test('a stopped dev server reports its recorded cause, or a vanished supervisor that recorded none', () => {
  const requested = { reason: 'requested', at: '2026-09-26T20:00:00.000Z', by: 'budget reclaim', byPid: 7 };
  const stale = { status: 'stale', pid: 99, startedAt: '2026-09-26T19:00:00.000Z' };
  expect(metroLastStop({ devServerStop: requested }, stale)).toEqual(requested);
  expect(metroLastStop({}, stale)).toEqual({ reason: 'vanished', pid: 99, startedAt: '2026-09-26T19:00:00.000Z' });
  expect(metroLastStop({}, { ...stale, status: 'ours' })).toBeNull();
  expect(metroLastStop({}, null)).toBeNull();

  const lastStop = metroLastStop({ devServerStop: requested }, null);
  expect(environmentState(project(), { metro: { missing: true }, lastStop }).metro).toEqual({
    port: 8082,
    running: false,
    pid: null,
    lastStop: requested,
  });
  expect(environmentState(project(), { metro: { metro: { pid: 42 } }, lastStop }).metro).toEqual({
    port: 8082,
    running: true,
    pid: 42,
  });
});

test('statusActivity rounds lastActivityAt down to the minute, so records within one minute give the same payload', () => {
  const at = (iso: string) =>
    statusActivity({ state: 'active', lastActivityAt: iso, recent: { 'device-log': iso }, basis: ['device-log'] });
  expect(at('2026-09-24T09:00:01.250Z')).toEqual(at('2026-09-24T09:00:59.999Z'));
  expect(JSON.stringify(at('2026-09-24T09:00:59.999Z'))).toBe(
    JSON.stringify({
      state: 'active',
      lastActivityAt: '2026-09-24T09:00:00.000Z',
      recent: { 'device-log': '2026-09-24T09:00:00.000Z' },
      basis: ['device-log'],
    }),
  );
  expect(at('2026-09-24T09:01:00.000Z').lastActivityAt).toBe('2026-09-24T09:01:00.000Z');
  const both = (first: 'agent-action' | 'device-log') =>
    JSON.stringify(
      statusActivity({
        state: 'driven',
        lastActivityAt: '2026-09-24T09:00:40.000Z',
        recent:
          first === 'agent-action'
            ? { 'agent-action': '2026-09-24T09:00:30.000Z', 'device-log': '2026-09-24T09:00:40.000Z' }
            : { 'device-log': '2026-09-24T09:00:20.000Z', 'agent-action': '2026-09-24T09:00:30.000Z' },
        basis: [],
      }).recent,
    );
  expect(both('agent-action')).toBe(both('device-log'));
  expect(statusActivity({ state: 'idle', basis: [] })).toEqual({ state: 'idle', basis: [] });
});

describe('the adb reverse check', () => {
  const launch = { deviceId: 'emulator-5554', metroPort: 8082, release: false };
  const android = {
    name: 'stim-app',
    owned: true,
    physical: false,
    serial: 'emulator-5554',
    state: 'detected' as const,
    app: { id: 'com.app', state: 'running' as const },
  };
  const live = (overrides: Partial<EnvironmentState> = {}) =>
    makeEnvironmentState({ metro: { port: 8082, running: true, pid: 1 }, android, ...overrides });

  test('probes each owned emulator whose running debug app was launched against the serving Metro', () => {
    const state = live({
      slots: [{ slot: 'tablet', ios: null, android: { ...android, serial: 'emulator-5556' } }],
    });
    expect(
      metroReverseTargets(state, { android: launch, 'android:tablet': { ...launch, deviceId: 'emulator-5556' } }),
    ).toEqual([
      { slot: 'default', serial: 'emulator-5554', metroPort: 8082 },
      { slot: 'tablet', serial: 'emulator-5556', metroPort: 8082 },
    ]);
  });

  test('a missing reverse is an issue whose remedy restores it, with the slot named', () => {
    const state = live();
    addReverseMissingIssue(state, { slot: 'tablet', serial: 'emulator-5556', metroPort: 8082 });
    expect(state.issues).toEqual([
      expect.objectContaining({ code: 'android-reverse-missing', remedy: 'stim reload android', slot: 'tablet' }),
    ]);
    expect(state.warnings).toEqual([
      'tablet: the adb reverse for Metro port 8082 is missing on emulator-5556, so the app cannot reach Metro; run `stim reload android`',
    ]);
  });
});
