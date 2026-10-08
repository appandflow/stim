import { afterEach, expect, test } from 'vitest';
import { BuildConnection } from '../offload/client.ts';
import { setRemoteLogSink } from '../remote-log.ts';

afterEach(() => setRemoteLogSink(null));

test('a Mac that cannot be reached is written to the run log with the host and reason, never the token', async () => {
  const records: Record<string, unknown>[] = [];
  setRemoteLogSink((record) => records.push(record));
  const result = await BuildConnection.open(
    { url: 'ws://127.0.0.1:1', servername: 'mini.example', host: 'mini.example' },
    'secret-token-value',
    1000,
  );
  expect(result).toMatchObject({ failure: expect.any(String) });
  expect(records).toMatchObject([
    { src: 'build', level: 'warn', event: 'remote_connect_failed', host: 'mini.example', capability: 'build' },
  ]);
  expect(JSON.stringify(records)).not.toContain('secret-token-value');
});
