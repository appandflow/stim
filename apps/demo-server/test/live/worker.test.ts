import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { initiateNoise, keyFingerprint, type InitiateOptions } from '@stim-cli/core/noise-session';
import { WebSocket } from 'ws';

const SECRET = randomBytes(32);
const TOKEN = SECRET.toString('base64url');
const SEARCH = '/Users/demo/Developer/habitat-app/.worktrees/search-screen';
const root = new URL('../..', import.meta.url).pathname;
const tapped = readFileSync(join(root, 'fixtures/frame-ios-tapped.jpg')).toString('base64');

const servers: ChildProcess[] = [];
let state: string;
let port: number;
let vectorsPort: number;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });

async function wranglerDev(args: string[]): Promise<{ listen: number; wrangler: ChildProcess }> {
  const listen = await freePort();
  const wrangler = spawn(
    join(root, 'node_modules/.bin/wrangler'),
    ['dev', '--ip', '127.0.0.1', '--port', String(listen), ...args],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
  servers.push(wrangler);
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const scan = (chunk: Buffer): void => {
      output += chunk.toString();
      if (/Ready on http/.test(output)) resolve();
    };
    wrangler.stdout?.on('data', scan);
    wrangler.stderr?.on('data', scan);
    wrangler.on('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${output}`)));
  });
  return { listen, wrangler };
}

let demo: ChildProcess;

async function startDemo(): Promise<void> {
  ({ listen: port, wrangler: demo } = await wranglerDev(['--var', `DEMO_TOKEN:${TOKEN}`, '--persist-to', state]));
}

async function restartDemo(): Promise<void> {
  const exited = once(demo, 'exit');
  demo.kill();
  await exited;
  await startDemo();
}

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'stim-demo-live-'));
  await startDemo();
  ({ listen: vectorsPort } = await wranglerDev(['--config', 'test/live/vectors.wrangler.jsonc']));
});

afterAll(() => {
  for (const server of servers) server.kill();
  rmSync(state, { recursive: true, force: true });
});

interface Message {
  id?: number;
  event?: string;
  subscription?: string;
  data?: string;
  result?: Record<string, unknown>;
  error?: { code: string };
}

const rawSocket = async (): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(socket, 'open');
  return socket;
};

async function open(options: Partial<InitiateOptions>) {
  const raw = await rawSocket();
  const socket = await initiateNoise(raw, { keyPair: generateNoiseKeyPair(), timeoutMs: 10_000, ...options });
  const received: Message[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.on('message', (data: Buffer) => received.push(JSON.parse(data.toString('utf8'))));
  socket.on('close', (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString() };
  });
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(received.some((message) => message.id === id)).toBe(true), { timeout: 10_000 });
    return received.find((message) => message.id === id)!;
  };
  return { socket, received, request, closed: () => closed };
}

it('answers plain HTTP with 426', async () => {
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(426);
});

it('runs the shared Noise and framing vectors in workerd', async () => {
  expect(await (await fetch(`http://127.0.0.1:${vectorsPort}/`)).json()).toEqual({
    ran: expect.any(Number),
    failures: [],
  });
});

it('serves its pairing code, pairs over protocol 2, streams, takes Control and takes the phone back', async () => {
  const keyPair = generateNoiseKeyPair();
  let serverKey: Buffer = Buffer.alloc(0);
  const first = await open({
    keyPair,
    secret: SECRET,
    name: 'Live',
    acceptServerKey: (key) => {
      serverKey = key;
      return true;
    },
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/pairing`)).json()).toEqual({
    v: 2,
    name: 'Demo Mac',
    endpoint: `ws://127.0.0.1:${port}`,
    fingerprint: keyFingerprint(serverKey),
  });
  const hello = await first.request('hello');
  expect(hello.result).toMatchObject({ protocol: 2, device: { name: 'Live' }, capabilities: ['read', 'control'] });

  await first.request('status.subscribe');
  await vi.waitFor(() => expect(first.received.some((message) => message.event === 'status')).toBe(true));

  const target = { workspace: SEARCH, platform: 'ios', slot: 'default' };
  const frames = await first.request('frames.subscribe', target);
  const frameEvents = (): Message[] =>
    first.received.filter(
      (message) => message.event === 'frame' && message.subscription === frames.result?.subscription,
    );
  await vi.waitFor(() => expect(frameEvents().length).toBeGreaterThan(0));
  expect(frameEvents().at(-1)?.data).not.toBe(tapped);

  const control = await first.request('control.begin', target);
  const tap = async (): Promise<void> => {
    for (const phase of ['down', 'up']) {
      await first.request('input.touch', { session: control.result?.session, phase, x: 0.5, y: 0.4 });
    }
  };
  await tap();
  await vi.waitFor(() => expect(frameEvents().at(-1)?.data).toBe(tapped));
  await tap();
  first.socket.close();

  await restartDemo();
  const second = await open({ keyPair, serverKey });
  expect((await second.request('hello')).result?.device).toEqual(hello.result?.device);
  expect((await second.request('machine.get')).result).toBeDefined();
  second.socket.close();

  const stranger = await open({ serverKey });
  await vi.waitFor(() => expect(stranger.closed()).toEqual({ code: 4401, reason: 'unauthorized' }));

  await expect(open({ secret: randomBytes(32) })).rejects.toMatchObject({ code: 'unknown-secret' });
  await expect(open({ keyPair, serverKey: generateNoiseKeyPair().publicKey })).rejects.toMatchObject({
    code: 'server-key-mismatch',
  });
});

it('closes a socket that never sends a byte after the handshake deadline', async () => {
  const silent = await rawSocket();
  const [code, reason]: unknown[] = await once(silent, 'close');
  expect([code, String(reason)]).toEqual([4401, 'timeout']);
});

it('answers a protocol 1 hello in cleartext with protocol-unsupported and closes with 4400', async () => {
  const socket = await rawSocket();
  const reply = once(socket, 'message');
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ id: 1, method: 'hello', params: { protocol: 1, auth: { pairingToken: TOKEN } } }));
  const [data, isBinary]: unknown[] = await reply;
  expect(isBinary).toBe(false);
  expect(JSON.parse(String(data))).toMatchObject({ id: 1, error: { code: 'protocol-unsupported' } });
  expect((await closed).map(String)).toEqual(['4400', 'protocol-unsupported']);
});

const upgradeStatus = (origin?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin ? { Origin: origin } : {}),
      },
    });
    request.on('response', (response) => resolve(response.statusCode ?? 0));
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });

it('refuses upgrades from a web page and accepts the phone app, with or without its own Origin', async () => {
  expect(await upgradeStatus('https://evil.example')).toBe(403);
  expect(await upgradeStatus()).toBe(101);
  expect(await upgradeStatus(`http://127.0.0.1:${port}`)).toBe(101);
});

it('refuses upgrades beyond the concurrent connection limit with 503', async () => {
  const held = [];
  for (let count = 0; count < 32; count++) held.push(await rawSocket());
  expect(await upgradeStatus()).toBe(503);
  for (const socket of held) socket.close();
  await vi.waitFor(async () => expect(await upgradeStatus()).toBe(101), { timeout: 10_000 });
});
