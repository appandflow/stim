import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { deviceHostMachinesFile, workspaceStateFile, type Endpoint } from '@stim-cli/core/state';
import { createPairingToken, capabilitiesFor } from '../src/registry.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { videoPacket } from '../src/video.ts';

const TOKEN = 'host-secret-token';
const HOST_SESSION = '12345678-1234-1234-1234-123456789abc';
const CONTROL = 'host-control-session';
const UPSTREAM = 'host-video-subscription';
const CLIENT = { name: 'test desktop', version: '1' };
type Json = Record<string, unknown>;
type Reply = { result: { subscription: string; session?: string }; error: { code: string; message: string } };
type HostRequest = {
  id: number;
  method: string;
  params: {
    session?: string;
    subscription?: string;
    video?: string[];
    text?: string;
    auth?: { deviceToken: string };
    protocol?: number;
    client?: { name: string };
  };
};

let root: string;
let workspace: string;
let server: RunningServer | undefined;
let host: WebSocketServer;
let sockets: WebSocket[];
let requests: { socket: WebSocket; method: string; params: Json }[];
let connections: number;
let credentialState: 'pending' | 'approved';
let peerNode: string;
let endpointCalls: Endpoint[];
let helloError: string | undefined;
let helloCapabilities: string[];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-hosted-relay-')));
  process.env.STIM_HOME = join(root, 'home');
  workspace = join(root, 'app');
  mkdirSync(workspace);
  mkdirSync(process.env.STIM_HOME);
  writeFileSync(join(process.env.STIM_HOME, 'config.json'), JSON.stringify({ projects: { [workspace]: {} } }));
  const file = workspaceStateFile(workspace);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      macos: {
        launchId: 'launch',
        arguments: [],
        product: 'App',
        bundle: '/App.app',
        bundleId: 'com.example.app',
        executable: 'App',
        build: { state: 'ok', startedAt: new Date().toISOString() },
        host: {
          machine: 'mini',
          session: HOST_SESSION,
          appSlot: 1,
          appAttempt: 'app-attempt',
          bundleId: 'com.example.app.hosted1',
          agent: { driver: 'none', setting: 'hosting.agentDriver' },
        },
      },
    }),
  );
  sockets = [];
  requests = [];
  connections = 0;
  credentialState = 'approved';
  peerNode = 'pinned-node';
  endpointCalls = [];
  helloError = undefined;
  helloCapabilities = ['device-host'];
  host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    host.once('listening', resolve);
    host.once('error', reject);
  });
  host.on('connection', (socket) => {
    connections++;
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as HostRequest;
      const { id, method, params } = request;
      requests.push({ socket, method, params });
      const answer = (result: Json) => socket.send(JSON.stringify({ id, result }));
      const refuse = (message: string) => socket.send(JSON.stringify({ id, error: { code: 'forbidden', message } }));
      if (method === 'hello') {
        if (params.auth?.deviceToken !== TOKEN || params.protocol !== 1 || params.client?.name !== 'stim-server')
          return refuse('bad hello');
        if (helloError) return refuse(helloError);
        return answer({ capabilities: helloCapabilities });
      }
      if (method === 'device-host.frames.subscribe') {
        if (params.session !== HOST_SESSION) return refuse('wrong hosted session');
        answer({ subscription: UPSTREAM, ...(params.video?.includes('h264') ? { video: 'h264' } : {}) });
        socket.send(JSON.stringify({ event: 'frame', subscription: 'unrelated', image: 'ignore' }));
        socket.send(
          JSON.stringify({
            event: 'frame',
            subscription: UPSTREAM,
            platform: 'ios',
            slot: 'host-slot',
            image: 'jpeg',
            width: 800,
            height: 600,
          }),
        );
        if (params.video?.includes('h264'))
          socket.send(
            videoPacket(UPSTREAM, 7, {
              keyframe: true,
              capturedAt: 12345,
              width: 800,
              height: 600,
              data: Buffer.from([0, 0, 1, 101, 99]),
            }),
          );
        return;
      }
      if (method === 'device-host.control.begin') {
        if (params.session !== HOST_SESSION) return refuse('wrong hosted session');
        return answer({ session: CONTROL, lease: null });
      }
      if (method === 'device-host.frames.keyframe') {
        if (params.subscription !== UPSTREAM) return refuse('wrong subscription');
        return answer({});
      }
      if (method.startsWith('device-host.input.') || method === 'device-host.control.end') {
        if (params.session !== CONTROL) return refuse('wrong control id');
        if (params.text === 'refuse') return refuse('input refused');
        return answer({});
      }
      refuse('unexpected method');
    });
  });
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await server?.close();
  server = undefined;
  for (const socket of host.clients) socket.terminate();
  await new Promise<void>((resolve) => host.close(() => resolve()));
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

async function client(control = true) {
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({
      version: 1,
      machines: [
        {
          machine: 'mini',
          nodeId: 'pinned-node',
          dnsName: 'mini.tail.ts.net',
          deviceId: 'client',
          deviceToken: TOKEN,
          state: credentialState,
          requestedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  server = await startServer({
    name: 'Client Mac',
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli: join(root, 'unused-stim.mjs'),
    stimVersion: '1',
    serverVersion: '1.2.3',
    env: process.env,
    tailscale: null,
    tailscaleState: { state: 'not-running', backendState: 'Stopped' },
    record: false,
    history: false,
    frameHelper: null,
    pullRequests: async () => new Map(),
    hostedRelay: {
      status: () => ({
        BackendState: 'Running',
        Peer: {
          peer: {
            ID: peerNode,
            DNSName: 'mini.tail.ts.net.',
            TailscaleIPs: ['100.64.0.8'],
          },
        },
      }),
      endpoint: (pinned) => {
        endpointCalls.push(pinned);
        return { ...pinned, url: `ws://127.0.0.1:${(host.address() as AddressInfo).port}` };
      },
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.addresses[0]!.port}`);
  sockets.push(socket);
  const inbox: (Json | Buffer)[] = [];
  const waiters: ((message: Json | Buffer) => void)[] = [];
  const replies = new Map<number, (message: Reply) => void>();
  socket.on('message', (data, binary) => {
    const message = binary ? Buffer.from(data as Buffer) : (JSON.parse(data.toString()) as Json);
    if (!Buffer.isBuffer(message) && typeof message.id === 'number' && replies.has(message.id)) {
      replies.get(message.id)!(message as unknown as Reply);
      replies.delete(message.id);
    } else {
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let id = 0;
  const request = (method: string, params?: Json) =>
    new Promise<Reply>((resolve) => {
      replies.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const next = () =>
    inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Json | Buffer>((resolve) => waiters.push(resolve));
  const hello = await request('hello', {
    protocol: 1,
    client: CLIENT,
    auth: { pairingToken: createPairingToken(Date.now(), capabilitiesFor(control)).token, deviceName: 'Desktop' },
  });
  expect(hello.error).toBeUndefined();
  return { socket, request, next };
}

const target = () => ({ workspace, platform: 'macos' });

it('routes hosted frames and video to the local subscription and forwards keyframes', async () => {
  const local = await client();
  const reply = await local.request('frames.subscribe', { ...target(), fps: 12, maxEdge: 1280, video: ['h264'] });
  expect(reply.result).toEqual({ subscription: 's1', video: 'h264' });
  const subscription = reply.result.subscription;
  expect(await local.next()).toMatchObject({
    event: 'frame',
    subscription,
    platform: 'macos',
    slot: 'default',
    image: 'jpeg',
  });
  const binary = await local.next();
  expect(Buffer.isBuffer(binary)).toBe(true);
  const packet = binary as Buffer;
  expect(packet.readUInt16BE(2)).toBe(21 + subscription.length);
  expect(packet[20]).toBe(subscription.length);
  expect(packet.toString('ascii', 21, 21 + packet[20]!)).toBe(subscription);
  expect(packet.readUInt32BE(4)).toBe(7);
  expect(packet.readDoubleBE(8)).toBe(12345);
  expect(packet.readUInt16BE(16)).toBe(800);
  expect(packet.readUInt16BE(18)).toBe(600);
  expect(packet.subarray(21 + packet[20]!)).toEqual(Buffer.from([0, 0, 1, 101, 99]));
  expect(await local.request('frames.keyframe', { subscription })).toMatchObject({ result: {} });
  expect(requests.find((request) => request.method === 'device-host.frames.subscribe')?.params).toEqual({
    session: HOST_SESSION,
    fps: 12,
    maxEdge: 1280,
    video: ['h264'],
  });
  expect(requests.find((request) => request.method === 'device-host.frames.keyframe')?.params).toEqual({
    subscription: UPSTREAM,
  });
  expect(endpointCalls).toEqual([
    { url: 'wss://100.64.0.8:7443', servername: 'mini.tail.ts.net', host: 'mini.tail.ts.net:7443' },
  ]);
  expect(await local.request('unsubscribe', { subscription })).toMatchObject({ result: {} });
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
  expect(await local.request('frames.keyframe', { subscription })).toMatchObject({
    error: { code: 'unknown-subscription' },
  });
});

it('routes input using the host control id and closes upstream after control.end', async () => {
  const local = await client();
  expect(await local.request('control.begin', { ...target(), takeOver: true })).toMatchObject({
    result: { session: CONTROL, lease: null },
  });
  const inputs = [
    ['input.touch', { phase: 'down', x: 0.25, y: 0.5 }],
    ['input.text', { text: 'hello' }],
    ['input.scroll', { x: 0.5, y: 0.5, deltaX: 0, deltaY: 1 }],
    ['input.key', { key: 'enter', modifiers: [] }],
  ] as const;
  for (const [method, params] of inputs) {
    expect(await local.request(method, { session: CONTROL, ...params })).toMatchObject({ result: {} });
    expect(requests.at(-1)).toMatchObject({ method: `device-host.${method}`, params: { session: CONTROL, ...params } });
  }
  expect(await local.request('input.text', { session: CONTROL, text: 'refuse' })).toMatchObject({
    error: { code: 'forbidden', message: 'input refused' },
  });
  expect(await local.request('control.end', { session: CONTROL })).toMatchObject({ result: {} });
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
  expect(await local.request('input.text', { session: CONTROL, text: 'late' })).toMatchObject({
    error: { code: 'unknown-session' },
  });
  expect(requests.find((request) => request.method === 'device-host.control.begin')?.params).toEqual({
    session: HOST_SESSION,
    takeOver: true,
  });
});

it.each(['pending', 'changed-node'] as const)(
  'refuses %s credentials before connecting or disclosing the token',
  async (reason) => {
    if (reason === 'pending') credentialState = 'pending';
    else peerNode = 'replacement-node';
    const local = await client();
    const reply = await local.request('frames.subscribe', target());
    expect(reply.error).toMatchObject({ code: 'frames-failed' });
    expect(reply.error.message).toContain('mini');
    expect(reply.error.message).toContain(reason === 'pending' ? 'approved' : 'pinned');
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(connections).toBe(0);
    expect(endpointCalls).toEqual([]);
  },
);

it('turns upstream close into one frames-failed event and drops the local subscription', async () => {
  const local = await client();
  const reply = await local.request('frames.subscribe', target());
  expect(reply.result).toEqual({ subscription: 's1' });
  await local.next();
  requests.find((request) => request.method === 'device-host.frames.subscribe')!.socket.terminate();
  expect(await local.next()).toMatchObject({ event: 'error', subscription: 's1', error: { code: 'frames-failed' } });
  expect(await local.request('unsubscribe', { subscription: 's1' })).toMatchObject({
    error: { code: 'unknown-subscription' },
  });
});

it('forwards control-ended and forgets the host control id', async () => {
  const local = await client();
  await local.request('control.begin', target());
  requests
    .find((request) => request.method === 'device-host.control.begin')!
    .socket.send(
      JSON.stringify({
        event: 'control-ended',
        session: CONTROL,
        reason: 'taken-over',
        message: 'Another client took control.',
      }),
    );
  expect(await local.next()).toEqual({
    event: 'control-ended',
    session: CONTROL,
    reason: 'taken-over',
    message: 'Another client took control.',
  });
  expect(await local.request('input.text', { session: CONTROL, text: 'late' })).toMatchObject({
    error: { code: 'unknown-session' },
  });
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
});

it('checks local control permission before opening an upstream control connection', async () => {
  const local = await client(false);
  expect(await local.request('control.begin', target())).toMatchObject({ error: { code: 'forbidden' } });
  expect(connections).toBe(0);
});

it('closes all upstream frame and control connections when the local socket closes', async () => {
  const local = await client();
  await local.request('frames.subscribe', target());
  await local.request('control.begin', target());
  expect(host.clients.size).toBe(2);
  local.socket.close();
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
});

it('returns a host refusal without leaking a token echoed by the host', async () => {
  helloError = `access refused for ${TOKEN}`;
  const local = await client();
  const reply = await local.request('frames.subscribe', target());
  expect(reply.error).toMatchObject({ code: 'frames-failed' });
  expect(reply.error.message).toContain('mini');
  expect(reply.error.message).toContain('access refused');
  expect(JSON.stringify(reply)).not.toContain(TOKEN);
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
});

it('refuses a host that grants no device-host capability before subscribing', async () => {
  helloCapabilities = ['read', 'control'];
  const local = await client();
  const reply = await local.request('frames.subscribe', target());
  expect(reply.error).toMatchObject({ code: 'frames-failed' });
  expect(reply.error.message).toContain('device-host');
  expect(requests.map((request) => request.method)).toEqual(['hello']);
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
});

it('maps delayed and error events to the local target and drops failed capture', async () => {
  const local = await client();
  const reply = await local.request('frames.subscribe', target());
  const subscription = reply.result.subscription;
  await local.next();
  const upstream = requests.find((request) => request.method === 'device-host.frames.subscribe')!.socket;
  upstream.send(
    JSON.stringify({ event: 'frame-delayed', subscription: UPSTREAM, delayed: true, reason: 'window hidden' }),
  );
  expect(await local.next()).toMatchObject({
    event: 'frame-delayed',
    subscription,
    platform: 'macos',
    slot: 'default',
    delayed: true,
    reason: 'window hidden',
  });
  upstream.send(
    JSON.stringify({
      event: 'error',
      subscription: UPSTREAM,
      error: { code: 'frames-failed', message: `capture failed ${TOKEN}` },
    }),
  );
  const failure = await local.next();
  expect(failure).toMatchObject({
    event: 'error',
    subscription,
    platform: 'macos',
    slot: 'default',
    error: { code: 'frames-failed' },
  });
  expect(JSON.stringify(failure)).not.toContain(TOKEN);
  expect(await local.request('unsubscribe', { subscription })).toMatchObject({
    error: { code: 'unknown-subscription' },
  });
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
});
