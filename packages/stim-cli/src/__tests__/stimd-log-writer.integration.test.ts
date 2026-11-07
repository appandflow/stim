import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogWriters } from '../stimd/logs/writer.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

test('the logs worker decodes, attributes and flushes lines before closing a stream', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
  vi.stubEnv('STIM_HOME', home);
  const failure = vi.fn<(error: Error) => void>();
  const writers = createLogWriters(failure);
  try {
    const flow = vi.fn<(paused: boolean) => void>();
    const sink = await writers.open(
      {
        streamId: 'one',
        slotKey: 'ios:tablet',
        root,
        platform: 'ios',
        physical: false,
        attribution: { slot: 'tablet', deviceId: 'U1' },
      },
      flow,
    );
    sink.line(JSON.stringify({ eventType: 'logEvent', eventMessage: 'app ready' }), null);
    sink.line(JSON.stringify({ eventType: 'logEvent', eventMessage: 'x'.repeat(1024 * 1024) }), null);
    await sink.addAlias('ios:phone', { slot: 'phone', deviceId: 'U1' });
    sink.line(JSON.stringify({ eventType: 'logEvent', eventMessage: 'shared' }), null);
    await sink.removeAlias('ios:phone');
    sink.line(JSON.stringify({ eventType: 'logEvent', eventMessage: 'after removal' }), null);
    sink.writer.write({ src: 'device', event: 'collector_stopped', msg: 'stopped' });
    sink.writer.close();
    await sink.closed();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
    expect(records.filter((record) => record.msg === 'app ready')).toMatchObject([
      { src: 'device', platform: 'ios', slot: 'tablet', deviceId: 'U1' },
    ]);
    expect(records.filter((record) => record.msg === 'shared')).toMatchObject([
      { slot: 'tablet', deviceId: 'U1' },
      { slot: 'phone', deviceId: 'U1' },
    ]);
    expect(records.filter((record) => record.msg === 'after removal')).toMatchObject([
      { slot: 'tablet', deviceId: 'U1' },
    ]);
    expect(records.at(-1)).toMatchObject({ src: 'device', event: 'collector_stopped', msg: 'stopped' });
    expect(flow.mock.calls).toEqual([[true], [false]]);
    expect(failure).not.toHaveBeenCalled();
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('each stream keeps its initiating run ID through aliases and backfill', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
  vi.stubEnv('STIM_HOME', home);
  const writers = createLogWriters(() => {});
  const line = (message: string) => JSON.stringify({ eventMessage: message, timestamp: '2026-11-07T00:00:00Z' });
  try {
    const first = await writers.open(
      {
        streamId: 'one',
        slotKey: 'ios:one',
        root,
        platform: 'ios',
        physical: false,
        runId: 'run-one',
        attribution: {},
      },
      () => {},
    );
    const second = await writers.open(
      {
        streamId: 'two',
        slotKey: 'ios:two',
        root,
        platform: 'ios',
        physical: false,
        runId: 'run-two',
        attribution: {},
      },
      () => {},
    );
    const fallback = await writers.open(
      { streamId: 'fallback', slotKey: 'ios:three', root, platform: 'ios', physical: false, attribution: {} },
      () => {},
    );
    await first.addAlias('ios:alias', {});
    first.line(line('first'), null);
    second.line(line('second'), null);
    fallback.line(line('fallback'), null);
    await first.beginBackfill(0);
    first.backfillLine(line('history'), null);
    await first.endBackfill();
    for (const sink of [first, second, fallback]) {
      sink.writer.close();
      await sink.closed();
    }
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
    expect(
      records.filter((record) => record.msg === 'first' || record.msg === 'history').map((record) => record.runId),
    ).toEqual(['run-one', 'run-one', 'run-one', 'run-one']);
    expect(records.find((record) => record.msg === 'second')?.runId).toBe('run-two');
    expect(records.find((record) => record.msg === 'fallback')?.runId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('backfill deduplicates only live overlap and keeps repeated live records', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
  vi.stubEnv('STIM_HOME', home);
  const failure = vi.fn<(error: Error) => void>();
  const writers = createLogWriters(failure);
  const line = (message: string) =>
    JSON.stringify({ eventType: 'logEvent', timestamp: '2026-11-07T00:00:00.000Z', eventMessage: message });
  try {
    const sink = await writers.open(
      { streamId: 'one', slotKey: 'ios', root, platform: 'ios', physical: false, attribution: {} },
      () => {},
    );
    sink.line(line('live-first'), null);
    sink.line(line('live-first'), null);
    await sink.beginBackfill(Date.parse('2026-11-06T23:59:59.000Z'));
    sink.backfillLine(line('live-first'), null);
    sink.backfillLine(line('live-first'), null);
    sink.backfillLine(line('live-first'), null);
    sink.backfillLine(line('history-first'), null);
    await sink.endBackfill();
    sink.line(line('history-first'), null);
    sink.line(line('history-first'), null);
    await sink.beginBackfill(Date.parse('2026-11-06T23:59:59.000Z'));
    sink.backfillLine(line('live-first'), null);
    sink.backfillLine(line('live-first'), null);
    sink.backfillLine(line('history-first'), null);
    await sink.endBackfill();
    sink.writer.close();
    await sink.closed();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
    expect(records.filter((record) => record.msg === 'live-first')).toHaveLength(3);
    expect(records.filter((record) => record.msg === 'history-first')).toHaveLength(2);
    expect(failure).not.toHaveBeenCalled();
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['ios', 'android'] as const)(
  'backfill preserves distinct %s events in the same millisecond',
  async (platform) => {
    const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
    vi.stubEnv('STIM_HOME', home);
    const writers = createLogWriters(() => {});
    const ios = (timestamp: string, messageType: string, subsystem: string, category: string) =>
      JSON.stringify({ eventType: 'logEvent', timestamp, messageType, subsystem, category, eventMessage: 'same' });
    const lines =
      platform === 'ios'
        ? [
            ios('2026-11-07T00:00:00.123001Z', 'Info', 'one', 'one'),
            ios('2026-11-07T00:00:00.123001Z', 'Error', 'one', 'one'),
            ios('2026-11-07T00:00:00.123001Z', 'Info', 'two', 'one'),
            ios('2026-11-07T00:00:00.123001Z', 'Info', 'one', 'two'),
            ios('2026-11-07T00:00:00.123002Z', 'Info', 'one', 'one'),
          ]
        : [
            '1794009600.123001 100 100 I app: same',
            '1794009600.123001 100 100 E app: same',
            '1794009600.123002 100 100 I app: same',
          ];
    try {
      const sink = await writers.open(
        { streamId: 'one', slotKey: platform, root, platform, physical: false, attribution: {} },
        () => {},
      );
      const first = lines[0];
      if (!first) throw new Error('missing test event');
      sink.line(first, null);
      await sink.beginBackfill(0);
      for (const line of lines) sink.backfillLine(line, null);
      await sink.endBackfill();
      sink.writer.close();
      await sink.closed();
      const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
      expect(records.filter((record) => record.msg === 'same')).toHaveLength(lines.length);
      expect(records.filter((record) => record.level === 'error')).toHaveLength(1);
    } finally {
      await writers.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('a failed live write does not suppress a successful historical copy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
  vi.stubEnv('STIM_HOME', home);
  const writeFailure = vi.fn<(streamId: string, generation: number) => void>();
  const observed = vi.fn<(streamId: string, generation: number) => void>();
  const writers = createLogWriters(
    () => {},
    () => {},
    observed,
    writeFailure,
  );
  try {
    const path = join(workspaceLogsDir(root), 'device.ndjson');
    const sink = await writers.open(
      { streamId: 'one', slotKey: 'ios', root, platform: 'ios', physical: false, attribution: {} },
      () => {},
    );
    const line = JSON.stringify({
      eventType: 'logEvent',
      timestamp: '2026-11-07T00:00:00.000Z',
      eventMessage: 'retry',
    });
    sink.line(JSON.stringify({ eventType: 'logEvent', eventMessage: 'x'.repeat(1024 * 1024) }), null, 1);
    await sink.sync();
    expect(observed).toHaveBeenCalledWith('one', 1);
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
    sink.line(line, null, 1);
    await sink.beginBackfill(Date.parse('2026-11-06T23:59:59.000Z'));
    expect(writeFailure).toHaveBeenCalledWith('one', 1);
    rmSync(path, { recursive: true });
    sink.backfillLine(line, null);
    await sink.endBackfill();
    sink.writer.close();
    await expect(sink.closed()).rejects.toThrow('device log dropped 1 record');
    expect(parseNdjsonText(readFileSync(path, 'utf8')).filter((record) => record.msg === 'retry')).toHaveLength(1);
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed historical write rejects coverage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
  vi.stubEnv('STIM_HOME', home);
  const writers = createLogWriters(() => {});
  try {
    const path = join(workspaceLogsDir(root), 'device.ndjson');
    mkdirSync(path, { recursive: true });
    const sink = await writers.open(
      { streamId: 'one', slotKey: 'ios', root, platform: 'ios', physical: false, attribution: {} },
      () => {},
    );
    await sink.beginBackfill(0);
    sink.backfillLine(JSON.stringify({ eventType: 'logEvent', eventMessage: 'lost evidence' }), null);
    await expect(sink.endBackfill()).rejects.toThrow('could not persist');
    rmSync(path, { recursive: true });
    await expect(sink.closed()).rejects.toThrow('device log dropped');
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('two historical queries before live attachment retain their overlap counts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-log-writer-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-writer-app-')));
  vi.stubEnv('STIM_HOME', home);
  const writers = createLogWriters(() => {});
  try {
    const sink = await writers.open(
      { streamId: 'one', slotKey: 'ios', root, platform: 'ios', physical: false, attribution: {} },
      () => {},
    );
    const line = JSON.stringify({ eventType: 'logEvent', timestamp: '2026-11-07T00:00:00.000Z', eventMessage: 'cold' });
    const since = Date.parse('2026-11-06T23:59:59.000Z');
    await sink.beginBackfill(since);
    sink.backfillLine(line, null);
    await sink.endBackfill();
    await sink.beginBackfill(since);
    sink.backfillLine(line, null);
    await sink.endBackfill();
    sink.line(line, null);
    sink.writer.close();
    await sink.closed();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
    expect(records.filter((record) => record.msg === 'cold')).toHaveLength(1);
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
