import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessStart } from '../process-identity.ts';
import {
  agentDeviceLiveness,
  classifyActivity,
  createActivityReader,
  driverTool,
  parseAgentDeviceRecord,
  parseProcessTable,
  type ActivityTarget,
} from '../devices/activity.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

const UDID = '7466D06C-1AE4-4EDB-8A93-6B8A43A7A47A';
const OWNER_START = 'Thu Sep 24 21:59:30 2026';
const RUNNER_START = 'Thu Sep 24 22:00:05 2026';
const NOW = Date.parse('Thu Sep 24 23:00:00 2026');

function starts(table: Record<number, string | 'gone' | 'unknown'>): (pid: number) => ProcessStart {
  return (pid) => {
    const entry = table[pid];
    if (entry === undefined || entry === 'gone') return { status: 'gone' };
    if (entry === 'unknown') return { status: 'unknown' };
    return { status: 'running', startedAtMs: Date.parse(entry) + 417 };
  };
}

function runnerLease(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    deviceId: UDID,
    ownerPid: 100,
    ownerStartTime: OWNER_START,
    runnerPid: 200,
    runnerStartTime: RUNNER_START,
    createdAtMs: Date.parse(RUNNER_START),
    futureField: { anything: true },
    ...over,
  });
}

describe('agent-device lease liveness', () => {
  const lease = parseAgentDeviceRecord('runner-lease', `/leases/${UDID}.json`, runnerLease());

  test('is live only when owner and runner are alive with their recorded start times', () => {
    expect(agentDeviceLiveness(lease, starts({ 100: OWNER_START, 200: RUNNER_START }))).toBe('live');
    expect(agentDeviceLiveness(lease, starts({ 100: OWNER_START }))).toBe('dead');
  });

  test('a reused pid with a different start time is a dead session', () => {
    expect(agentDeviceLiveness(lease, starts({ 100: OWNER_START, 200: 'Fri Sep 25 08:00:00 2026' }))).toBe('dead');
  });

  test('an uninspectable process or unreadable lease is unknown, never dead', () => {
    expect(agentDeviceLiveness(lease, starts({ 100: OWNER_START, 200: 'unknown' }))).toBe('unknown');
    const broken = parseAgentDeviceRecord('runner-lease', `/leases/${UDID}.json`, '{"ownerPid":');
    expect(broken.deviceId).toBe(UDID);
    expect(agentDeviceLiveness(broken, starts({}))).toBe('unknown');
  });

  test('a device claim needs only its owner process', () => {
    const claim = parseAgentDeviceRecord(
      'claim',
      '/claims/abc.json',
      JSON.stringify({ device: { id: UDID }, ownerPid: 100, ownerStartTime: OWNER_START }),
    );
    expect(claim.deviceId).toBe(UDID);
    expect(agentDeviceLiveness(claim, starts({ 100: OWNER_START }))).toBe('live');
  });
});

describe('driver processes', () => {
  test('parses ps lstart rows and ignores Stim log collectors', () => {
    const rows = parseProcessTable(
      [
        `  3503     1 204800  12.5 ${RUNNER_START}     /usr/bin/xcodebuild test-without-building -destination platform=iOS Simulator,id=${UDID}`,
        ` 18172  3503   2048   0,5 ${RUNNER_START}     /bin/simctl spawn ${UDID} log stream --style ndjson`,
        ` 18200     1   1024   0.0 ${RUNNER_START}     /bin/simctl spawn ${UDID}0 something`,
        ' 18201     1    512   0.0 Thu Sep 24 22:00:05 2026     adb -s emulator-5554 logcat --pid 42',
      ].join('\n'),
    );
    expect(rows.map((row) => [row.pid, driverTool(row.command, UDID)])).toEqual([
      [3503, 'xcodebuild'],
      [18172, null],
      [18200, null],
      [18201, null],
    ]);
    expect(rows[0]).toMatchObject({ ppid: 1, rssKb: 204800, cpuPercent: 12.5 });
    expect(rows[1]).toMatchObject({ ppid: 3503, cpuPercent: 0.5 });
    expect(rows[0]!.startedAt).toBe(new Date(RUNNER_START).toISOString());
  });
});

test('recent activity is active, older activity is idle, and no evidence is idle without a time', () => {
  const recent = classifyActivity(
    { drivers: [], unknown: [], recency: [{ basis: 'device-log', at: NOW - 60_000 }] },
    NOW,
  );
  expect(recent.state).toBe('active');
  const old = classifyActivity(
    { drivers: [], unknown: [], recency: [{ basis: 'metro-bundle', at: NOW - 3_600_000 }] },
    NOW,
  );
  expect(old).toEqual({
    state: 'idle',
    lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
    basis: ['metro-bundle'],
  });
  expect(classifyActivity({ drivers: [], unknown: [], recency: [] }, NOW)).toEqual({ state: 'idle', basis: [] });
});

describe('createActivityReader', () => {
  let home: string;
  let stimHome: string;
  const workspace = '/projects/app';
  let ps: string;
  let adb: string | null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-activity-home-'));
    stimHome = mkdtempSync(join(tmpdir(), 'stim-activity-state-'));
    process.env.STIM_HOME = stimHome;
    ps = '';
    adb = '  PID ARGS\n    1 init\n';
    setExecutor({
      runFileQuiet: (file: string) => (file === 'ps' ? ps : file === 'adb' ? adb : null),
    });
  });

  afterEach(() => {
    resetExecutor();
    rmSync(home, { recursive: true, force: true });
    rmSync(stimHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  function writeLease(text: string, name = `${UDID}.json`) {
    const dir = join(home, '.agent-device', 'apple-runner', 'leases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
  }

  function writeLogs(device: object[], metro: object[] = []) {
    const dir = workspaceLogsDir(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'device.ndjson'), device.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'metro.ndjson'), metro.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  const target: ActivityTarget = { platform: 'ios', id: UDID, slot: 'default', workspace };
  const read = (table: Record<number, string>, t: ActivityTarget = target) =>
    createActivityReader({ now: NOW, home, startOf: starts(table), leaseFiles: () => [] })(t);

  test('a live agent-device lease makes the device driven', () => {
    writeLease(runnerLease());
    expect(read({ 100: OWNER_START, 200: RUNNER_START })).toMatchObject({
      state: 'driven',
      driver: { tool: 'agent-device', pid: 100, since: new Date(RUNNER_START).toISOString() },
    });
  });

  test('a stale lease falls through to log recency from this device only', () => {
    writeLease(runnerLease());
    const at = NOW - 2 * 3_600_000;
    writeLogs(
      [
        { ts: at, src: 'device', platform: 'ios', msg: 'app log' },
        { ts: NOW - 60_000, src: 'device', platform: 'ios', slot: 'ipad', deviceId: 'OTHER', msg: 'other slot' },
        { ts: NOW - 30_000, src: 'device', platform: 'ios', event: 'collector_stopped', msg: 'detaching' },
      ],
      [{ ts: at - 1000, src: 'metro', event: 'bundle_response_started', platform: 'ios' }],
    );
    expect(read({ 100: OWNER_START })).toEqual({
      state: 'idle',
      lastActivityAt: new Date(at).toISOString(),
      basis: ['device-log', 'metro-bundle'],
    });
  });

  test('an unreadable lease is unknown, never idle', () => {
    writeLease('not json');
    writeLogs([{ ts: NOW - 5 * 3_600_000, src: 'device', platform: 'ios', msg: 'old' }]);
    expect(read({}).state).toBe('unknown');
  });

  test('a host test runner naming the device makes it driven', () => {
    ps = `  3503     1   1024   0.0 ${RUNNER_START}     maestro test flow.yaml --udid ${UDID}\n`;
    expect(read({})).toMatchObject({ state: 'driven', driver: { tool: 'maestro', pid: 3503 } });
  });

  test('instrumentation on an emulator makes it driven, and unreadable adb is unknown', () => {
    const android: ActivityTarget = { platform: 'android', id: 'emulator-5554', slot: 'default', workspace };
    adb = '  PID ARGS\n12322 uiautomator\n';
    expect(read({}, android)).toMatchObject({ state: 'driven', driver: { tool: 'uiautomator', pid: 12322 } });
    adb = null;
    expect(read({}, android).state).toBe('unknown');
  });

  test('an unexpired Stim device lock is a live claim', () => {
    const reader = createActivityReader({
      now: NOW,
      home,
      startOf: starts({}),
      leaseFiles: () => [
        {
          path: '/locks/ios.json',
          name: 'ios.json',
          platform: 'ios',
          id: UDID,
          lease: {
            version: 1,
            platform: 'ios',
            id: UDID,
            deviceName: null,
            holder: workspace,
            token: 't',
            grantedAt: new Date(NOW - 1000).toISOString(),
            expiresAt: new Date(NOW + 60_000).toISOString(),
          },
        },
      ],
    });
    expect(reader(target)).toMatchObject({ state: 'driven', driver: { tool: 'stim device lock' } });
  });
});
