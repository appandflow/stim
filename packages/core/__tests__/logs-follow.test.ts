import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openLogDir } from '../state/log-reader.ts';
import { followLogs } from '../state/logs-query.ts';
import type { NdjsonRecord } from '../state/ndjson.ts';

let root: string;
const stops: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-follow-events-'));
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});
const line = (msg: string, level = 'info') => `${JSON.stringify({ ts: 1, src: 'client', level, msg })}\n`;

function following(dir = root, errorContext?: 'field') {
  const records: NdjsonRecord[] = [];
  const stop = followLogs({
    dir,
    criteria: { minLevel: errorContext ? 'error' : 'info' },
    errorContext,
    onRecord: (record) => records.push(record),
  });
  stops.push(stop);
  return { records, stop };
}

test('default following delivers file events, split UTF-8 and late files, and stops without late records', async () => {
  writeFileSync(join(root, 'a.ndjson'), line('before following'));
  const { records, stop } = following();
  const bytes = Buffer.from(line('\u4f60\u597d'));
  const split = bytes.indexOf(Buffer.from('\u4f60')) + 1;
  appendFileSync(join(root, 'a.ndjson'), bytes.subarray(0, split));
  writeFileSync(join(root, 'z.ndjson'), line('barrier'));
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['barrier']));
  appendFileSync(join(root, 'a.ndjson'), bytes.subarray(split));
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['barrier', '\u4f60\u597d']));
  writeFileSync(join(root, 'late.ndjson'), line('filtered', 'debug') + line('late'));
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['barrier', '\u4f60\u597d', 'late']));
  stop();
  stop();
  appendFileSync(join(root, 'late.ndjson'), line('after stop'));
  await delay(600);
  expect(records.map((record) => record.msg)).toEqual(['barrier', '\u4f60\u597d', 'late']);
});

test('following starts before the directory exists and reattaches after directory replacement', async () => {
  const dir = join(root, 'logs');
  const { records } = following(dir);
  mkdirSync(dir);
  writeFileSync(join(dir, 'client.ndjson'), line('first'));
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['first']), { timeout: 2000 });
  renameSync(dir, join(root, 'old-logs'));
  mkdirSync(dir);
  writeFileSync(join(dir, 'new.ndjson'), line('replacement'));
  // Windows does not notify moves of a watched directory: https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['first', 'replacement']), {
    timeout: process.platform === 'win32' ? 12_000 : 2000,
  });
  appendFileSync(join(dir, 'new.ndjson'), line('appended'));
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['first', 'replacement', 'appended']));
});

test('default following drains the previous rotation before reading its smaller replacement', async () => {
  writeFileSync(join(root, 'metro.ndjson'), line('before following, with a longer initial record'));
  const { records } = following();
  appendFileSync(join(root, 'metro.ndjson'), line('before rotation'));
  renameSync(join(root, 'metro.ndjson'), join(root, 'metro.ndjson.1'));
  writeFileSync(join(root, 'metro.ndjson'), line('new'));
  await vi.waitFor(() => expect(records.map((record) => record.msg)).toEqual(['before rotation', 'new']));
});

test('default following reads a replacement file that is larger than the previous offset from its first record', async () => {
  writeFileSync(join(root, 'client.ndjson'), line('before following'));
  const { records } = following();
  appendFileSync(join(root, 'client.ndjson'), line('before rotation'));
  renameSync(join(root, 'client.ndjson'), join(root, 'client.ndjson.1'));
  writeFileSync(
    join(root, 'client.ndjson'),
    line('a replacement record much longer than the old file') + line('after'),
  );
  await vi.waitFor(() =>
    expect(records.map((record) => record.msg)).toEqual([
      'before rotation',
      'a replacement record much longer than the old file',
      'after',
    ]),
  );
});

test('following from a log view recognizes a larger replacement made after the view was opened', async () => {
  writeFileSync(join(root, 'client.ndjson'), line('backfilled'));
  const view = await openLogDir(root);
  const records: NdjsonRecord[] = [];
  appendFileSync(join(root, 'client.ndjson'), line('before rotation'));
  renameSync(join(root, 'client.ndjson'), join(root, 'client.ndjson.1'));
  writeFileSync(
    join(root, 'client.ndjson'),
    line('a replacement record much longer than the old file') + line('after'),
  );
  stops.push(
    followLogs({
      dir: root,
      offsets: view.sizes,
      identities: view.identities,
      criteria: { minLevel: 'info' },
      onRecord: (record) => records.push(record),
    }),
  );
  await view.close();
  await vi.waitFor(() =>
    expect(records.map((record) => record.msg)).toEqual([
      'before rotation',
      'a replacement record much longer than the old file',
      'after',
    ]),
  );
});

test('filesystem hints preserve Expo context until a quiet settle, including without another write', async () => {
  const { records } = following(root, 'field');
  const expo = (msg: string, level: string) =>
    `${JSON.stringify({ ts: 1, src: 'metro', raw: true, event: 'expo_stdout', level, msg })}\n`;
  writeFileSync(join(root, 'metro.ndjson'), expo(' ERROR  broken', 'error') + expo('  3 |', 'info'));
  await delay(100);
  writeFileSync(join(root, 'other.ndjson'), line('other error', 'error'));
  await delay(100);
  expect(records).toEqual([]);
  appendFileSync(join(root, 'metro.ndjson'), expo('    at a (/app/a.js:1:2)', 'info'));
  await vi.waitFor(
    () =>
      expect(records.map((record) => [record.msg, record.context])).toEqual([
        [' ERROR  broken', ['  3 |', '    at a (/app/a.js:1:2)']],
        ['other error', undefined],
      ]),
    { timeout: 2000 },
  );
});

test('startup and repair deadlines read appends even when no filesystem notification has run', () => {
  vi.useFakeTimers();
  writeFileSync(join(root, 'client.ndjson'), '');
  const { records } = following();
  appendFileSync(join(root, 'client.ndjson'), line('startup'));
  vi.advanceTimersByTime(500);
  expect(records.map((record) => record.msg)).toEqual(['startup']);
  appendFileSync(join(root, 'client.ndjson'), line('repair'));
  vi.advanceTimersByTime(10_000);
  expect(records.map((record) => record.msg)).toEqual(['startup', 'repair']);
});

test('Expo settling reads stack appends whose filesystem notification was missed', () => {
  vi.useFakeTimers();
  const original = fs.watch;
  let hint: (() => void) | undefined;
  vi.spyOn(fs, 'watch').mockImplementation(
    (path: fs.PathLike, _options: fs.WatchOptions | fs.WatchListener<string>, listener?: fs.WatchListener<string>) => {
      hint = () => {
        if (typeof listener === 'function') listener('change', 'metro.ndjson');
      };
      return original(path, { persistent: false });
    },
  );
  syncBuiltinESMExports();
  writeFileSync(join(root, 'metro.ndjson'), '');
  const { records } = following(root, 'field');
  vi.advanceTimersByTime(600);
  const expo = (msg: string, level: string) =>
    `${JSON.stringify({ ts: 1, src: 'metro', raw: true, event: 'expo_stdout', level, msg })}\n`;
  appendFileSync(join(root, 'metro.ndjson'), expo(' ERROR  broken', 'error'));
  assert(hint);
  hint();
  vi.advanceTimersByTime(0);
  vi.advanceTimersByTime(200);
  appendFileSync(join(root, 'metro.ndjson'), expo('    at a (/app/a.js:1:2)', 'info'));
  vi.advanceTimersByTime(800);
  expect(records.map((record) => [record.msg, record.context])).toEqual([
    [' ERROR  broken', ['    at a (/app/a.js:1:2)']],
  ]);
});
