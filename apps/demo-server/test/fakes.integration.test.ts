import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { initiateNoise } from '@stim-cli/core/noise-session';
import type { Method } from '@stim-cli/core/phone-protocol';
import { isRpcError, isRpcEvent, isRpcResult } from '@stim-cli/core/receive-protocol';
import { WebSocket } from 'ws';

import { DemoMachine } from '../src/demo.ts';
import { loadFixtures } from './load-fixtures.ts';

interface Message {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
  event?: string;
  subscription?: string;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No port.');
  return address.port;
}

it.each(['mock', 'demo'])('%s hello, RPCs and subscription events pass the phone receive validators', async (kind) => {
  const received: Message[] = [];
  let close = async (): Promise<void> => {};
  onTestFinished(async () => close());
  let send: (text: string) => void;
  let workspace: string;
  if (kind === 'mock') {
    const state = mkdtempSync(join(tmpdir(), 'stim-fake-contract-'));
    const child = spawn(process.execPath, ['server.mjs', '--port', String(await freePort())], {
      cwd: new URL('../../mobile/mock-server/', import.meta.url),
      env: { ...process.env, TMPDIR: state },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    close = async () => {
      child.kill();
      await exited;
      rmSync(state, { recursive: true, force: true });
    };
    const code = await new Promise<{ endpoint: string; pairingToken: string }>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.split('\n');
        output = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('{')) resolve(JSON.parse(line));
        }
      });
      child.on('exit', (status) => reject(new Error(`Mock exited with ${status}.`)));
      child.on('error', reject);
    });
    const raw = new WebSocket(code.endpoint);
    await once(raw, 'open');
    const socket = await initiateNoise(raw, {
      keyPair: generateNoiseKeyPair(),
      secret: Buffer.from(code.pairingToken, 'base64url'),
      timeoutMs: 5000,
    });
    socket.on('message', (data: Buffer) => received.push(JSON.parse(data.toString('utf8'))));
    send = (text) => socket.send(text);
    const stopChild = close;
    close = async () => {
      socket.close();
      await stopChild();
    };
    const status = JSON.parse(
      readFileSync(new URL('../../mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
    ) as { payload: { environments: { path: string }[] } };
    workspace = status.payload.environments[0]!.path;
  } else {
    const fixtures = loadFixtures();
    const machine = new DemoMachine(fixtures, 'Demo Mac', {
      token: undefined,
      keyPair: generateNoiseKeyPair(),
      devices: new Map(),
    });
    const connection = machine.connect(
      { send: (text) => received.push(JSON.parse(text)), close: () => {} },
      { id: 'abcd1234', name: 'Phone' },
    );
    send = (text) => void connection.receive(text);
    close = async () => connection.close();
    workspace = fixtures.status.environments[0]!.path;
  }
  let nextId = 1;
  const request = async (method: Method, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    send(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(received.some((message) => message.id === id)).toBe(true));
    const message = received.find((candidate) => candidate.id === id)!;
    expect(message.error ? isRpcError(message.error) : isRpcResult(method, message.result), method).toBe(true);
    return message;
  };
  const hello = await request('hello');
  expect(hello.result).toMatchObject({
    phoneApi: 2,
    host: { owner: 'service', capabilities: expect.any(Array), app: null },
  });
  const calls: [Method, Record<string, unknown>][] = [
    ['archived.list', {}],
    ['logs.query', { workspace, tail: 20 }],
    ['workspace.files', { workspace, group: 'tracked' }],
    ['workspace.diff', { workspace, path: 'src/app.tsx' }],
    ['build.plan', { workspace, platform: 'ios', slot: 'second' }],
    ['build.plan', { workspace, platform: 'android' }],
    ['settings.get', {}],
    ['recording.set', { enabled: true }],
    ['replay.range', { workspace, platform: 'ios' }],
    ['machine.get', {}],
    ['machine.history', {}],
    ['machine.details', {}],
    ['notifications.list', {}],
    ['frames.keyframe', {}],
    ['action', { workspace, action: 'reload', platform: 'ios' }],
  ];
  for (const [method, params] of calls) expect((await request(method, params)).result, method).toBeDefined();
  expect((await request('stats.get')).error).toBeDefined();
  for (const method of [
    'workspaces.subscribe',
    'workspace.subscribe',
    'machine.subscribe',
    'logs.subscribe',
    'frames.subscribe',
  ] as const) {
    const reply = await request(method, { workspace, platform: 'ios' });
    const subscription = reply.result?.subscription;
    await vi.waitFor(() => expect(received.some((message) => message.subscription === subscription)).toBe(true), {
      timeout: 3000,
    });
    for (const event of received.filter((message) => message.subscription === subscription)) {
      expect(isRpcEvent(event), `${method} event`).toBe(true);
    }
    await request('unsubscribe', { subscription });
  }
});
