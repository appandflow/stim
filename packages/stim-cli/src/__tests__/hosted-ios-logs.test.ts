import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedNativeLogsDir, readHostedNativeLogsCheckpoint, readLogsSince } from '@stim-cli/core/state';
import { collectHostedIosLogs } from '../device-host/ios-logs.ts';

const native = vi.hoisted(() => ({
  runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>(),
  runFileQuietAsync: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('../exec.ts', () => ({ getExecutor: () => native }));
let root: string;
let home: string;
const session = '12345678-1234-1234-1234-123456789abc';
const udid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const start = Date.parse('2026-10-06T12:00:00Z');
const event = (offset: number, message: string) =>
  JSON.stringify({
    timestamp: new Date(start + offset).toISOString(),
    eventType: 'logEvent',
    messageType: 'Error',
    eventMessage: message,
    processImagePath: '/private/App.app/Fixture',
  });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-ios-log-worker-'));
  home = join(root, 'home');
  process.env.STIM_HOME = home;
  mkdirSync(home);
  writeFileSync(
    join(home, 'hosted-device.json'),
    JSON.stringify({
      udid,
      name: 'stim-owned',
      deviceType: 'iPhone',
      runtime: '27.0',
      deviceTypeId: 'iphone',
      runtimeId: 'ios',
      architecture: 'arm64',
    }),
  );
  writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [udid], android: [], web: [] }));
  const area = join(root, 'apps', 'app');
  mkdirSync(join(area, 'App.app'), { recursive: true });
  writeFileSync(
    join(area, 'receipt.json'),
    JSON.stringify({
      session,
      attempt: 'app',
      bundleId: 'dev.fixture',
      mode: 'release',
      manifest: { size: 1, sha256: createHash('sha256').update('x').digest('hex') },
      state: 'installed',
      launched: true,
    }),
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start + 500);
  native.runFile.mockReset();
  native.runFileQuietAsync.mockReset();
  native.runFile.mockImplementation((file: string) => (file === '/usr/libexec/PlistBuddy' ? 'Fixture' : ''));
});
afterEach(() => {
  vi.clearAllTimers();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test.each(['{broken', null, JSON.stringify({ until: start, boundary: [], windowMs: 10995116277760000 })])(
  'collection rebuilds checkpoint %s without repeating saved records',
  async (checkpoint) => {
    const events = [
      event(1100, 'older saved failure'),
      event(8100, 'saved failure'),
      event(8100, 'another saved failure'),
    ];
    let fail = false;
    native.runFile.mockImplementation((file, args = []) => {
      if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
      if (fail) throw new Error('query failed during rebuild');
      const from = Date.parse(args[args.indexOf('--start') + 1]!);
      const until = Date.parse(args[args.indexOf('--end') + 1]!);
      return events
        .filter((line) => {
          const ts = Date.parse(JSON.parse(line).timestamp);
          return ts >= from && ts <= until;
        })
        .join('\n');
    });
    vi.setSystemTime(start + 10_000);
    await collectHostedIosLogs(home, session, 'app', start, { HOME: root });
    const path = join(hostedNativeLogsDir(home, 'ios'), 'checkpoint.json');
    if (checkpoint === null) rmSync(path);
    else writeFileSync(path, checkpoint);
    fail = true;
    await expect(collectHostedIosLogs(home, session, 'app', start, { HOME: root })).rejects.toThrow(
      'query failed during rebuild',
    );
    expect(readHostedNativeLogsCheckpoint(home)).toBeNull();
    fail = false;
    events.push(event(9000, 'new failure'));
    expect(await collectHostedIosLogs(home, session, 'app', start, { HOME: root })).toBe(false);
    expect(readHostedNativeLogsCheckpoint(home)?.until).toBe(start + 10_000);
    expect(await collectHostedIosLogs(home, session, 'app', start, { HOME: root })).toBe(false);
    expect(readLogsSince(hostedNativeLogsDir(home, 'ios'), {}).records.map((record) => record.msg)).toEqual([
      'older saved failure',
      'saved failure',
      'another saved failure',
      'new failure',
    ]);
  },
);

test('refuses a foreign device or unsafe executable before querying native logs', async () => {
  writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [], android: [], web: [] }));
  await expect(collectHostedIosLogs(home, session, 'app', start, { HOME: root })).rejects.toThrow(/ledger|owned/);
  expect(native.runFile).not.toHaveBeenCalled();
  writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [udid], android: [], web: [] }));
  native.runFile.mockReturnValue('Fixture" OR TRUEPREDICATE');
  await expect(collectHostedIosLogs(home, session, 'app', start, { HOME: root })).rejects.toThrow('log predicate');
  expect(native.runFile.mock.calls.every(([file]) => file === '/usr/libexec/PlistBuddy')).toBe(true);
});

test('shrinks a dense historical window after native failure and grows the next successful window', async () => {
  vi.setSystemTime(start + 240_000);
  native.runFile.mockImplementation((file, args) => {
    if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
    if (args?.at(-1) === '2026-10-06 12:04:01+0000') throw new Error('maxBuffer exceeded');
    return event(30_000, 'historical failure');
  });
  expect(await collectHostedIosLogs(home, session, 'app', start, { HOME: root })).toBe(true);
  expect(readHostedNativeLogsCheckpoint(home)).toMatchObject({ until: start + 60_000, windowMs: 60_000 });
  expect(await collectHostedIosLogs(home, session, 'app', start, { HOME: root })).toBe(true);
  expect(readHostedNativeLogsCheckpoint(home)?.until).toBe(start + 180_000);
  expect(readLogsSince(hostedNativeLogsDir(home, 'ios'), {}).records.map((record) => record.msg)).toEqual([
    'historical failure',
  ]);
});

test('final collection shrinks toward the recent tail instead of spending its bound on old history', async () => {
  vi.setSystemTime(start + 240_000);
  native.runFile.mockImplementation((file, args) => {
    if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
    if (args?.at(-3) === '2026-10-06 12:00:00+0000') throw new Error('maxBuffer exceeded');
    return event(230_000, 'stop tail');
  });
  expect(await collectHostedIosLogs(home, session, 'app', start, { HOME: root }, true)).toBe(false);
  expect(readHostedNativeLogsCheckpoint(home)?.until).toBe(start + 240_000);
  expect(readLogsSince(hostedNativeLogsDir(home, 'ios'), {}).records).toMatchObject([
    {
      src: 'device',
      platform: 'ios',
      level: 'warn',
      msg: expect.stringContaining('[2026-10-06T12:00:00.000Z, 2026-10-06T12:03:00.000Z)'),
    },
    { msg: 'stop tail' },
  ]);
  expect(native.runFile.mock.calls.at(-1)?.[1]?.slice(-4)).toEqual([
    '--start',
    '2026-10-06 12:03:00+0000',
    '--end',
    '2026-10-06 12:04:01+0000',
  ]);
});

test('hosted iOS keeps bounded exact-device crashes across log rotation without waiting for host symbols', async () => {
  const directory = join(root, 'Library', 'Logs', 'DiagnosticReports');
  mkdirSync(directory, { recursive: true });
  const report = {
    captureTime: new Date(start + 1000).toISOString(),
    coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
    incident: 'owned-incident',
    bundleInfo: { CFBundleIdentifier: 'dev.fixture' },
    exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
    usedImages: [{ path: '/app/App.app/Fixture', uuid: 'fixture-uuid', arch: 'arm64', base: 4096 }],
    termination: { namespace: 'SIGNAL', reasons: [`${root}/${udid}/App.app crashed ` + 'x'.repeat(1024 * 1024)] },
    threads: [
      {
        triggered: true,
        frames: Array.from({ length: 64 }, () => ({
          sourceFile: `${root}/${udid}/Fixture.m`,
          symbol: 'abort',
          imageIndex: 0,
          imageOffset: 16,
        })),
      },
    ],
  };
  for (const [name, value] of [
    ['owned', report],
    ['older-owned', { ...report, incident: 'older-owned', captureTime: new Date(start + 500).toISOString() }],
    [
      'foreign-device',
      { ...report, incident: 'foreign-device', coalitionName: 'com.apple.CoreSimulator.SimDevice.OTHER' },
    ],
    ['foreign-app', { ...report, incident: 'foreign-app', bundleInfo: { CFBundleIdentifier: 'another.app' } }],
    ['old', { ...report, incident: 'old', captureTime: new Date(start - 1000).toISOString() }],
  ])
    writeFileSync(join(directory, `${name}.ips`), '{}\n' + JSON.stringify(value));
  writeFileSync(join(root, 'apps', 'app', 'App.app', 'Fixture'), 'fixture');
  native.runFileQuietAsync.mockImplementation(async () => {
    vi.setSystemTime(start + 20_000);
    throw new DOMException('symbolication deadline expired', 'TimeoutError');
  });
  native.runFile.mockImplementation((file) => {
    if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
    throw new Error('console unavailable');
  });
  vi.setSystemTime(start + 10_000);
  await expect(collectHostedIosLogs(home, session, 'app', start, { HOME: root })).rejects.toThrow(
    'console unavailable',
  );
  const logs = hostedNativeLogsDir(home, 'ios');
  const page = readLogsSince(logs, {});
  expect(page.more).toBe(false);
  expect(page.records.map((record) => record.incident).toSorted()).toEqual(['older-owned', 'owned-incident']);
  const captured = page.records.find((record) => record.incident === 'owned-incident');
  expect(captured).toMatchObject({
    ts: start + 1000,
    event: 'native_crash',
    incident: 'owned-incident',
    appId: 'dev.fixture',
    level: 'fatal',
  });
  expect(captured).not.toHaveProperty('deviceId');
  expect(captured).not.toHaveProperty('rawReport');
  const serialized = JSON.stringify(captured);
  expect(serialized).not.toContain(udid);
  expect(serialized).not.toContain(root);
  expect(Buffer.byteLength(serialized)).toBeLessThan(256 * 1024);
  const crashLog = join(logs, 'native-crashes.ndjson');
  renameSync(crashLog, `${crashLog}.1`);
  writeFileSync(crashLog, '');
  for (const name of ['device.ndjson', 'device.ndjson.1'])
    writeFileSync(join(logs, name), JSON.stringify({ ts: start + 2000, msg: 'console churn' }) + '\n');
  await expect(collectHostedIosLogs(home, session, 'app', start, { HOME: root })).rejects.toThrow(
    'console unavailable',
  );
  expect(readLogsSince(logs, {}).records.filter((record) => record.event === 'native_crash')).toEqual([]);
  expect(readFileSync(join(directory, 'owned.ips'), 'utf8')).toBe('{}\n' + JSON.stringify(report));
});
