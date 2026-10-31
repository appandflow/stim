import { mkdtemp, mkdir, writeFile, rm, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { openLogDir } from '../state/log-reader.ts';
import { queryJsonLogs, readLogRecords, readLogTimeline, sortByTs } from '../state/logs-query.ts';
import type { NdjsonRecord } from '../state/ndjson.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stim-log-reader-'));
  directories.push(dir);
  return dir;
}
function lines(records: NdjsonRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

test('bounded tails preserve timeline ordering, marker windows, slot filtering, crash inclusion and Expo context', async () => {
  const dir = await directory();
  const records: NdjsonRecord[] = [
    { ts: 1, src: 'device', platform: 'ios', slot: 'second', marker: true, msg: 'launch' },
    { ts: 2, src: 'metro', marker: true, msg: 'iOS Bundled 1ms' },
    { ts: 3, src: 'metro', level: 'error', raw: true, event: 'expo_stderr', msg: 'ERROR boom' },
    { ts: 4, src: 'metro', level: 'info', raw: true, event: 'expo_stderr', msg: 'Code: app.tsx' },
    { ts: 5, src: 'metro', level: 'info', raw: true, event: 'expo_stderr', msg: '  1 | throw Error()' },
    { ts: 6, src: 'client', level: 'error', msg: 'client error' },
    { ts: 7, src: 'device', level: 'error', platform: 'ios', slot: 'second', msg: 'device error' },
    { ts: 7, src: 'device', platform: 'android', slot: 'third', level: 'fatal', msg: 'other device' },
    { src: 'build', level: 'error', msg: 'timestamp absent', details: { ts: 100 } },
  ];
  await writeFile(join(dir, 'metro.ndjson'), lines(records.toReversed()));
  await writeFile(
    join(dir, 'native-crash-a.ndjson'),
    lines([
      { ts: 7, src: 'device', event: 'native_crash', platform: 'ios', slot: 'second', level: 'fatal', msg: 'crash' },
    ]),
  );
  await writeFile(join(dir, 'build.ndjson.1'), lines([{ ts: 7, src: 'build', level: 'error', msg: 'rotated' }]));
  await writeFile(join(dir, 'build.ndjson'), lines([{ ts: 7, src: 'build', level: 'info', msg: 'current' }]));
  const extra = [{ ts: 7, src: 'agent', level: 'info', msg: 'action' }];
  const queries = [
    { tail: 0 },
    { tail: 1 },
    { tail: 4 },
    { errorsOnly: true },
    { errorsOnly: true, tail: 2 },
    { slot: 'second', errorsOnly: true },
    { sources: ['metro'], errorsOnly: true },
    { sources: ['device'], errorsOnly: true },
    { since: '5m', now: 10 },
    { grep: 'error', tail: 3 },
    { slot: 'missing' },
  ];
  for (const order of ['timeline', 'name'] as const) {
    const view = await openLogDir(dir, { order });
    try {
      const baseline = sortByTs([...(order === 'timeline' ? readLogTimeline(dir) : readLogRecords(dir)), ...extra]);
      for (const query of queries)
        expect(await view.query({ ...query, extra })).toEqual(queryJsonLogs({ ...query, records: baseline }));
      expect((await view.query({ errorsOnly: true })).find((record) => record.msg === 'ERROR boom')?.context).toEqual([
        'Code: app.tsx',
        '  1 | throw Error()',
      ]);
    } finally {
      await view.close();
    }
  }
});

test('valid JSON whitespace and nested fields cannot hide markers or skew timestamp bounds', async () => {
  const dir = await directory();
  await mkdir(join(dir, 'irrelevant.ndjson'));
  const records = [
    { ts: 1, src: 'device', marker: true, platform: 'ios', slot: 'second' },
    { ts: 2, src: 'metro', level: 'error', msg: 'current', details: { ts: 999 } },
    { ts: 0, src: 'device', slot: 'second', level: 'error', msg: 'old' },
  ];
  await writeFile(
    join(dir, 'device.ndjson'),
    records.map((record) => JSON.stringify(record, null, 0).replaceAll(':', ': ')).join('\n') + '\ninvalid\n',
  );
  const view = await openLogDir(dir);
  try {
    expect(await view.query({ slot: 'second', errorsOnly: true, tail: 1 })).toEqual(
      queryJsonLogs({ records: readLogTimeline(dir), slot: 'second', errorsOnly: true, tail: 1 }),
    );
  } finally {
    await view.close();
  }
});

test('cold indexing yields so an abort can stop a large query before the timeline finishes', async () => {
  const dir = await directory();
  await writeFile(
    join(dir, 'build.ndjson'),
    lines(Array.from({ length: 30_000 }, (_, ts) => ({ ts, src: 'build', level: 'info', msg: 'x'.repeat(200) }))),
  );
  const controller = new AbortController();
  const query = openLogDir(dir, { signal: controller.signal });
  setImmediate(() => controller.abort(new Error('cancelled during read')));
  await expect(query).rejects.toThrow('cancelled during read');
  await expect(openLogDir(dir, { signal: controller.signal })).rejects.toThrow('cancelled during read');
});

test('a cancelled reader does not wait for another reader to finish its shared cold index', async () => {
  const dir = await directory();
  await writeFile(
    join(dir, 'build.ndjson'),
    lines(Array.from({ length: 30_000 }, (_, ts) => ({ ts, src: 'build', msg: 'x'.repeat(200) }))),
  );
  const first = openLogDir(dir);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = openLogDir(dir, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  const view = await first;
  try {
    expect(await view.query({ tail: 1 })).toEqual([{ ts: 29_999, src: 'build', msg: 'x'.repeat(200) }]);
  } finally {
    await view.close();
  }
});

test('a writer truncating during indexing cannot make the reader loop at EOF', async () => {
  const dir = await directory();
  const path = join(dir, 'build.ndjson');
  await writeFile(path, lines(Array.from({ length: 2_000 }, (_, ts) => ({ ts, src: 'build', msg: 'x'.repeat(100) }))));
  const handle = await openFile(path, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = prototype.read;
  let truncated = false;
  const read = vi.spyOn(prototype, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (!truncated && typeof args[3] === 'number' && args[3] > 0) {
      truncated = true;
      await writeFile(path, '{"ts":3');
    }
    return Reflect.apply(original, this, args);
  });
  try {
    const view = await openLogDir(dir);
    try {
      expect(truncated).toBe(true);
      expect(await view.query()).toEqual([]);
    } finally {
      await view.close();
    }
  } finally {
    read.mockRestore();
  }
});
