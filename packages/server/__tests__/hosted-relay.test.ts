import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { deviceHostMachinesFile, workspaceStateFile, type Endpoint, readMacosRecord } from '@stim-cli/core/state';
import { HostedRelay } from '../src/hosted-relay.ts';
import { readAudit } from '../src/actions.ts';
import { MAX_INPUT_TEXT, type ServerMessage } from '../src/protocol.ts';
import { DEFAULT_VIDEO_LIMITS, videoPacket } from '../src/video.ts';
import { createPairingToken, capabilitiesFor, grantDevice } from '../src/registry.ts';
import { startServer, type RunningServer } from '../src/server.ts';

const TOKEN = 'host-secret-token';
const HOST_SESSION = '12345678-1234-1234-1234-123456789abc';
const CONTROL = 'c1';
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
let heldMethods: Set<string>;
let heldReplies: (() => void)[];

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
  heldMethods = new Set();
  heldReplies = [];
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
      const answer = (result: Json) => {
        const send = () => socket.send(JSON.stringify({ id, result }));
        if (heldMethods.has(method)) heldReplies.push(send);
        else send();
      };
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
            data: 'anBlZw==',
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

function saveCredential() {
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
}

async function client(control = true, controlLimits?: Parameters<typeof startServer>[0]['controlLimits']) {
  saveCredential();
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
    controlLimits,
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
  await server.ready;
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
  return {
    socket,
    request,
    next,
    inbox,
    device: (hello as unknown as { result: { device: { id: string } } }).result.device,
  };
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
    data: 'anBlZw==',
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
  const upstream = requests.find((request) => request.method === 'device-host.frames.subscribe')!.socket;
  const window = { id: 7, title: 'Hosted app', frame: { x: -100, y: 0, width: 800, height: 600 } };
  const windowsEvent = { event: 'macos-windows', current: window, windows: [window] };
  upstream.send(JSON.stringify({ event: 'macos-windows', subscription: 'unrelated', current: null, windows: [] }));
  upstream.send(JSON.stringify({ ...windowsEvent, subscription: UPSTREAM }));
  expect(await local.next()).toEqual({ ...windowsEvent, subscription });
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
  const begun = await local.request('control.begin', { ...target(), takeOver: true });
  expect(begun).toMatchObject({ result: { session: 'h1', lease: null } });
  const session = begun.result.session!;
  const inputs = [
    ['input.touch', { phase: 'down', x: 0.25, y: 0.5 }],
    ['input.text', { text: 'hello' }],
    ['input.scroll', { x: 0.5, y: 0.5, deltaX: 0, deltaY: 1 }],
    ['input.key', { key: 'return', modifiers: [] }],
  ] as const;
  for (const [method, params] of inputs) {
    expect(await local.request(method, { session, ...params })).toMatchObject({ result: {} });
    expect(requests.at(-1)).toMatchObject({ method: `device-host.${method}`, params: { session: CONTROL, ...params } });
  }
  expect(await local.request('input.text', { session, text: 'refuse' })).toMatchObject({
    error: { code: 'forbidden', message: 'input refused' },
  });
  expect(await local.request('control.end', { session })).toMatchObject({ result: {} });
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
  expect(await local.request('input.text', { session, text: 'late' })).toMatchObject({
    error: { code: 'unknown-session' },
  });
  expect(requests.find((request) => request.method === 'device-host.control.begin')?.params).toEqual({
    session: HOST_SESSION,
    takeOver: true,
  });
  expect(readAudit().filter((record) => record.workspace === workspace)).toEqual([
    expect.objectContaining({ action: 'control.take-over', workspace, platform: 'macos', ok: true }),
    expect.objectContaining({
      action: 'control.end',
      workspace,
      platform: 'macos',
      ok: true,
      durationMs: expect.any(Number),
      reason: 'ended: The client ended the session.',
    }),
  ]);
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
  const begun = await local.request('control.begin', target());
  const session = begun.result.session!;
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
    session,
    reason: 'taken-over',
    message: 'Another client took control.',
  });
  expect(await local.request('input.text', { session, text: 'late' })).toMatchObject({
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

it('keeps the request queue available while subscribe, keyframe, input and end replies are stalled', async () => {
  const local = await client();
  heldMethods.add('device-host.frames.subscribe');
  const subscribing = local.request('frames.subscribe', { ...target(), video: ['h264'] });
  await vi.waitFor(() => expect(heldReplies).toHaveLength(1));
  expect(await local.request('frames.keyframe', { subscription: 'missing' })).toMatchObject({
    error: { code: 'unknown-subscription' },
  });
  heldReplies.splice(0).forEach((send) => send());
  const subscription = (await subscribing).result.subscription;
  heldMethods.delete('device-host.frames.subscribe');
  const session = (await local.request('control.begin', target())).result.session!;
  heldMethods = new Set(['device-host.frames.keyframe', 'device-host.input.text', 'device-host.control.end']);
  const keyframe = local.request('frames.keyframe', { subscription });
  const input = local.request('input.text', { session, text: 'hello' });
  const end = local.request('control.end', { session });
  await vi.waitFor(() => expect(heldReplies).toHaveLength(3));
  expect(await local.request('frames.keyframe', { subscription: 'missing' })).toMatchObject({
    error: { code: 'unknown-subscription' },
  });
  expect(
    requests
      .filter(
        (request) => request.method.startsWith('device-host.input.') || request.method === 'device-host.control.end',
      )
      .map((request) => request.method),
  ).toEqual(['device-host.input.text', 'device-host.control.end']);
  heldReplies.splice(0).forEach((send) => send());
  expect(await keyframe).toMatchObject({ result: {} });
  expect(await input).toMatchObject({ result: {} });
  expect(await end).toMatchObject({ result: {} });
});

it('validates hosted macOS input and applies the connection input budget', async () => {
  const local = await client(true, { inputPerSecond: 1 });
  const session = (await local.request('control.begin', target())).result.session!;
  for (const [method, params] of [
    ['input.touch', { phase: 'down', x: 2, y: 0 }],
    ['input.text', { text: '' }],
    ['input.scroll', { x: 0, y: 0, deltaX: 2000, deltaY: 0 }],
    ['input.key', { key: 'unknown' }],
    ['input.button', { button: 'home' }],
  ] as const) {
    expect(await local.request(method, { session, ...params })).toMatchObject({ error: { code: 'bad-request' } });
  }
  expect(requests.filter((request) => request.method.startsWith('device-host.input.'))).toEqual([]);
  expect(await local.request('input.text', { session, text: 'first' })).toMatchObject({ result: {} });
  expect(await local.request('input.text', { session, text: 'second' })).toMatchObject({
    error: { code: 'limit-exceeded' },
  });
  expect(requests.filter((request) => request.method === 'device-host.input.text')).toHaveLength(1);
});

it('applies the local text character budget before forwarding hosted input', async () => {
  const local = await client(true, { textCharsPerSecond: 1 });
  const session = (await local.request('control.begin', target())).result.session!;
  expect(await local.request('input.text', { session, text: 'x'.repeat(MAX_INPUT_TEXT) })).toMatchObject({
    result: {},
  });
  expect(await local.request('input.text', { session, text: 'blocked' })).toMatchObject({
    error: { code: 'limit-exceeded' },
  });
  expect(requests.filter((request) => request.method === 'device-host.input.text')).toHaveLength(1);
});

it('ends relayed controls on local revocation and records their local target', async () => {
  const local = await client();
  const session = (await local.request('control.begin', target())).result.session!;
  grantDevice(local.device.id, ['read']);
  expect(await local.next()).toMatchObject({ event: 'control-ended', session, reason: 'forbidden' });
  await vi.waitFor(() => expect(host.clients.size).toBe(0));
  expect(await local.request('input.text', { session, text: 'late' })).toMatchObject({
    error: { code: 'unknown-session' },
  });
  expect(readAudit().filter((record) => record.workspace === workspace)).toEqual([
    expect.objectContaining({ action: 'control.begin', workspace, platform: 'macos', ok: true }),
    expect.objectContaining({
      action: 'control.end',
      workspace,
      platform: 'macos',
      ok: true,
      reason: expect.stringContaining('forbidden:'),
      durationMs: expect.any(Number),
    }),
  ]);
});

it('drops congested video, requests one recovery keyframe within a second, and resets on a local keyframe', async () => {
  saveCredential();
  let buffered = 0;
  const sent: (ServerMessage | Buffer)[] = [];
  const relay = new HostedRelay(
    {
      status: () => ({ Peer: { peer: { ID: peerNode, DNSName: 'mini.tail.ts.net.', TailscaleIPs: ['100.64.0.8'] } } }),
      endpoint: (pinned) => ({ ...pinned, url: `ws://127.0.0.1:${(host.address() as AddressInfo).port}` }),
    },
    '1',
    (message) => sent.push(message),
    () => buffered,
    () => 'local-video',
    () => {},
    () => {},
  );
  try {
    await relay.subscribe(1, readMacosRecord(workspace)!.host!, { video: ['h264'] }, () => {});
    await vi.waitFor(() => expect(sent.filter(Buffer.isBuffer)).toHaveLength(1));
    const upstream = requests.find((request) => request.method === 'device-host.frames.subscribe')!.socket;
    const packet = (sequence: number, keyframe: boolean) =>
      videoPacket(UPSTREAM, sequence, {
        keyframe,
        capturedAt: 1000,
        width: 800,
        height: 600,
        data: Buffer.from([0, 0, 1, 101]),
      });
    buffered = DEFAULT_VIDEO_LIMITS.congestedBytes + 1;
    upstream.send(packet(8, false));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter(Buffer.isBuffer)).toHaveLength(1);
    buffered = 0;
    await vi.waitFor(
      () => expect(requests.filter((request) => request.method === 'device-host.frames.keyframe')).toHaveLength(1),
      { timeout: 900 },
    );
    upstream.send(packet(9, false));
    upstream.send(packet(10, true));
    await vi.waitFor(() => expect(sent.filter(Buffer.isBuffer)).toHaveLength(2));
    expect(requests.filter((request) => request.method === 'device-host.frames.keyframe')).toHaveLength(1);
    expect(relay.keyframe(2, 'local-video')).toBe(true);
    upstream.send(packet(11, false));
    upstream.send(packet(12, true));
    await vi.waitFor(() => expect(sent.filter(Buffer.isBuffer)).toHaveLength(3));
    expect(sent.filter(Buffer.isBuffer).map((message) => message.readUInt32BE(4))).toEqual([7, 10, 12]);
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.method === 'device-host.frames.keyframe')).toHaveLength(2),
    );
  } finally {
    relay.close();
  }
});
