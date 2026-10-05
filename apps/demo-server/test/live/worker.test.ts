import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'live-test-token';
const SEARCH = '/Users/demo/Developer/habitat-app/.worktrees/search-screen';
const root = new URL('../..', import.meta.url).pathname;
const tapped = readFileSync(join(root, 'fixtures/frame-ios-tapped.jpg')).toString('base64');

let wrangler: ChildProcess;
let state: string;
let port: number;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });

beforeAll(async () => {
  port = await freePort();
  state = mkdtempSync(join(tmpdir(), 'stim-demo-live-'));
  wrangler = spawn(
    join(root, 'node_modules/.bin/wrangler'),
    ['dev', '--ip', '127.0.0.1', '--port', String(port), '--var', `DEMO_TOKEN:${TOKEN}`, '--persist-to', state],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
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
});

afterAll(() => {
  wrangler?.kill();
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

async function open() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: Message[] = [];
  socket.addEventListener('message', (event) => received.push(JSON.parse(String(event.data)) as Message));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(received.some((message) => message.id === id)).toBe(true), { timeout: 10_000 });
    return received.find((message) => message.id === id)!;
  };
  return { socket, received, request };
}

it('answers plain HTTP with 426', async () => {
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(426);
});

it('pairs, streams, takes Control and keeps the pairing across reconnects', async () => {
  const first = await open();
  const hello = await first.request('hello', { protocol: 1, auth: { pairingToken: TOKEN, deviceName: 'Live' } });
  const deviceToken = hello.result?.deviceToken;
  expect(deviceToken).toEqual(expect.any(String));

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

  const second = await open();
  const again = await second.request('hello', { protocol: 1, auth: { deviceToken } });
  expect(again.result?.server).toMatchObject({ name: 'Demo Mac' });
  expect((await second.request('machine.get')).result).toBeDefined();
  second.socket.close();

  const stranger = await open();
  const refused = await stranger.request('hello', { protocol: 1, auth: { pairingToken: 'guess' } });
  expect(refused.error?.code).toBe('pairing-expired');
});
