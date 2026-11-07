import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
