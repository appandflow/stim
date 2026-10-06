import { LogBatcher, parseLogFilter } from '../src/logs.ts';
import { protocolJsonSchema } from '../src/protocol.ts';
import Ajv2020 from 'ajv/dist/2020.js';

afterEach(() => vi.useRealTimers());

test('finite log delivery waits for congestion to clear, batches the records, and ends once', () => {
  vi.useFakeTimers();
  let buffered = 1000;
  const events: unknown[] = [];
  const batcher = new LogBatcher(
    {
      send: (records) => events.push(records),
      bufferedBytes: () => buffered,
      overflow: () => events.push('overflow'),
      ended: () => events.push('ended'),
    },
    { maxBufferedBytes: 100, maxPendingRecords: 1000 },
  );
  const records = Array.from({ length: 501 }, (_, ts) => ({ ts, msg: String(ts) }));
  for (const record of records) batcher.push(record);
  batcher.finish();
  vi.advanceTimersByTime(100);
  expect(events).toEqual([]);
  buffered = 0;
  vi.advanceTimersByTime(100);
  expect(events).toEqual([records.slice(0, 500), records.slice(500), 'ended']);
  batcher.finish();
  batcher.push({ msg: 'late' });
  vi.runAllTimers();
  expect(events).toEqual([records.slice(0, 500), records.slice(500), 'ended']);
});

test('finite delivery that exceeds the pending limit fails without sending completion', async () => {
  vi.useFakeTimers();
  const events: unknown[] = [];
  const batcher = new LogBatcher(
    {
      send: (records) => events.push(records),
      bufferedBytes: () => 0,
      overflow: () => events.push('overflow'),
      ended: () => events.push('ended'),
    },
    { maxBufferedBytes: 100, maxPendingRecords: 1 },
  );
  batcher.push({ msg: 'first' });
  batcher.push({ msg: 'second' });
  batcher.finish();
  vi.runAllTimers();
  await Promise.resolve();
  expect(events).toEqual(['overflow']);
});

test('the wire schema and log parser reject ambiguous selectors and archive path traversal', () => {
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile({
    ...protocolJsonSchema(),
    $ref: '#/$defs/ClientRequest',
  });
  for (const method of ['logs.query', 'logs.subscribe', 'replay.range', 'replay.keyframe', 'frames.subscribe']) {
    const extra = method.startsWith('logs.')
      ? {}
      : method === 'frames.subscribe'
        ? { platform: 'ios', at: 1000, video: ['h264'] }
        : method === 'replay.keyframe'
          ? { platform: 'ios', at: 1000 }
          : { platform: 'ios' };
    for (const target of [{ workspace: '/app' }, { archive: 'app--123' }]) {
      const params = { ...extra, ...target };
      expect(validate({ id: 1, method, params })).toBe(true);
    }
    for (const target of [
      {},
      { workspace: '/app', archive: 'app--123' },
      { archive: '../app' },
      { archive: 'a/b' },
      { archive: 'a\\b' },
      { archive: 'a\0b' },
    ]) {
      const params = { ...extra, ...target };
      expect(validate({ id: 1, method, params })).toBe(false);
    }
  }
  expect(parseLogFilter({ archive: 'app--123', sources: ['client'], level: 'error', tail: 2 })).toEqual({
    filter: { archive: 'app--123', sources: ['client'], level: 'error', tail: 2 },
  });
  for (const params of [{}, { workspace: '/app', archive: 'app--123' }, { archive: '../app' }, { archive: 'a\\b' }]) {
    expect(parseLogFilter(params)).toHaveProperty('error');
  }
  expect(
    validate({
      id: 1,
      method: 'frames.subscribe',
      params: { workspace: '/app', archive: 'app--123', platform: 'ios' },
    }),
  ).toBe(false);
  expect(validate({ id: 1, method: 'frames.subscribe', params: { archive: 'app--123', platform: 'ios' } })).toBe(false);
  expect(
    validate({
      id: 1,
      method: 'frames.subscribe',
      params: { archive: 'app--123', platform: 'ios', at: 1000, physical: true },
    }),
  ).toBe(false);
});
