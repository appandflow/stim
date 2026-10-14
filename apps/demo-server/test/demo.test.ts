import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { generateNoiseKeyPair, HandshakeState, NOISE_XX, NoiseError, type NoiseKeyPair } from '@stim-cli/core/noise';
import {
  initiateNoise,
  keyFingerprint,
  type InitiateOptions,
  type NoiseSocket,
  type RawSocket,
} from '@stim-cli/core/noise-session';
import type { Method } from '@stim-cli/core/phone-protocol';
import { isRpcError, isRpcEvent, isRpcResult } from '@stim-cli/core/receive-protocol';

import { DemoMachine, upgradeFromWebPage, workerDh, type DemoAuth, type DeviceRecord } from '../src/demo.ts';
import { loadFixtures } from './load-fixtures.ts';
import { runSharedVectors } from './vectors.ts';

const SECRET = randomBytes(32);
const TOKEN = SECRET.toString('base64url');
const SERVER_KEY = generateNoiseKeyPair();
const fixtures = loadFixtures();
const SEARCH = '/Users/demo/Developer/habitat-app/.worktrees/search-screen';
const SORTING = '/Users/demo/Developer/notes-app/.worktrees/note-sorting';
const SDK = '/Users/demo/Developer/habitat-app/.worktrees/update-expo-sdk';
const TABLET = '/Users/demo/Developer/habitat-app/.worktrees/tablet-layout';

interface Message {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  event?: string;
  subscription?: string;
  data?: string;
  records?: { workspace?: string }[];
  environment?: { path: string } | null;
}

function demo(options: { token?: string | undefined; devices?: Map<string, DeviceRecord> } = {}): DemoMachine {
  const auth: DemoAuth = {
    token: 'token' in options ? options.token : TOKEN,
    keyPair: SERVER_KEY,
    devices: options.devices ?? new Map(),
  };
  return new DemoMachine(fixtures, 'Demo Mac', auth);
}

class FakeSocket extends EventEmitter implements RawSocket {
  readyState = 1;
  readonly bufferedAmount = 0;
  peer: FakeSocket = this;

  send(data: Buffer | string, callback?: (error?: Error) => void): void {
    const isBinary = typeof data !== 'string';
    const bytes = Buffer.from(data);
    queueMicrotask(() => this.peer.emit('message', bytes, isBinary));
    callback?.();
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    for (const side of [this, this.peer]) {
      side.readyState = 3;
      queueMicrotask(() => side.emit('close', code, Buffer.from(reason)));
    }
  }

  terminate(): void {
    this.close(1006);
  }
}

function phone(machine: DemoMachine) {
  const received: Message[] = [];
  let closed = false;
  const connection = machine.connect(
    {
      send: (text) => received.push(JSON.parse(text)),
      close: () => {
        closed = true;
      },
    },
    { id: 'abcd1234', name: 'Phone' },
  );
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    await connection.receive(JSON.stringify({ id, method, params }));
    return awaitReply(received, method, id);
  };
  const events = (name: string): Message[] => received.filter((message) => message.event === name);
  return { connection, request, events, closed: () => closed };
}

async function awaitReply(received: Message[], method: string, id: number): Promise<Message> {
  await vi.waitFor(() => expect(received.some((message) => message.id === id)).toBe(true));
  const found = received.find((message) => message.id === id)!;
  const accepted = found.error ? isRpcError(found.error) : isRpcResult(method as Method, found.result);
  expect(accepted, `${method} reply the phone accepts`).toBe(true);
  return found;
}

async function connect(
  machine: DemoMachine,
  options: Partial<InitiateOptions> = { secret: SECRET, name: 'Review iPhone' },
) {
  const client = new FakeSocket();
  const server = new FakeSocket();
  client.peer = server;
  server.peer = client;
  server.once('message', (data: Buffer, isBinary: boolean) => void machine.accept(server, data, isBinary));
  const socket: NoiseSocket = await initiateNoise(client, {
    keyPair: generateNoiseKeyPair(),
    timeoutMs: 5000,
    ...options,
  });
  const received: Message[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.on('message', (data: Buffer) => received.push(JSON.parse(data.toString('utf8'))));
  socket.on('close', (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString() };
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return awaitReply(received, method, id);
  };
  const events = (name: string): Message[] => received.filter((message) => message.event === name);
  return { socket, request, events, closed: () => closed, close: () => socket.close() };
}

async function greeted(machine: DemoMachine) {
  const client = phone(machine);
  await client.request('hello');
  return client;
}

async function pair(machine: DemoMachine, options?: Partial<InitiateOptions>) {
  const client = await connect(machine, options);
  return { ...client, hello: await client.request('hello') };
}

describe('pairing', () => {
  it('pairs any number of phones with the review token and takes a paired phone back after a restart', async () => {
    const devices = new Map<string, DeviceRecord>();
    const machine = demo({ devices });
    const { fingerprint } = machine.pairingCode('wss://demo.example');
    const phoneKey: NoiseKeyPair = generateNoiseKeyPair();
    const first = await pair(machine, {
      keyPair: phoneKey,
      secret: SECRET,
      name: 'Review iPhone',
      acceptServerKey: (key) => keyFingerprint(key) === fingerprint,
    });
    const second = await pair(machine);
    expect(first.hello.result).toMatchObject({
      protocol: 2,
      capabilities: ['read', 'control'],
      device: { id: expect.stringMatching(/^[0-9a-f]{8}$/), name: 'Review iPhone' },
    });
    expect(second.hello.result?.device).not.toEqual(first.hello.result?.device);
    first.close();
    second.close();

    const again = await pair(demo({ devices }), { keyPair: phoneKey, serverKey: SERVER_KEY.publicKey });
    expect(again.hello.result?.device).toEqual(first.hello.result?.device);
    expect((await again.request('machine.get')).result).toBeDefined();
    again.close();
  });

  it('refuses a wrong token, an unknown returning phone, and every phone when the token is missing or changed', async () => {
    await expect(connect(demo(), { secret: randomBytes(32) })).rejects.toMatchObject({
      code: 'unknown-secret',
    });
    for (const token of [undefined, '', 'review-token']) {
      await expect(connect(demo({ token }))).rejects.toMatchObject({ code: 'unknown-secret' });
    }

    const stranger = await connect(demo(), { serverKey: SERVER_KEY.publicKey });
    await vi.waitFor(() => expect(stranger.closed()).toEqual({ code: 4401, reason: 'unauthorized' }));

    const devices = new Map<string, DeviceRecord>();
    const phoneKey = generateNoiseKeyPair();
    (await pair(demo({ devices }), { keyPair: phoneKey, secret: SECRET })).close();
    for (const token of [randomBytes(32).toString('base64url'), undefined]) {
      const returning = await connect(demo({ token, devices }), { keyPair: phoneKey, serverKey: SERVER_KEY.publicKey });
      await vi.waitFor(() => expect(returning.closed()).toEqual({ code: 4401, reason: 'unauthorized' }));
    }
  });

  it('answers nothing but hello first', async () => {
    const client = phone(demo());
    expect((await client.request('status.subscribe')).error?.code).toBe('unauthorized');
    expect((await client.request('hello')).result).toBeDefined();
    expect((await client.request('machine.get')).result).toBeDefined();
  });

  it('closes a phone that finishes the handshake but never sends hello', async () => {
    vi.useFakeTimers();
    try {
      const silent = phone(demo());
      await vi.advanceTimersByTimeAsync(9_000);
      expect(silent.closed()).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(silent.closed()).toBe(true);

      const paired = await connect(demo());
      await vi.advanceTimersByTimeAsync(11_000);
      expect(paired.closed()).toEqual({ code: 1008, reason: 'no hello' });

      const greeter = phone(demo());
      await greeter.connection.receive(JSON.stringify({ id: 1, method: 'hello', params: {} }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(greeter.closed()).toBe(false);
      greeter.connection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks the shared Noise vectors with the Worker's X25519", () => {
    const { ran, failures } = runSharedVectors(workerDh, { framing: false });
    expect(ran).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it("refuses a low-order X25519 key with the Worker's X25519", () => {
    const responder = new HandshakeState({
      protocol: NOISE_XX,
      initiator: false,
      prologue: new Uint8Array(),
      staticKeyPair: SERVER_KEY,
      dh: workerDh,
    });
    responder.readMessage(Buffer.alloc(32));
    expect(() => responder.writeMessage()).toThrow(NoiseError);
  });
});

describe('the phone protocol', () => {
  it("returns each workspace's errors in agreement with its status count", async () => {
    const client = await greeted(demo());
    const environments = fixtures.status.environments as { path: string; logs?: { errorsSinceMarker: number } }[];
    for (const env of environments) {
      const reply = await client.request('logs.query', { workspace: env.path, errors: true });
      expect(reply.result?.records).toHaveLength(env.logs?.errorsSinceMarker ?? 0);
    }
    expect(
      (
        await client.request('logs.query', {
          workspace: SEARCH,
          errors: true,
          sources: ['client'],
          grep: 'results.map',
          slot: 'default',
          tail: 1,
        })
      ).result?.records,
    ).toMatchObject([{ src: 'client', msg: "TypeError: undefined is not an object (evaluating 'results.map')" }]);
    expect(
      (await client.request('logs.query', { workspace: SDK, errors: true, grep: 'results.map' })).result?.records,
    ).toEqual([]);
  });

  it('serves the stage, git chip and app presence stim derives, which the phone renders without deriving', () => {
    const { environments } = demo().status();
    expect(environments.length).toBeGreaterThan(0);
    for (const env of environments) {
      expect(env.stage).toMatchObject({ kind: expect.any(String) });
      expect(env.worktree?.gitChip).toMatchObject({ parts: expect.any(Array) });
      for (const device of [env.ios, env.android].filter(Boolean)) expect(device).toHaveProperty('appPresence');
    }
  });

  it('keeps initial and periodic log events within their workspace, including empty workspaces', async () => {
    vi.useFakeTimers();
    const client = await greeted(demo());
    try {
      const targets: [string, number][] = [
        [SEARCH, 2],
        [SDK, 1],
        [TABLET, 0],
      ];
      for (const [workspace, count] of targets) {
        const subscription = (await client.request('logs.subscribe', { workspace, errors: count > 0 })).result
          ?.subscription;
        await vi.advanceTimersByTimeAsync(0);
        const initial = client.events('logs').filter((event) => event.subscription === subscription);
        expect(initial).toHaveLength(1);
        expect(initial[0]?.records).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(60_000);
        const events = client.events('logs').filter((event) => event.subscription === subscription);
        expect(events.length > 1).toBe(count > 0);
        for (const event of events) {
          expect(event.records?.every((record) => record.workspace === workspace)).toBe(true);
          expect(isRpcEvent(event)).toBe(true);
        }
        await client.request('unsubscribe', { subscription });
      }
    } finally {
      client.connection.close();
      vi.useRealTimers();
    }
  });

  it('serves every read method in shapes the phone accepts', async () => {
    const client = await pair(demo());
    const calls: [string, Record<string, unknown>][] = [
      ['logs.query', { workspace: SEARCH, tail: 20 }],
      ['workspace.files', { workspace: SEARCH, group: 'tracked' }],
      ['workspace.diff', { workspace: SEARCH, path: 'src/screens/search.tsx' }],
      ['build.plan', { workspace: SEARCH, platform: 'ios' }],
      ['build.plan', { workspace: SEARCH, platform: 'android' }],
      ['settings.get', {}],
      ['replay.range', { workspace: SEARCH, platform: 'ios' }],
      ['machine.get', {}],
      ['machine.history', {}],
      ['machine.details', {}],
      ['notifications.list', {}],
    ];
    for (const [method, params] of calls) expect((await client.request(method, params)).result).toBeDefined();
  });

  it('streams status, logs and frames as events the phone accepts', async () => {
    const client = await pair(demo());
    await client.request('status.subscribe');
    await client.request('workspaces.subscribe');
    await client.request('machine.subscribe');
    await client.request('workspace.subscribe', { workspace: SEARCH });
    expect((await client.request('archived.list')).result).toMatchObject({ next: null });
    await client.request('logs.subscribe', { workspace: SEARCH });
    for (const [workspace, platform] of [
      [SEARCH, 'ios'],
      [SEARCH, 'android'],
      [SORTING, 'web'],
      [SORTING, 'macos'],
    ]) {
      await client.request('frames.subscribe', { workspace, platform, slot: 'default' });
    }
    await vi.waitFor(() => {
      expect(client.events('status')).toHaveLength(1);
      for (const name of ['workspaces', 'machine', 'workspace', 'logs']) expect(client.events(name)).toHaveLength(1);
      expect(client.events('frame')).toHaveLength(4);
    });
    const views = ['status', 'workspaces', 'machine', 'workspace'].flatMap((name) => client.events(name));
    expect(client.events('workspace')[0]?.environment).toMatchObject({ path: SEARCH });
    for (const event of [...views, ...client.events('logs'), ...client.events('frame')]) {
      expect(isRpcEvent(event), `${String(event.event)} event the phone accepts`).toBe(true);
    }
    client.close();
  });

  it('refuses subscriptions beyond the per-connection limits and frees a slot on unsubscribe', async () => {
    const client = await greeted(demo());
    const frames = { workspace: SEARCH, platform: 'ios', slot: 'default' };
    const subscriptions: Message['result'][] = [];
    for (let open = 0; open < 16; open++) subscriptions.push((await client.request('frames.subscribe', frames)).result);
    expect((await client.request('frames.subscribe', frames)).error?.code).toBe('limit-exceeded');
    await client.request('unsubscribe', { subscription: subscriptions[0]?.subscription });
    expect((await client.request('frames.subscribe', frames)).result?.subscription).toEqual(expect.any(String));

    await client.request('status.subscribe');
    await client.request('status.subscribe');
    expect((await client.request('status.subscribe')).error?.code).toBe('limit-exceeded');

    for (let open = 0; open < 8; open++) await client.request('logs.subscribe', { workspace: SEARCH });
    expect((await client.request('logs.subscribe', { workspace: SEARCH })).error?.code).toBe('limit-exceeded');
    client.connection.close();
  });

  it('answers reload and stop after a short delay', async () => {
    const client = await pair(demo());
    const reply = await client.request('action', { action: 'reload', workspace: SEARCH, platform: 'ios' });
    expect(reply.result).toMatchObject({ action: 'reload', workspace: SEARCH });
  });

  it('sends nothing to a phone that disconnected before a reload finished', async () => {
    const machine = demo();
    let open = true;
    const connection = machine.connect(
      {
        send: () => {
          if (!open) throw new Error('send after close');
        },
        close: () => {},
      },
      { id: 'abcd1234', name: 'Phone' },
    );
    await connection.receive(
      JSON.stringify({ id: 1, method: 'action', params: { action: 'stop', workspace: SEARCH } }),
    );
    open = false;
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(machine.busy.size).toBe(0);
  });
});

describe('Control', () => {
  it('switches the device to its other screen on each tap, but not on a drag, for every phone watching it', async () => {
    const machine = demo();
    const driver = await pair(machine);
    const watcher = await pair(machine);
    const target = { workspace: SEARCH, platform: 'ios', slot: 'default' };
    await watcher.request('frames.subscribe', target);
    await vi.waitFor(() => expect(watcher.events('frame')).toHaveLength(1));
    const [list, detail] = fixtures.frames.ios!.map((frame) => frame.data);
    expect(watcher.events('frame')[0]?.data).toBe(list);

    const begin = await driver.request('control.begin', target);
    expect(begin.result).toMatchObject({ platform: 'ios', lease: null, postures: [] });
    const session = begin.result?.session;
    const touch = (phase: string, x: number, y: number) => driver.request('input.touch', { session, phase, x, y });
    await touch('down', 0.5, 0.3);
    expect(watcher.events('frame').at(-1)?.data).toBe(list);
    await touch('up', 0.5, 0.3);
    expect(watcher.events('frame').at(-1)?.data).toBe(detail);
    await touch('down', 0.5, 0.8);
    await touch('move', 0.5, 0.5);
    await touch('up', 0.5, 0.2);
    expect(watcher.events('frame').at(-1)?.data).toBe(detail);
    await touch('down', 0.1, 0.1);
    await touch('up', 0.11, 0.1);
    expect(watcher.events('frame').at(-1)?.data).toBe(list);

    for (const [method, params] of [
      ['input.text', { text: 'water' }],
      ['input.button', { button: 'home' }],
      ['input.rotate', { direction: 'left' }],
      ['input.simulator', { action: 'read' }],
    ] as const) {
      expect((await driver.request(method, { session, ...params })).result).toBeDefined();
    }
    await driver.request('control.end', { session });
    expect((await driver.request('input.touch', { session, phase: 'up', x: 0, y: 0 })).error?.code).toBe(
      'unknown-session',
    );
    watcher.close();
    driver.close();
  });

  it('refuses a workspace that is not in the status payload', async () => {
    const client = await pair(demo());
    const reply = await client.request('control.begin', { workspace: '/elsewhere', platform: 'ios' });
    expect(reply.error?.code).toBe('bad-request');
  });
});

describe('upgradeFromWebPage', () => {
  const url = 'https://stim-demo.example.workers.dev/';
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it('accepts the phone app, which sends no Origin or one derived from its own wss URL', () => {
    expect(upgradeFromWebPage(headers({}), url)).toBe(false);
    expect(upgradeFromWebPage(headers({ origin: 'https://stim-demo.example.workers.dev' }), url)).toBe(false);
    expect(upgradeFromWebPage(headers({ origin: 'http://127.0.0.1:8787' }), 'http://127.0.0.1:8787/')).toBe(false);
  });

  it('refuses a browser page, which sends another Origin or Fetch Metadata', () => {
    expect(upgradeFromWebPage(headers({ origin: 'https://evil.example' }), url)).toBe(true);
    expect(upgradeFromWebPage(headers({ origin: 'null' }), url)).toBe(true);
    expect(upgradeFromWebPage(headers({ 'sec-fetch-site': 'cross-site' }), url)).toBe(true);
  });
});
