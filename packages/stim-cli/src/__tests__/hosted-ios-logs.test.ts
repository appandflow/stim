import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedNativeLogsDir, readHostedNativeLogsCheckpoint, readLogsSince } from '@stim-cli/core/state';
import { collectHostedIosLogs } from '../device-host/ios-logs.ts';

const native = vi.hoisted(() => ({ runFile: vi.fn<(file: string, args?: string[], options?: unknown) => string>() }));
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
  native.runFile.mockImplementation((file: string) => (file === '/usr/libexec/PlistBuddy' ? 'Fixture' : ''));
});
afterEach(() => {
  vi.clearAllTimers();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test.each(['{broken', null, JSON.stringify({ until: start, boundary: [], windowMs: 10995116277760000 })])(
  'collection rebuilds checkpoint %s without repeating saved records',
  (checkpoint) => {
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
    collectHostedIosLogs(home, session, 'app', start);
    const path = join(hostedNativeLogsDir(home, 'ios'), 'checkpoint.json');
    if (checkpoint === null) rmSync(path);
    else writeFileSync(path, checkpoint);
    fail = true;
    expect(() => collectHostedIosLogs(home, session, 'app', start)).toThrow('query failed during rebuild');
    expect(readHostedNativeLogsCheckpoint(home)).toBeNull();
    fail = false;
    events.push(event(9000, 'new failure'));
    expect(collectHostedIosLogs(home, session, 'app', start)).toBe(false);
    expect(readHostedNativeLogsCheckpoint(home)?.until).toBe(start + 10_000);
    expect(collectHostedIosLogs(home, session, 'app', start)).toBe(false);
    expect(readLogsSince(hostedNativeLogsDir(home, 'ios'), {}).records.map((record) => record.msg)).toEqual([
      'older saved failure',
      'saved failure',
      'another saved failure',
      'new failure',
    ]);
  },
);

test('refuses a foreign device or unsafe executable before querying native logs', () => {
  writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [], android: [], web: [] }));
  expect(() => collectHostedIosLogs(home, session, 'app', start)).toThrow(/ledger|owned/);
  expect(native.runFile).not.toHaveBeenCalled();
  writeFileSync(join(home, 'created-devices.json'), JSON.stringify({ version: 1, ios: [udid], android: [], web: [] }));
  native.runFile.mockReturnValue('Fixture" OR TRUEPREDICATE');
  expect(() => collectHostedIosLogs(home, session, 'app', start)).toThrow('log predicate');
  expect(native.runFile.mock.calls.every(([file]) => file === '/usr/libexec/PlistBuddy')).toBe(true);
});

test('shrinks a dense historical window after native failure and grows the next successful window', () => {
  vi.setSystemTime(start + 240_000);
  native.runFile.mockImplementation((file, args) => {
    if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
    if (args?.at(-1) === '2026-10-06 12:04:01+0000') throw new Error('maxBuffer exceeded');
    return event(30_000, 'historical failure');
  });
  expect(collectHostedIosLogs(home, session, 'app', start)).toBe(true);
  expect(readHostedNativeLogsCheckpoint(home)).toMatchObject({ until: start + 60_000, windowMs: 60_000 });
  expect(collectHostedIosLogs(home, session, 'app', start)).toBe(true);
  expect(readHostedNativeLogsCheckpoint(home)?.until).toBe(start + 180_000);
  expect(readLogsSince(hostedNativeLogsDir(home, 'ios'), {}).records.map((record) => record.msg)).toEqual([
    'historical failure',
  ]);
});

test('final collection shrinks toward the recent tail instead of spending its bound on old history', () => {
  vi.setSystemTime(start + 240_000);
  native.runFile.mockImplementation((file, args) => {
    if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
    if (args?.at(-3) === '2026-10-06 12:00:00+0000') throw new Error('maxBuffer exceeded');
    return event(230_000, 'stop tail');
  });
  expect(collectHostedIosLogs(home, session, 'app', start, true)).toBe(false);
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
