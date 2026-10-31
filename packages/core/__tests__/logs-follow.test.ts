import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
