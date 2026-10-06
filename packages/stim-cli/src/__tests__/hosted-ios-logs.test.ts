import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedIosLogsDir, readHostedIosLogsCheckpoint, readLogsSince } from '@stim-cli/core/state';
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
  vi.useRealTimers();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('queries only the exact owned simulator, persists native errors and deduplicates inclusive cursor replay', () => {
  let output = event(100, 'native failure');
  native.runFile.mockImplementation((file: string) => (file === '/usr/libexec/PlistBuddy' ? 'Fixture' : output));
  expect(collectHostedIosLogs(home, session, 'app', start)).toBe(false);
  const first = readLogsSince(hostedIosLogsDir(home), {});
  expect(first.records).toMatchObject([{ src: 'device', platform: 'ios', level: 'error', msg: 'native failure' }]);
  expect(native.runFile).toHaveBeenCalledWith(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'show',
      '--style',
      'ndjson',
      '--predicate',
      'processImagePath ENDSWITH "/App.app/Fixture"',
      '--info',
      '--start',
      '2026-10-06 12:00:00+0000',
      '--end',
      '2026-10-06 12:00:01+0000',
    ],
    expect.objectContaining({ timeoutMs: 4000, killSignal: 'SIGKILL' }),
  );
  output += `\n${event(300, 'another failure')}`;
  collectHostedIosLogs(home, session, 'app', start);
  expect(readLogsSince(hostedIosLogsDir(home), first.cursor).records.map((record) => record.msg)).toEqual([
    'another failure',
  ]);
  vi.setSystemTime(start + 2000);
  collectHostedIosLogs(home, session, 'app', start);
  expect(readLogsSince(hostedIosLogsDir(home), {}).records).toHaveLength(2);
  rmSync(join(home, 'hosted-device.json'));
  expect(readLogsSince(hostedIosLogsDir(home), {}).records.map((record) => record.msg)).toEqual([
    'native failure',
    'another failure',
  ]);
});

test('catches up a sparse eight-hour backlog in one window and preserves progress when queries fail', () => {
  vi.setSystemTime(start + 8 * 60 * 60_000);
  expect(collectHostedIosLogs(home, session, 'app', start)).toBe(false);
  expect(readHostedIosLogsCheckpoint(home)?.until).toBe(start + 8 * 60 * 60_000);
  native.runFile.mockImplementation((file: string) => {
    if (file === '/usr/libexec/PlistBuddy') return 'Fixture';
    throw new Error('simctl failed');
  });
  expect(() => collectHostedIosLogs(home, session, 'app', start)).toThrow('simctl failed');
  expect(readHostedIosLogsCheckpoint(home)?.until).toBe(start + 8 * 60 * 60_000);
});

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
  expect(readHostedIosLogsCheckpoint(home)).toMatchObject({ until: start + 60_000, windowMs: 60_000 });
  expect(collectHostedIosLogs(home, session, 'app', start)).toBe(true);
  expect(readHostedIosLogsCheckpoint(home)?.until).toBe(start + 180_000);
  expect(readLogsSince(hostedIosLogsDir(home), {}).records.map((record) => record.msg)).toEqual(['historical failure']);
});

test('overlapping windows capture late persistence and deduplicate stable events despite JSON key order', () => {
  vi.setSystemTime(start + 10_000);
  const initial = event(8000, 'already persisted');
  native.runFile.mockImplementation((file) => (file === '/usr/libexec/PlistBuddy' ? 'Fixture' : initial));
  collectHostedIosLogs(home, session, 'app', start);
  vi.setSystemTime(start + 13_000);
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(initial)).toReversed()));
  native.runFile.mockImplementation((file) =>
    file === '/usr/libexec/PlistBuddy' ? 'Fixture' : `${reordered}\n${event(9000, 'persisted later')}`,
  );
  collectHostedIosLogs(home, session, 'app', start);
  expect(readLogsSince(hostedIosLogsDir(home), {}).records.map((record) => record.msg)).toEqual([
    'already persisted',
    'persisted later',
  ]);
  expect(native.runFile.mock.calls.at(-1)?.[1]?.slice(-4)).toEqual([
    '--start',
    '2026-10-06 12:00:05+0000',
    '--end',
    '2026-10-06 12:00:14+0000',
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
  expect(readHostedIosLogsCheckpoint(home)?.until).toBe(start + 240_000);
  expect(readLogsSince(hostedIosLogsDir(home), {}).records.map((record) => record.msg)).toEqual(['stop tail']);
  expect(native.runFile.mock.calls.at(-1)?.[1]?.slice(-4)).toEqual([
    '--start',
    '2026-10-06 12:03:00+0000',
    '--end',
    '2026-10-06 12:04:01+0000',
  ]);
});
