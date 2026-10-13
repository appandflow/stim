import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { withAmbientContext } from '@stim-cli/core';
import { WebSocketServer } from 'ws';
import { BuildConnection } from '../offload/client.ts';
import { getExecutor } from '../exec.ts';
import { testContext } from './_context.ts';

let directory: string;
let exitListeners: ReturnType<typeof process.rawListeners>;
const servers: WebSocketServer[] = [];
const connections: BuildConnection[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stim-offload-lifecycle-'));
  process.env.STIM_HOME = join(directory, 'home');
  mkdirSync(process.env.STIM_HOME);
  exitListeners = process.rawListeners('exit');
});

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const listener of process.rawListeners('exit')) {
    if (!exitListeners.includes(listener)) process.removeListener('exit', listener);
  }
  delete process.env.STIM_HOME;
  rmSync(directory, { recursive: true, force: true });
});

async function peer() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP server');
  let close!: (code: number) => void;
  const closed = new Promise<number>((resolve) => (close = resolve));
  server.on('connection', (socket) => {
    socket.once('close', close);
    socket.once('message', (data) => {
      const request = JSON.parse(String(data));
      socket.send(JSON.stringify({ id: request.id, result: { capabilities: ['build'] } }));
    });
  });
  return {
    endpoint: { url: `ws://127.0.0.1:${address.port}`, host: '127.0.0.1', servername: 'localhost' },
    closed,
  };
}

test('embedding remote connections leaves the host exit and signal listeners unchanged', async () => {
  const before = ['exit', 'SIGINT', 'SIGTERM'].map((event) => process.rawListeners(event));
  const peers = await Promise.all(
    [testContext({ runId: 'first' }), testContext({ runId: 'second' })].map(async (context) => {
      const machine = await peer();
      const connection = await withAmbientContext(context, () =>
        BuildConnection.open(machine.endpoint, 'test-token', 1000),
      );
      if (!(connection instanceof BuildConnection)) throw new Error(connection.failure);
      connections.push(connection);
      return machine;
    }),
  );
  expect(['exit', 'SIGINT', 'SIGTERM'].map((event) => process.rawListeners(event))).toEqual(before);
  for (const connection of connections) connection.close();
  await Promise.all(peers.map((machine) => machine.closed));
  expect(['exit', 'SIGINT', 'SIGTERM'].map((event) => process.rawListeners(event))).toEqual(before);
});

test('a second CLI interrupt still closes its remote connection cleanly', async () => {
  const machine = await peer();
  const script = join(directory, 'cli.mjs');
  const client = new URL('../offload/client.ts', import.meta.url).href;
  const cliOperation = new URL('../cli-operation.ts', import.meta.url).href;
  const operationState = new URL('../engine/operation-state.ts', import.meta.url).href;
  const core = new URL('../../../core/dist/index.mjs', import.meta.url).href;
  writeFileSync(
    script,
    [
      `const { BuildConnection } = await import(${JSON.stringify(client)});`,
      `const { processOperation } = await import(${JSON.stringify(cliOperation)});`,
      `const { withDrainingCancellation } = await import(${JSON.stringify(operationState)});`,
      `const { withAmbientContext } = await import(${JSON.stringify(core)});`,
      'const operation = processOperation(process.argv[2]);',
      'operation.listen();',
      'await withAmbientContext(operation.context, async () => {',
      `  const connection = await BuildConnection.open(${JSON.stringify(machine.endpoint)}, "test-token", 1000);`,
      '  if (!(connection instanceof BuildConnection)) throw new Error(connection.failure);',
      '  const holding = withDrainingCancellation(operation.context, operation.context.signal, () => new Promise(() => {}));',
      '  operation.cancel("SIGINT");',
      '  operation.cancel("SIGINT");',
      '  await holding;',
      '});',
    ].join('\n'),
  );
  const child = getExecutor().spawn(process.execPath, ['--experimental-strip-types', script, directory], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
  children.push(child);
  let errors = '';
  child.stderr?.on('data', (chunk) => (errors += chunk));
  const [code, signal] = await once(child, 'exit');
  expect({ code, signal, errors: code === 130 ? '' : errors }).toEqual({ code: 130, signal: null, errors: '' });
  expect(await machine.closed).toBe(1000);
});
