import { expect, test } from 'vitest';
import { BuildConnection } from '../offload/client.ts';
import { setRemoteLogSink } from '../remote-log.ts';
import { withAmbientContext } from '@stim-cli/core';
import { WebSocketServer } from 'ws';
import { isJsonObject } from '@stim-cli/core/state';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from './_context.ts';
import { acceptNoiseConnections, FAKE_SERVER_PUBLIC } from './_noise-server.ts';

test('a machine that cannot be reached is written to the run log with the host and reason', async () => {
  const records: Record<string, unknown>[] = [];
  const context = testContext();
  setRemoteLogSink(context, (record) => records.push(record));
  const result = await withAmbientContext(context, () =>
    BuildConnection.open(
      { url: 'ws://127.0.0.1:1', servername: 'mini.example', host: 'mini.example' },
      FAKE_SERVER_PUBLIC,
      1000,
    ),
  );
  expect(result).toMatchObject({ failure: expect.any(String) });
  expect(records).toMatchObject([
    { src: 'build', level: 'warn', event: 'remote_connect_failed', host: 'mini.example', capability: 'build' },
  ]);
});

test('a delayed remote request failure stays with its initiating workspace after another operation starts', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  acceptNoiseConnections(server, (socket) => {
    socket.on('message', (data: Buffer) => {
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
  const homes = [mkdtempSync(join(tmpdir(), 'stim-remote-log-a-')), mkdtempSync(join(tmpdir(), 'stim-remote-log-b-'))];
  const a = testContext({ home: homes[0], runId: 'run-a' });
  const b = testContext({ home: homes[1], runId: 'run-b' });
  const recordsA: Record<string, unknown>[] = [];
  const recordsB: Record<string, unknown>[] = [];
  const connections: BuildConnection[] = [];
  try {
    const first = await withAmbientContext(a, () => {
      setRemoteLogSink(a, (record) => recordsA.push(record));
      return BuildConnection.open(endpoint, FAKE_SERVER_PUBLIC, 1000);
    });
    expect(first).toBeInstanceOf(BuildConnection);
    if (!(first instanceof BuildConnection)) throw new Error('first connection failed');
    connections.push(first);
    const second = await withAmbientContext(b, () => {
      setRemoteLogSink(b, (record) => recordsB.push(record));
      return BuildConnection.open(endpoint, FAKE_SERVER_PUBLIC, 1000);
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
  } finally {
    for (const connection of connections) connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});
