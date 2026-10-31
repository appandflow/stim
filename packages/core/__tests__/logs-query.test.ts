import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryLogs, followLogs } from '../state/logs-query.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-logsq-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, records: unknown[]) {
  writeFileSync(join(dir, name), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

describe('queryLogs', () => {
  test('--since is relative to the injected now', () => {
    writeLog('metro.ndjson', [
      { ts: 1000, src: 'metro', level: 'info', msg: 'old' },
      { ts: 9000, src: 'metro', level: 'info', msg: 'recent' },
    ]);
    expect(queryLogs({ dir, since: '5s', now: 10000 }).map((r) => r.msg)).toEqual(['recent']);
  });

  test('an unparseable --since throws a structured error rather than returning nothing', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'a' }]);
    expect(() => queryLogs({ dir, since: 'soon' })).toThrow(/soon/);
  });
});

describe('incremental tailing', () => {
  test('follow emits records written just before a rotation, then the new file', () => {
    vi.useFakeTimers();
    try {
      const line = (msg: string) => `${JSON.stringify({ ts: 1, src: 'metro', level: 'info', msg })}\n`;
      writeFileSync(join(dir, 'metro.ndjson'), line('before follow') + line('also before'));
      const seen: unknown[] = [];
      const stop = followLogs({ dir, onRecord: (record) => seen.push(record.msg), intervalMs: 100 });
      appendFileSync(join(dir, 'metro.ndjson'), line('before rotation'));
      renameSync(join(dir, 'metro.ndjson'), join(dir, 'metro.ndjson.1'));
      writeFileSync(join(dir, 'metro.ndjson'), line('after rotation'));
      vi.advanceTimersByTime(100);
      stop();
      expect(seen).toEqual(['before rotation', 'after rotation']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('follow holds an Expo error until a poll adds no more of its lines, then attaches them', () => {
    vi.useFakeTimers();
    try {
      const expo = (level: string, msg: string) =>
        `${JSON.stringify({ ts: 1, src: 'metro', level, raw: true, event: 'expo_stdout', msg })}\n`;
      const response = `${JSON.stringify({ ts: 1, src: 'metro', level: 'error', event: 'bundle_response_failed', msg: 'ios bundle response failed' })}\n`;
      writeFileSync(join(dir, 'metro.ndjson'), '');
      const seen: Record<string, unknown>[] = [];
      const stop = followLogs({
        dir,
        onRecord: (record) => seen.push(record),
        criteria: { minLevel: 'error' },
        intervalMs: 100,
        errorContext: 'field',
      });
      appendFileSync(
        join(dir, 'metro.ndjson'),
        expo('error', ' ERROR  SyntaxError: App.js: Unexpected token') + expo('info', '  3 |') + response,
      );
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([]);
      appendFileSync(
        join(dir, 'metro.ndjson'),
        expo('info', '> 5 |   const broken = {;') + expo('info', '    at parse (/app/index.js:1:2)'),
      );
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(seen.map((record) => [record.msg, record.context])).toEqual([
        [
          ' ERROR  SyntaxError: App.js: Unexpected token',
          ['  3 |', '> 5 |   const broken = {;', '    at parse (/app/index.js:1:2)'],
        ],
        ['ios bundle response failed', undefined],
      ]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

test('a page load windows the web page records, and a native launch windows everything else', () => {
  writeLog('build-ios.ndjson', [{ ts: 1, src: 'build', level: 'info', marker: true, platform: 'ios' }]);
  writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: 'app threw' }]);
  writeLog('device.ndjson', [{ ts: 2, src: 'device', level: 'fatal', event: 'native_crash', msg: 'app crashed' }]);
  writeLog('web.ndjson', [
    { ts: 3, src: 'device', platform: 'web', level: 'info', event: 'web_navigation', marker: true },
    { ts: 4, src: 'device', platform: 'web', level: 'error', msg: 'earlier load failed' },
    { ts: 4, src: 'client', platform: 'web', level: 'error', msg: 'earlier page threw' },
    { ts: 6, src: 'device', platform: 'web', level: 'info', event: 'web_navigation', marker: true },
    { ts: 6, src: 'device', platform: 'web', level: 'error', msg: 'load failed in the same millisecond' },
    { ts: 7, src: 'client', platform: 'web', level: 'error', msg: 'page threw' },
  ]);
  const errors = () => queryLogs({ dir, errorsOnly: true }).map((record) => record.msg);
  expect(errors()).toEqual(['app threw', 'app crashed', 'load failed in the same millisecond', 'page threw']);

  writeLog('build-ios.ndjson', [{ ts: 8, src: 'build', level: 'info', marker: true, platform: 'ios' }]);
  expect(errors()).toEqual(['load failed in the same millisecond', 'page threw']);
});

test('a sibling launch marker does not hide errors from the selected slot', () => {
  writeLog('build-ios-phone.ndjson', [
    { ts: 1, src: 'build', marker: true, slot: 'phone' },
    { ts: 2, src: 'build', level: 'error', msg: 'phone failed', slot: 'phone' },
  ]);
  writeLog('build-ios-tablet.ndjson', [
    { ts: 3, src: 'build', marker: true, slot: 'tablet' },
    { ts: 4, src: 'build', level: 'error', msg: 'tablet failed', slot: 'tablet' },
  ]);
  expect(queryLogs({ dir, errorsOnly: true }).map((record) => record.msg)).toEqual(['phone failed', 'tablet failed']);
  expect(queryLogs({ dir, slot: 'phone', errorsOnly: true }).map((record) => record.msg)).toEqual(['phone failed']);
  expect(queryLogs({ dir, slot: 'tablet', errorsOnly: true }).map((record) => record.msg)).toEqual(['tablet failed']);
});
