import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperHealthy, readHelperHeartbeat, readHelperRestarts } from '../state/apple-services.ts';

const logs = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const redirect = (path: import('node:fs').PathLike) =>
    typeof path === 'string' && path.startsWith('/Library/Logs/Stim/')
      ? path.replace('/Library/Logs/Stim', logs.dir)
      : path;
  return {
    ...fs,
    openSync: (path: import('node:fs').PathLike, flags: string) => fs.openSync(redirect(path), flags),
    readFileSync: (path: import('node:fs').PathLike, encoding: BufferEncoding) =>
      fs.readFileSync(redirect(path), encoding),
  };
});

beforeEach(() => {
  logs.dir = mkdtempSync(join(tmpdir(), 'stim-helper-logs-'));
  vi.stubEnv('STIM_HOME', logs.dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(logs.dir, { recursive: true, force: true });
});

const now = 10_000_000;
const row = {
  event: 'result',
  error: 0,
  at: now / 1000 - 60,
  name: 'PerfPowerServices',
  pid: 42,
  cpu: 198,
  rss: 123,
  seconds: 600,
};

test('recent helper restarts exclude failed signals, attempts, old entries and partial lines across rotation', () => {
  writeFileSync(join(logs.dir, 'helper.ndjson.1'), JSON.stringify(row));
  writeFileSync(
    join(logs.dir, 'helper.ndjson'),
    [
      { ...row, pid: 43, at: now / 1000 - 1, footprint: 456 },
      { ...row, error: 1 },
      { ...row, event: 'restart' },
      { ...row, at: now / 1000 - 3601 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n{"event":',
  );
  expect(readHelperRestarts(now)).toEqual([
    { at: now - 60_000, name: 'PerfPowerServices', pid: 42, cpu: 198, rss: 123, seconds: 600 },
    { at: now - 1000, name: 'PerfPowerServices', pid: 43, cpu: 198, rss: 123, footprint: 456, seconds: 600 },
  ]);
});

test('restart reads bound the tail and skip parsing sample events and the first partial line', () => {
  writeFileSync(
    join(logs.dir, 'helper.ndjson'),
    JSON.stringify(row).repeat(3000) +
      '\n' +
      '{"event":"sample"}\n'.repeat(100) +
      JSON.stringify({ ...row, pid: 43 }) +
      '\n',
  );
  const parse = vi.spyOn(JSON, 'parse');
  expect(readHelperRestarts(now)).toEqual([
    { at: now - 60_000, name: 'PerfPowerServices', pid: 43, cpu: 198, rss: 123, seconds: 600 },
  ]);
  expect(parse.mock.calls).toHaveLength(1);
});

test.each([
  ['fresh success', { at: (now - 179_999) / 1000, ok: true }, true],
  ['three minutes old', { at: (now - 180_000) / 1000, ok: true }, false],
  ['failed', { at: now / 1000, ok: false, error: 'process listing failed' }, false],
  ['refreshed while the check ran', { at: (now + 4_000) / 1000, ok: true }, true],
  ['more than a minute in the future', { at: (now + 60_001) / 1000, ok: true }, false],
])('a %s heartbeat determines health', (_name, heartbeat, healthy) => {
  writeFileSync(join(logs.dir, 'helper.heartbeat'), JSON.stringify(heartbeat));
  const result = readHelperHeartbeat();
  expect(result).toEqual({ ...heartbeat, at: heartbeat.at * 1000 });
  expect(helperHealthy(result, now)).toBe(healthy);
});

test('missing and malformed heartbeats never count as healthy', () => {
  expect(helperHealthy(readHelperHeartbeat(), now)).toBe(false);
  writeFileSync(join(logs.dir, 'helper.heartbeat'), '{"at":');
  expect(readHelperHeartbeat()).toBeUndefined();
  mkdirSync(join(logs.dir, 'helper.ndjson'));
  expect(readHelperRestarts(now)).toEqual([]);
});
