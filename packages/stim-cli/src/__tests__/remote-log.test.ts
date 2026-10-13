import { expect, test } from 'vitest';
import { BuildConnection } from '../offload/client.ts';
import { setRemoteLogSink } from '../remote-log.ts';
import { withAmbientContext } from '@stim-cli/core';
import { WebSocketServer } from 'ws';
import { isJsonObject } from '@stim-cli/core/state';
import { testContext } from './_context.ts';

test('a Mac that cannot be reached is written to the run log with the host and reason, never the token', async () => {
  const records: Record<string, unknown>[] = [];
  const context = testContext();
  setRemoteLogSink(context, (record) => records.push(record));
  const result = await withAmbientContext(context, () =>
    BuildConnection.open(
      { url: 'ws://127.0.0.1:1', servername: 'mini.example', host: 'mini.example' },
      'secret-token-value',
      1000,
    ),
  );
  expect(result).toMatchObject({ failure: expect.any(String) });
  expect(records).toMatchObject([
    { src: 'build', level: 'warn', event: 'remote_connect_failed', host: 'mini.example', capability: 'build' },
  ]);
  expect(JSON.stringify(records)).not.toContain('secret-token-value');
});

test('a delayed remote request failure stays with its initiating workspace after another operation starts', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message: unknown = JSON.parse(String(data));
      if (!isJsonObject(message)) throw new Error('invalid request');
      const { id, method } = message;
      socket.send(
        JSON.stringify(
          method === 'hello'
            ? { id, result: { capabilities: ['build'] } }
            : { id, error: { code: 'worker-failed', message: method } },
        ),
      );
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback port');
  const endpoint = {
    url: `ws://127.0.0.1:${address.port}`,
    host: 'test-peer',
    servername: 'test-peer',
  };
  const a = testContext({ home: '/nonexistent-home-a', runId: 'run-a' });
  const b = testContext({ home: '/nonexistent-home-b', runId: 'run-b' });
  const recordsA: Record<string, unknown>[] = [];
  const recordsB: Record<string, unknown>[] = [];
  const connections: BuildConnection[] = [];
  try {
    const first = await withAmbientContext(a, () => {
      setRemoteLogSink(a, (record) => recordsA.push(record));
      return BuildConnection.open(endpoint, 'secret-a', 1000);
    });
    expect(first).toBeInstanceOf(BuildConnection);
    if (!(first instanceof BuildConnection)) throw new Error('first connection failed');
    connections.push(first);
    const second = await withAmbientContext(b, () => {
      setRemoteLogSink(b, (record) => recordsB.push(record));
      return BuildConnection.open(endpoint, 'secret-b', 1000);
    });
    expect(second).toBeInstanceOf(BuildConnection);
    if (!(second instanceof BuildConnection)) throw new Error('second connection failed');
    connections.push(second);
    await withAmbientContext(b, () => first.request('build.first', {}));
    await withAmbientContext(a, () => second.request('build.second', {}));
    expect(recordsA).toMatchObject([{ event: 'remote_request_failed', method: 'build.first', msg: 'build.first' }]);
    expect(recordsA).toHaveLength(1);
    expect(recordsB).toMatchObject([{ event: 'remote_request_failed', method: 'build.second', msg: 'build.second' }]);
    expect(recordsB).toHaveLength(1);
    expect(JSON.stringify([recordsA, recordsB])).not.toMatch(/secret-[ab]/);
  } finally {
    for (const connection of connections) connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
