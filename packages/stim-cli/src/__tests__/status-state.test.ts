import assert from 'node:assert';
import { join } from 'node:path';
import {
  activityLabel,
  capacity,
  deviceLeaseLines,
  deviceLeaseStates,
  diskIsTight,
  diskLine,
  environmentState,
  formatSpace,
  parseDfFree,
  poolLine,
  remoteDeviceLine,
  remoteDeviceState,
  statusActivity,
  tightVolumes,
  unprovisionedWorktrees,
  type DeviceLeaseState,
} from '../status.ts';
import type { LeaseFileEntry } from '../engine/device-lease.ts';
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

test('a registered project with nothing booted is not live and costs no memory', () => {
  const s = environmentState(project(), { simsByUdid: { U1: SHUTDOWN }, metro: { missing: true } });
  expect(s.live).toBe(false);
  expect(s.memoryMb).toBe(0);
});

test('a booted sim with Metro running is live, and counts both', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { metro: { pid: 42 } },
  });
  expect(s.live).toBe(true);
  expect(s.memoryMb >= 2000).toBeTruthy();
  assert(s.metro);
  expect(s.metro.pid).toBe(42);
});

test('a port answered by something that is not our Metro is warned about once, not per slot', () => {
  const s = environmentState(project({ deviceSlots: { tablet: { ios: { deviceUdid: 'U1', owned: true } } } }), {
    simsByUdid: { U1: BOOTED },
    metro: { notOurs: 'pid 99 runs from /somewhere/else' },
  });
  assert(s.metro);
  expect(s.metro.running).toBe(false);
  expect(s.issues.filter((i) => i.code === 'port-not-ours')).toHaveLength(1);
  expect(s.warnings.join(' ')).toMatch(/somewhere\/else/);
});

test('a booted sim with no Metro is called out as abandoned', () => {
  const s = environmentState(project(), { simsByUdid: { U1: BOOTED }, metro: { missing: true } });
  expect(s.warnings.join(' ')).toMatch(/booted with no Metro/);
});

test('a recorded device that no longer exists is reported rather than shown as fine', () => {
  const s = environmentState(project(), { simsByUdid: {}, metro: { missing: true } });
  assert(s.ios);
  expect(s.ios.state).toBe('missing');
  expect(s.warnings.join(' ')).toMatch(/no longer exists/);
});

test('an unreadable sim listing leaves the state unknown instead of warning per project', () => {
  const s = environmentState(project(), { simsByUdid: {}, metro: { missing: true }, simsAvailable: false });
  assert(s.ios);
  expect(s.ios.state).toBe('unknown');
  expect(s.warnings.join(' ').includes('no longer exists')).toBe(false);
});

test('an owned AVD reports its device profile alongside runtime facts', () => {
  const s = environmentState(project({ platforms: { android: { avdName: 'stim-app', owned: true } } }), {
    androidRuntime: { serial: 'emulator-5554', state: 'detected' },
    androidDeviceProfile: 'pixel_fold',
  });
  assert(s.android);
  expect(s.android.deviceProfile).toBe('pixel_fold');
});

test('an owned AVD with no known device profile omits the field rather than reporting null', () => {
  const s = environmentState(project({ platforms: { android: { avdName: 'stim-app', owned: true } } }), {
    androidRuntime: { serial: 'emulator-5554', state: 'detected' },
  });
  assert(s.android);
  expect(s.android.deviceProfile).toBeUndefined();
});

test('capacity warns once committed memory passes a comfortable share of the machine', () => {
  const live = makeEnvironmentState({ memoryMb: 2200 });
  expect(capacity([live, live], 16384).overCapacity).toBe(false);
  expect(capacity([live, live, live, live, live], 16384).overCapacity).toBe(true);
});

test('capacity says nothing when the machine size is unknown', () => {
  expect(capacity([makeEnvironmentState({ memoryMb: 9999 })], 0).overCapacity).toBe(false);
});

test('unprovisioned worktrees are the ones with no registered environment in or below them', () => {
  const wt = (...parts: string[]) => join('/wt', ...parts);
  const worktrees = [{ path: wt('a') }, { path: wt('b') }, { path: wt('c') }, { path: wt('d') }];
  expect(
    unprovisionedWorktrees(worktrees, [wt('a'), wt('b', 'apps', 'mobile'), wt('c-other')]).map((w) => w.path),
  ).toEqual([wt('c'), wt('d')]);
});

test('poolLine reports a bounded pool and a disabled pool that still has parked devices', () => {
  expect(poolLine({ platform: 'ios', parked: 0, max: 3 })).toBe(null);
  expect(poolLine({ platform: 'ios', parked: 2, max: 3 })).toBe('pool: 2 parked iOS simulators (max 3)');
  expect(poolLine({ platform: 'ios', parked: 1, max: 0 })).toBe(
    'pool: 1 parked iOS simulator (parking off; gc --delete removes them)',
  );
});

test('parseDfFree reads the available and total columns from df -k', () => {
  const out = [
    'Filesystem   1024-blocks       Used  Available Capacity iused ifree %iused  Mounted on',
    '/dev/disk3s5   970989436  776862512  164363576    83%    12M  1.6G    1%   /',
  ].join('\n');
  expect(parseDfFree(out)).toEqual({
    availableMb: Math.round(164363576 / 1024),
    totalMb: Math.round(970989436 / 1024),
  });
});

test('a filesystem name containing spaces still parses', () => {
  const out = [
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    'my volume name 2097152 1048576 1048576 50% /Volumes/x',
  ].join('\n');
  expect(parseDfFree(out)).toEqual({ availableMb: 1024, totalMb: 2048 });
});

test('unreadable df output is null, never a guess', () => {
  expect(parseDfFree('')).toBe(null);
  expect(parseDfFree(null)).toBe(null);
  expect(parseDfFree('Filesystem 1024-blocks Used Available Capacity')).toBe(null);
});

test('a nearly full disk is flagged before a build discovers it', () => {
  expect(diskIsTight({ availableMb: 5 * 1024, totalMb: 900 * 1024 })).toBe(true);
  expect(diskIsTight({ availableMb: 190 * 1024, totalMb: 900 * 1024 })).toBe(false);
  expect(diskIsTight(null)).toBe(false);
});

test('a healthy supervisor is reported with its pid, mode and start time', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { metro: { pid: 42 } },
    supervisor: { pid: 4242, mode: 'bare-inproc', startedAt: '1700000000000', status: 'ours', healthy: true },
  });
  expect(s.supervisor).toEqual({ pid: 4242, mode: 'bare-inproc', startedAt: '1700000000000', healthy: true });
  expect(s.warnings.join(' ').includes('stale supervisor')).toBe(false);
});

test('a supervisor record proven gone is dropped without a warning', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: SHUTDOWN },
    metro: { missing: true },
    supervisor: { pid: 4242, mode: 'expo-child', startedAt: '5', status: 'stale', healthy: false },
  });
  expect(s.supervisor).toBe(null);
  expect(s.issues).toEqual([]);
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

describe('an owned AVD that adb does not detect', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const minutesAgo = (m: number) => ({ launchedAt: new Date(now - m * 60_000).toISOString() });
  const androidProject = project({
    platforms: {
      ios: { deviceUdid: 'U1', owned: true },
      android: { avdName: 'stim-app', consolePort: 5554, owned: true },
    },
    deviceSlots: { fold: { android: { avdName: 'stim-app-fold', consolePort: 5556, owned: true } } },
  });
  const notDetected = { serial: null, state: 'not-detected' as const };
  const state = (over: Parameters<typeof environmentState>[1]) =>
    environmentState(androidProject, {
      simsByUdid: { U1: SHUTDOWN },
      metro: { missing: true },
      androidRuntime: notDetected,
      androidRuntimes: { fold: notDetected },
      now,
      ...over,
    });
  const codes = (s: ReturnType<typeof environmentState>) => s.issues.map((i) => `${i.slot ?? 'default'}:${i.code}`);

  test('is the resting state of an idle workspace, even with an old launch record', () => {
    const s = state({ launches: { android: minutesAgo(120), 'android:fold': minutesAgo(120) } });
    expect(s.android?.state).toBe('not-detected');
    expect(s.issues).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  test('is not warned about while Metro serves only the other platform', () => {
    const s = state({ metro: { metro: { pid: 42 } }, launches: { ios: minutesAgo(120) } });
    expect(codes(s)).toEqual([]);
  });

  test('is warned about in the slot launched onto while Metro runs, with that slot in the remedy', () => {
    const s = state({ metro: { metro: { pid: 42 } }, launches: { 'android:fold': minutesAgo(120) } });
    expect(codes(s)).toEqual(['fold:avd-not-detected']);
    expect(s.issues[0]).toMatchObject({ remedy: 'stim android --slot fold', workspace: '/proj/a' });
    expect(s.warnings[0]).toBe('fold: owned AVD stim-app-fold is not detected by adb; run `stim android --slot fold`');
  });

  test('is warned about after a recent launch with no dev server, as for a release variant', () => {
    expect(codes(state({ launches: { android: minutesAgo(5) } }))).toEqual(['default:avd-not-detected']);
  });

  test('is warned about while the workspace leases its serial, and not for a lease on another device', () => {
    expect(codes(state({ leasedIds: new Set(['emulator-5556']) }))).toEqual(['fold:avd-not-detected']);
    expect(codes(state({ leasedIds: new Set(['R58M123']) }))).toEqual([]);
  });
});

test('a live supervisor that is not answering is unhealthy but not stale', () => {
  const s = environmentState(project(), {
    metro: { missing: true },
    supervisor: { pid: 4242, mode: 'expo-child', startedAt: '5', status: 'ours', healthy: false },
  });
  assert(s.supervisor);
  expect(s.supervisor.healthy).toBe(false);
  expect(s.warnings.join(' ').includes('stale supervisor')).toBe(false);
});

test('no supervisor recorded reports null, not an absent field', () => {
  const s = environmentState(project(), { metro: { missing: true } });
  expect(s.supervisor).toBe(null);
  expect('supervisor' in s).toBe(true);
});

test('the log timeline is reported with the error count since the last marker', () => {
  const s = environmentState(project(), {
    metro: { missing: true },
    logs: { dir: '/proj/a/.stim/logs', errorsSinceMarker: 3 },
  });
  expect(s.logs).toEqual({ dir: '/proj/a/.stim/logs', errorsSinceMarker: 3 });
});

test('a workspace with no log directory reports logs as null', () => {
  const s = environmentState(project(), { metro: { missing: true } });
  expect(s.logs).toBe(null);
});

test('every pre-v3 field survives the extension', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { metro: { pid: 42 } },
    supervisor: { pid: 4242, mode: 'bare-inproc', startedAt: '5', status: 'ours', healthy: true },
    logs: { dir: '/proj/a/.stim/logs', errorsSinceMarker: 0 },
  });
  for (const key of ['path', 'live', 'memoryMb', 'warnings', 'ios', 'android', 'metro', 'worktree']) {
    expect(key in s).toBe(true);
  }
  assert(s.metro);
  expect(s.metro.port).toBe(8082);
  assert(s.ios);
  expect(s.ios.udid).toBe('U1');
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

test('an unreadable df prints no disk line at all rather than a broken one', () => {
  expect(diskLine([])).toBe(null);
  expect(diskLine(null)).toBe(null);
  expect(diskLine([{ volume: '/', disk: null }])).toBe(null);
});

test('formatSpace changes scale where the number stops being readable', () => {
  expect(formatSpace(512)).toBe('512 MB');
  expect(formatSpace(38 * 1024)).toBe('38 GB');
  expect(formatSpace(1024 * 1024)).toBe('1.0 TB');
  expect(formatSpace(NaN)).toBe('?');
});

test('tightVolumes names only the volumes that are actually tight', () => {
  const volumes = [
    { volume: '/', disk: { availableMb: 5 * 1024, totalMb: 926 * 1024 } },
    { volume: '/Volumes/ExternalSSD', disk: { availableMb: 900 * 1024, totalMb: 2048 * 1024 } },
  ];
  expect(tightVolumes(volumes).map((v) => v.volume)).toEqual(['/']);
  expect(tightVolumes([])).toEqual([]);
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

  test('marks this workspace lease and an expired one', () => {
    const states = deviceLeaseStates(
      [
        entry(),
        entry({
          name: 'android-R5.json',
          platform: 'android',
          id: 'R5',
          lease: {
            version: 1,
            platform: 'android',
            id: 'R5',
            deviceName: null,
            holder: '/w/b',
            token: 't2',
            grantedAt: null,
            expiresAt: new Date(now - 1).toISOString(),
          },
        }),
      ],
      { root: '/w/a', now },
    );
    expect(states[0]).toMatchObject({ holder: '/w/a', mine: true, expired: false, parsed: true });
    expect(states[1]).toMatchObject({ holder: '/w/b', mine: false, expired: true, parsed: true });
  });

  test('a file that does not parse keeps its name and claims nothing', () => {
    const [state] = deviceLeaseStates([entry({ lease: null })], { root: '/w/a', now });
    expect(state).toMatchObject({ platform: 'ios', id: 'U', holder: null, expiresAt: null, parsed: false });
    expect(deviceLeaseLines([state as DeviceLeaseState], now).join('\n')).toMatch(/unreadable lease file/);
  });

  test('the lines name the device, the holder and the time left', () => {
    const lines = deviceLeaseLines(deviceLeaseStates([entry()], { root: '/w/a', now }), now);
    expect(lines[0]).toBe('Device leases (1):');
    expect(lines[1]).toMatch(/ios U \(Old iPhone\) -- \/w\/a until \d\d:\d\d:\d\d \(1m00s left\) \[this workspace\]/);
  });

  test('no lease file prints no section', () => {
    expect(deviceLeaseLines([], now)).toEqual([]);
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

  test('a remote session makes the environment live without committing local memory', () => {
    const remote = remoteDeviceState(record, { claims: new Map(), safe: true }, '/proj/a');
    const s = environmentState({ __path: '/proj/a', platforms: {} }, { remote });
    expect(s.live).toBe(true);
    expect(s.memoryMb).toBe(0);
    expect(s.remoteDevices).toEqual([
      {
        platform: 'android',
        backend: 'eas',
        sessionId: 'drs_7',
        state: 'unclaimed',
        startedAt: '2026-09-24T00:00:00.000Z',
        webPreviewUrl: 'https://preview.example/7',
      },
    ]);
    assert(remote);
    expect(remoteDeviceLine(remote)).toBe(
      'remote android: EAS session drs_7 billable (unclaimed) -- watch: https://preview.example/7',
    );
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

test('an idle-stopped dev server is reported on metro only while nothing serves the port', () => {
  const idleStop = { reason: 'idle' as const, at: '2026-09-25T10:00:00.000Z', idleMinutes: 60 };
  const stopped = environmentState(project(), { metro: { missing: true }, idleStop });
  expect(stopped.metro).toEqual({ port: 8082, running: false, pid: null, idleStop });

  const restarted = environmentState(project(), { metro: { metro: { pid: 42 } }, idleStop });
  expect(restarted.metro).toEqual({ port: 8082, running: true, pid: 42 });
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
  const at = (iso: string) => statusActivity({ state: 'active', lastActivityAt: iso, basis: ['device-log'] });
  expect(at('2026-09-24T09:00:01.250Z')).toEqual(at('2026-09-24T09:00:59.999Z'));
  expect(JSON.stringify(at('2026-09-24T09:00:59.999Z'))).toBe(
    JSON.stringify({ state: 'active', lastActivityAt: '2026-09-24T09:00:00.000Z', basis: ['device-log'] }),
  );
  expect(at('2026-09-24T09:01:00.000Z').lastActivityAt).toBe('2026-09-24T09:01:00.000Z');
  expect(statusActivity({ state: 'idle', basis: [] })).toEqual({ state: 'idle', basis: [] });
});
