import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect as tcpConnect, Socket } from 'node:net';
import { WebSocket } from 'ws';
import type { Controller } from '../src/control.ts';
import type { FrameHint } from '../src/frame-helper.ts';
import type { Device, Frame, FrameListener } from '../src/frames.ts';
import { PresenceHub, presenceKey } from '../src/presence.ts';
import { digest } from '../src/share-identity.ts';
import type { ShareSource } from '../src/share-hosted.ts';
import { viewerPage } from '../src/share-page.ts';
import {
  BUTTONS,
  ShareHub,
  type ShareDeps,
  type ShareLimits,
  type ShareRequest,
  type ShareTarget,
  type StartedShare,
  type StatusListener,
} from '../src/share.ts';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol.ts';
import { accessUnitOf, type AccessUnit } from '../src/video.ts';

const WORKSPACE = '/work/app';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function payload(
  state: 'Booted' | 'Shutdown' = 'Booted',
  activity?: Record<string, unknown>,
  app?: { id: string; state: string },
) {
  return {
    environments: [
      { path: WORKSPACE, ios: { udid: 'SIM-1', owned: true, state, name: 'stim-app (iPhone 17)', activity, app } },
    ],
  };
}

interface Fixture {
  hub: ShareHub;
  /** What the hub logged about its device going away (`waiting`) and coming back (`live`), in order. */
  subscribed: { device: Device; listener: FrameListener; hint: FrameHint | undefined; unsubscribed: boolean }[];
  keyframes: number;
  congestions: number;
  begins: unknown[];
  inputs: unknown[];
  inputResult: { text: string } | { typed: true } | { code: 'action-failed' | 'device-busy'; message: string } | null;
  /** The simulator keyboard settings the control hub was handed, by control session. */
  keyboards: { session: string; enabled: boolean }[];
  /** The viewer each input came from, by name. */
  inputBy: string[];
  /** Names of the viewers whose pointer the control hub was told to lift. */
  releases: string[];
  /** The messages the control hub was told to end the share's control session with. */
  endFors: string[];
  /** Ids of the control sessions the fake control hub started. */
  startedSessions: string[];
  /** Ids of the control sessions the fake control hub ended; `endFor` ends every session started so far. */
  endedSessions: string[];
  /** Holds the fake control hub's `begin` after it started its session, before it returns, as the real one does while it opens. */
  startGate: Promise<void> | null;
  /** A holder name the fake control hub turns every touch away for. */
  busy: string | null;
  /** Holds the fake control hub's `begin` until it resolves. */
  beginGate: Promise<void> | null;
  /** How many times the fake control hub's `begin` was called, including calls still held by `beginGate`. */
  beginCalls: number;
  owner: Pick<Controller, 'send'> | null;
  /** A frame the fake frame pool hands every new subscriber at once, as the real one replays its latest frame. */
  replay: Frame | null;
  presence: PresenceHub;
  /** The display names the fake simulator reports, by bundle id. */
  appNames: Record<string, string | null>;
  /** The shares that ended because their device could not stream. */
  gaveUp: ShareTarget[];
  /** Holds the fake `gaveUp` until it resolves, as a write waiting for a lock does; `gaveUpFails` makes it reject. */
  gaveUpLinks: string[];
  gaveUpGate: Promise<void> | null;
  gaveUpFails: boolean;
  routeOpens: number[];
  routeCloses: number;
  idle: number;
  refuseControl: boolean;
  exemptAtBegin: string[][];
  strandedPort: number | null;
  failRoute: { open: boolean; close: boolean };
  listenerBoundAtRouteClose: boolean[];
  status: (value: ReturnType<typeof payload>) => void;
  hostedSources: {
    subscribed: FrameListener[];
    unsubscribed: number;
    inputs: unknown[];
    closed: number;
    keyframes: number;
  }[];
}

function fixture(limits: Partial<ShareLimits> = {}, deps: Partial<ShareDeps> = {}): Fixture {
  const listeners = new Set<StatusListener>();
  let latest = payload();
  const f: Fixture = {
    subscribed: [],
    keyframes: 0,
    congestions: 0,
    begins: [],
    inputs: [],
    inputResult: null,
    keyboards: [],
    inputBy: [],
    releases: [],
    endFors: [],
    startedSessions: [],
    endedSessions: [],
    startGate: null,
    busy: null,
    beginGate: null,
    beginCalls: 0,
    owner: null,
    replay: null,
    presence: new PresenceHub(),
    appNames: {},
    gaveUp: [],
    gaveUpLinks: [],
    gaveUpGate: null,
    gaveUpFails: false,
    routeOpens: [],
    routeCloses: 0,
    idle: 0,
    refuseControl: false,
    exemptAtBegin: [],
    strandedPort: null,
    failRoute: { open: false, close: false },
    listenerBoundAtRouteClose: [],
    status: (value) => {
      latest = value;
      for (const listener of listeners) listener.item(value as never);
    },
    hostedSources: [],
    hub: null as unknown as ShareHub,
  };
  viewerPhases.length = 0;
  f.hub = new ShareHub({
    presence: f.presence,
    appName: async (_udid, bundleId) => f.appNames[bundleId] ?? null,
    frames: {
      keyframe: () => f.keyframes++,
      congested: () => f.congestions++,
      subscribe: (device, listener, hint) => {
        const entry = { device, listener, hint, unsubscribed: false };
        f.subscribed.push(entry);
        if (f.replay) listener.frame(f.replay);
        return () => {
          entry.unsubscribed = true;
        };
      },
    },
    control: {
      begin: async (owner, target, _workspace, allowed) => {
        f.beginCalls++;
        f.owner = owner;
        await f.beginGate;
        if (!allowed()) return { code: 'forbidden', message: 'This device can no longer control devices.' };
        f.begins.push(target);
        f.exemptAtBegin.push([...f.hub.unrecordedTargets()]);
        if (f.refuseControl) return { code: 'device-busy', message: 'This device is driven by Stim Desktop.' };
        const session = `c${f.beginCalls}`;
        await f.startGate;
        f.startedSessions.push(session);
        return { session, platform: 'ios', lease: { grantedAt: 'lease-1', expiresAt: '' }, postures: [] };
      },
      targetOf: (_owner, session) => (session.startsWith('c') ? { platform: 'ios', postures: [] } : null),
      input: async (_owner, session, command, participant) => {
        f.inputs.push({ session, command });
        f.inputBy.push(participant?.name ?? '');
        if (f.busy !== null) return { code: 'device-busy', message: 'busy', busy: f.busy };
        return f.inputResult;
      },
      release: (_owner, _session, participant) => {
        f.releases.push(participant.name);
      },
      deviceKeyboard: (_owner, session, enabled) => {
        f.keyboards.push({ session, enabled });
      },
      endFor: (_owner, _reason, message) => {
        f.endFors.push(message);
        f.endedSessions.push(...f.startedSessions.filter((session) => !f.endedSessions.includes(session)));
      },
      endById: (_owner, session) => {
        if (!f.startedSessions.includes(session) || f.endedSessions.includes(session)) return false;
        f.endedSessions.push(session);
        return true;
      },
    },
    subscribeStatus: (listener) => {
      listeners.add(listener);
      listener.item(latest as never);
      return () => listeners.delete(listener);
    },
    route: {
      open: async (target) => {
        if (f.failRoute.open) throw new Error('tailscale is not running');
        f.strandedPort = null;
        f.routeOpens.push(target);
        return { url: 'https://mac.tail.ts.net:10000', port: 10000 };
      },
      stranded: () => f.strandedPort,
      removeStranded: async () => {
        if (f.failRoute.close) throw new Error('funnel off timed out');
        f.strandedPort = null;
      },
      close: async () => {
        f.routeCloses++;
        const port = f.routeOpens.at(-1)!;
        if (f.failRoute.close) {
          f.strandedPort = port;
          throw new Error('funnel off timed out');
        }
        f.listenerBoundAtRouteClose.push(
          await new Promise<boolean>((resolve) => {
            const probe = tcpConnect(port, '127.0.0.1', () => {
              probe.destroy();
              resolve(true);
            });
            probe.once('error', () => resolve(false));
          }),
        );
      },
    },
    hosted: () => {
      const record = {
        subscribed: [] as FrameListener[],
        unsubscribed: 0,
        inputs: [] as unknown[],
        closed: 0,
        keyframes: 0,
      };
      f.hostedSources.push(record);
      const source: ShareSource = {
        subscribe: (listener) => {
          record.subscribed.push(listener as FrameListener);
          return () => {
            record.unsubscribed++;
          };
        },
        keyframe: () => record.keyframes++,
        congested: () => {},
        begin: async () => ({ session: 'h1', platform: 'ios', lease: { grantedAt: 'l', expiresAt: '' }, postures: [] }),
        targetOf: (_owner, session) => (session === 'h1' ? { platform: 'ios', postures: [] } : null),
        input: async (_owner, session, method, params) => {
          record.inputs.push({ session, method, params });
          return null;
        },
        endFor: () => {},
        end: () => {},
        close: () => {
          record.closed++;
        },
      };
      return source;
    },
    limits: { maxFailures: 3, ...limits },
    idle: () => f.idle++,
    gaveUp: async (target, link) => {
      f.gaveUp.push(target);
      f.gaveUpLinks.push(link);
      await f.gaveUpGate;
      if (f.gaveUpFails) throw new Error('lock timeout');
    },
    ...deps,
  });
  return f;
}

/** What the viewers connected in this test were last told: `stopped` is `waiting`, `resumed` is `live`. */
const viewerPhases: ('waiting' | 'live')[] = [];
const stateOf = (_f: Fixture) => viewerPhases.at(-1);

const shareRequest = (overrides: Partial<ShareRequest> = {}): ShareRequest => ({
  workspace: WORKSPACE,
  platform: 'ios',
  control: false,
  expiresMinutes: 60,
  ...overrides,
});

async function started(f: Fixture, overrides: Partial<ShareRequest> = {}): Promise<StartedShare> {
  const share = await f.hub.start(shareRequest(overrides));
  if ('code' in share) throw new Error(share.message);
  return share;
}

function local(share: StartedShare, port: number): string {
  return new URL(share.url).pathname.replace(/^/, `http://127.0.0.1:${port}`);
}

function bound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = tcpConnect(port, '127.0.0.1', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function http(
  url: string,
  options: { method?: string; body?: string; cookie?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(
      url,
      {
        method: options.method ?? 'GET',
        headers: {
          ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
      },
    );
    sent.on('error', reject);
    sent.end(options.body);
  });
}

async function login(url: string, password: string): Promise<string> {
  const answer = await http(`${url}login`, { method: 'POST', body: `password=${password}` });
  expect(answer.status).toBe(303);
  return String(answer.headers['set-cookie']).split(';')[0]!;
}

function connect(
  url: string,
  headers: Record<string, string>,
  query = '',
): Promise<{ socket: WebSocket; status: number | null; messages: Record<string, unknown>[] }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}ws${query}`, { headers });
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (data, binary) => {
      if (binary) return;
      const message = JSON.parse(String(data));
      messages.push(message);
      if (message.type === 'stopped') viewerPhases.push('waiting');
      if (message.type === 'resumed') viewerPhases.push('live');
    });
    socket.once('open', () => resolve({ socket, status: null, messages }));
    socket.once('unexpected-response', (_request, response) =>
      resolve({ socket, status: response.statusCode!, messages }),
    );
    socket.once('error', () => {});
  });
}

function unit(keyframe: boolean, capturedAt: number): AccessUnit {
  return { keyframe, capturedAt, width: 590, height: 1280, data: Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41]) };
}

function videoOf(listener: FrameListener): NonNullable<FrameListener['video']> {
  if (!listener.video) throw new Error('the viewer was not subscribed for video');
  return listener.video;
}

function binaryMessages(socket: WebSocket): Buffer[] {
  const received: Buffer[] = [];
  socket.on('message', (data, binary) => {
    if (binary) received.push(data as Buffer);
  });
  return received;
}

function origin(url: string): string {
  return new URL(url).origin;
}

describe('a web share', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(async () => {
    await f.hub.close();
    f.presence.close();
    vi.restoreAllMocks();
  });

  it('opens one Funnel route for its loopback listener and hands out a high-entropy link and password', async () => {
    const share = await started(f);
    expect(f.routeOpens).toEqual([f.hub.port]);
    expect(share.url).toMatch(/^https:\/\/mac\.tail\.ts\.net:10000\/s\/[A-Za-z0-9_-]{43}\/$/);
    expect(share.password!).toMatch(/^[a-z2-9]{16}$/);
    await started(f, { control: true });
    expect(f.routeOpens).toHaveLength(1);
  });

  it('serves nothing for an unknown token or any other path', async () => {
    const share = await started(f);
    const port = f.hub.port!;
    for (const path of ['/', '/status', `/s/${'A'.repeat(43)}/`, `${new URL(share.url).pathname}../../etc`]) {
      expect((await http(`http://127.0.0.1:${port}${path}`)).status).toBe(404);
    }
  });

  it('survives a client that resets the connection after a refused upgrade', async () => {
    const share = await started(f);
    const port = f.hub.port!;
    const refused = tcpConnect(port, '127.0.0.1');
    await new Promise<void>((resolve) => {
      refused.once('connect', () => {
        refused.write('GET /nope HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n', () => {
          refused.resetAndDestroy();
          resolve();
        });
      });
    });
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
    expect((await http(local(share, port))).status).toBe(200);
  });

  it('asks for the password, refuses a wrong one and locks the login after repeated failures', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    const page = await http(url);
    expect(page.status).toBe(200);
    expect(page.body).toContain('name="access"');
    expect(page.body).not.toContain('type="password"');
    expect(page.body).not.toMatch(/password/i);
    expect(page.body.match(/<input/g)).toHaveLength(1);
    expect(page.headers['cache-control']).toBe('no-store');
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await http(`${url}login`, { method: 'POST', body: 'password=wrong' })).status).toBe(401);
    }
    const locked = await http(`${url}login`, { method: 'POST', body: `password=${share.password!}` });
    expect(locked.status).toBe(429);
    expect(locked.headers['set-cookie']).toBeUndefined();
  });

  it('admits the access code field and still the earlier password field a page left open across an update posts', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port ?? 0);
    const named = await http(`${url}login`, { method: 'POST', body: `access=${share.password ?? ''}` });
    expect(named.status).toBe(303);
    expect(String(named.headers['set-cookie'])).toContain('stim_share=');
    const legacy = await http(`${url}login`, { method: 'POST', body: `password=${share.password ?? ''}` });
    expect(legacy.status).toBe(303);
  });

  it('sets an HttpOnly, Secure, SameSite=Strict session cookie scoped to the share and ending with it', async () => {
    const share = await started(f, { expiresMinutes: 30 });
    const url = local(share, f.hub.port!);
    const answer = await http(`${url}login`, { method: 'POST', body: `password=${share.password!}` });
    const cookie = String(answer.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toContain(`Path=${new URL(share.url).pathname}`);
    expect(cookie).toContain('Max-Age=1800');
    const viewer = await http(url, { cookie: cookie.split(';')[0]! });
    expect(viewer.body).toContain('id="screen"');
  });

  it('without a password, serves the page and the stream to anyone with the link, from the same origin', async () => {
    const share = await started(f, { passwordless: true });
    expect(share.auth).toBe('none');
    expect(share.password).toBeUndefined();
    const url = local(share, f.hub.port!);
    expect((await http(url)).body).toContain('id="screen"');
    expect((await http(`${url}login`, { method: 'POST', body: 'password=anything' })).status).toBe(404);
    expect((await connect(url, { origin: 'https://evil.example' })).status).toBe(403);
    const { socket } = await connect(url, { origin: origin(url) });
    expect(f.subscribed).toHaveLength(1);
    socket.close();
  });

  it('admits a password the person set and never returns it', async () => {
    const share = await started(f, { password: 'correct horse' });
    expect(share).toMatchObject({ auth: 'set' });
    expect(JSON.stringify(share)).not.toContain('correct horse');
    expect(JSON.stringify(f.hub.list())).not.toContain('correct horse');
    const url = local(share, f.hub.port!);
    expect((await http(`${url}login`, { method: 'POST', body: 'password=wrong%20horse' })).status).toBe(401);
    const cookie = await login(url, 'correct%20horse');
    expect((await connect(url, { origin: origin(url), cookie })).status).toBeNull();
  });

  it('starts capture only for a signed-in viewer from the same origin, and stops it when the viewer leaves', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    expect((await connect(url, { origin: origin(url) })).status).toBe(401);
    const cookie = await login(url, share.password!);
    expect((await connect(url, { origin: 'https://evil.example', cookie })).status).toBe(403);
    expect(f.subscribed).toEqual([]);

    const { socket } = await connect(url, { origin: origin(url), cookie });
    expect(f.subscribed).toHaveLength(1);
    expect(f.subscribed[0]!.device).toEqual({ platform: 'ios', udid: 'SIM-1', foldable: false });
    expect(f.hub.list()[0]!.viewers).toBe(1);
    const frame = new Promise<Buffer>((resolve) =>
      socket.on('message', (data, binary) => {
        if (binary) resolve(data as Buffer);
      }),
    );
    f.subscribed[0]!.listener.frame({ width: 1, height: 1, capturedAt: '', data: JPEG.toString('base64') });
    expect(Buffer.compare(await frame, JPEG)).toBe(0);

    socket.close();
    await vi.waitFor(() => expect(f.subscribed[0]!.unsubscribed).toBe(true));
    expect(f.hub.list()[0]!.viewers).toBe(0);
  });

  it('replaces the stale socket of a page that reconnects, even at the viewer cap, but never another page or session', async () => {
    f = fixture({ maxViewers: 3 });
    const share = await started(f);
    const url = local(share, f.hub.port ?? 0);
    const cookie = await login(url, share.password ?? '');
    const ask = (key: string, id: string) => connect(url, { origin: origin(url), cookie: key }, `?id=${id}`);
    const page = 'a'.repeat(32);

    const first = await ask(cookie, page);
    const dropped = new Promise((resolve) => first.socket.once('close', resolve));
    const second = await ask(cookie, page);
    await dropped;
    await vi.waitFor(() => expect(f.hub.list()[0]?.viewers).toBe(1));
    expect(second.socket.readyState).toBe(WebSocket.OPEN);

    const other = await ask(cookie, 'b'.repeat(32));
    const stranger = await ask(await login(url, share.password ?? ''), page);
    await vi.waitFor(() => expect(f.hub.list()[0]?.viewers).toBe(3));
    expect([second, other, stranger].map((viewer) => viewer.socket.readyState)).toEqual([1, 1, 1]);

    const third = await ask(cookie, page);
    expect(third.status).toBeNull();
    expect((await ask(cookie, 'c'.repeat(32))).status).toBe(503);
    for (const viewer of [second, other, stranger, third]) viewer.socket.close();
  });

  it('closes viewers without an ended message when stim-server itself stops, so their pages reconnect', async () => {
    const share = await started(f, { passwordless: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket, messages } = await connect(url, { origin: origin(url) });
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    await f.hub.close();
    expect(await closed).toBe(1001);
    expect(messages.map((message) => message.type)).not.toContain('ended');
  });

  it('streams H.264 at 60 fps to a viewer that asks for it, from a keyframe it requests on join, and JPEG at 10 fps otherwise', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    const cookie = await login(url, share.password!);
    await connect(url, { origin: origin(url), cookie });
    expect(f.subscribed.map(({ hint, listener }) => [hint, listener.video])).toEqual([
      [{ fps: 10, maxEdge: 1280 }, undefined],
    ]);
    expect(f.keyframes).toBe(0);

    const { socket } = await connect(url, { origin: origin(url), cookie }, '?codec=h264');
    const viewer = f.subscribed[1]!;
    const video = videoOf(viewer.listener);
    expect(viewer.hint).toEqual({ fps: 60, maxEdge: 1280 });
    expect(f.keyframes).toBe(1);
    const received = binaryMessages(socket);
    video(unit(false, 1));
    video(unit(true, 2));
    video(unit(false, 3));
    viewer.listener.frame({ width: 1, height: 1, capturedAt: '', data: JPEG.toString('base64') });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.slice(0, 2).map((packet) => accessUnitOf(packet))).toEqual([unit(true, 2), unit(false, 3)]);
    expect(received[2]).toEqual(JPEG);
  });

  it('drops a video viewer to the next keyframe when it asks for one, even on a share without control', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    const cookie = await login(url, share.password!);
    const { socket } = await connect(url, { origin: origin(url), cookie }, '?codec=h264');
    const received = binaryMessages(socket);
    const video = videoOf(f.subscribed[0]!.listener);
    video(unit(true, 1));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    socket.send(JSON.stringify({ type: 'keyframe' }));
    await vi.waitFor(() => expect(f.keyframes).toBe(2));
    video(unit(false, 2));
    video(unit(true, 3));
    video(unit(false, 4));
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.slice(1).map((packet) => accessUnitOf(packet))).toEqual([unit(true, 3), unit(false, 4)]);
    expect(f.inputs).toEqual([]);
  });

  it('ignores the WebRTC messages a page loaded before the upgrade sends, keeping its socket and video', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(
      url,
      { origin: origin(url), cookie: await login(url, share.password ?? '') },
      '?codec=h264',
    );
    const received = binaryMessages(socket);
    let closed = false;
    socket.on('close', () => (closed = true));
    socket.send(JSON.stringify({ type: 'webrtc-offer', sdp: 'offer-sdp', attempt: 1 }));
    socket.send(JSON.stringify({ type: 'transport', via: 'webrtc', attempt: 1 }));
    socket.send(JSON.stringify({ type: 'transport', via: 'ws' }));
    const listener = f.subscribed[0]?.listener;
    if (!listener) throw new Error('the viewer was not subscribed');
    const video = videoOf(listener);
    video(unit(true, 1));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(closed).toBe(false);
    expect(f.inputs).toEqual([]);
  });

  it('drops a backed-up video viewer to the next keyframe, lowering the bitrate until its socket drains', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    const cookie = await login(url, share.password!);
    const { socket } = await connect(url, { origin: origin(url), cookie }, '?codec=h264');
    const received = binaryMessages(socket);
    const video = videoOf(f.subscribed[0]!.listener);
    video(unit(true, 1));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const tcp: unknown = Reflect.get(socket, '_socket');
    if (!(tcp instanceof Socket)) throw new Error('ws exposes no TCP socket');
    tcp.pause();
    const big = (capturedAt: number): AccessUnit => ({
      ...unit(false, capturedAt),
      data: Buffer.alloc(1024 * 1024, 1),
    });
    let pushed = 1;
    await vi.waitFor(() => {
      video(big(++pushed));
      expect(f.congestions).toBeGreaterThan(0);
    });
    const keyframesWhileCongested = f.keyframes;
    video(big(10_000));
    video(unit(true, 10_001));
    tcp.resume();
    await vi.waitFor(() => expect(f.keyframes).toBe(keyframesWhileCongested + 1));
    video(unit(false, 10_002));
    video(unit(true, 10_003));
    video(unit(false, 10_004));
    const late = () =>
      received.map((packet) => accessUnitOf(packet)?.capturedAt ?? 0).filter((capturedAt) => capturedAt >= 10_000);
    await vi.waitFor(() => expect(late()).toEqual([10_003, 10_004]));
  });

  it('drops input without --control and never begins a control session', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5 }));
    socket.send(JSON.stringify({ type: 'text', text: 'hi' }));
    socket.send(JSON.stringify({ type: 'key', key: 'left' }));
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'abc', paste: true }));
    socket.send(JSON.stringify({ type: 'clipboard-get', id: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.begins).toEqual([]);
    expect(f.inputs).toEqual([]);
    socket.close();
  });

  it('with --control, starts control when a viewer connects, so its first touch finds the session open', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    expect(f.inputs).toEqual([]);
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.beginCalls).toBe(1);
    socket.close();
  });

  it('with --control, does not tell viewers that control which nobody used ended when it idles', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket, messages } = await connect(url, {
      origin: origin(url),
      cookie: await login(url, share.password ?? ''),
    });
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    const idle = { event: 'control-ended', session: 'c1', reason: 'idle', message: 'No input for 5 minutes.' } as const;
    f.inputResult = { text: 'from the device' };
    socket.send(JSON.stringify({ type: 'clipboard-get', id: 1, poll: true }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'clipboard', id: 1, text: 'from the device' }));
    f.owner?.send(idle);
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await vi.waitFor(() => expect(f.begins).toHaveLength(2));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    f.owner?.send({ ...idle, session: 'c2' });
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'control', message: 'Control ended.' }));
    expect(messages.filter((message) => message.type === 'control')).toHaveLength(1);
    socket.close();
  });

  it('with --control, starts control again for a viewer that reconnects after the last one left during the start', async () => {
    let release = () => {};
    f.beginGate = new Promise<void>((resolve) => (release = resolve));
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const cookie = await login(url, share.password ?? '');
    const first = await connect(url, { origin: origin(url), cookie });
    await vi.waitFor(() => expect(f.beginCalls).toBe(1));
    first.socket.close();
    await vi.waitFor(() => expect(f.hub.list()[0]?.viewers).toBe(0));
    release();
    await vi.advanceTimersByTimeAsync(20);
    f.beginGate = null;
    const second = await connect(url, { origin: origin(url), cookie });
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    expect(second.messages.map((message) => message.type)).not.toContain('control');
    second.socket.close();
  });

  it('with --control, passes the second finger of a touch on and drops a half pair', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.25, y: 0.5, x2: 0.75 }));
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5 }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.inputs).toEqual([
      { session: 'c1', command: { input: 'touch', phase: 'down', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5 } },
    ]);
    socket.close();
  });

  it('with --control, keeps a touch down and up while the input rate limit drops moves', async () => {
    await f.hub.stop(WORKSPACE);
    f = fixture({ inputPerSecond: 4 });
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    const touch = (phase: string) => JSON.stringify({ type: 'touch', phase, x: 0.5, y: 0.5 });
    socket.send(touch('down'));
    for (let move = 0; move < 20; move++) socket.send(touch('move'));
    socket.send(touch('up'));
    await vi.waitFor(() => expect(f.inputs.at(-1)).toMatchObject({ command: { phase: 'up' } }));
    expect(f.inputs[0]).toMatchObject({ command: { phase: 'down' } });
    expect(f.inputs.length).toBeLessThan(10);
    socket.close();
  });

  it('with --control, drives only the shared device through the control hub and refuses other buttons', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port!);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    socket.send(JSON.stringify({ type: 'button', button: 'back' }));
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.25, y: 0.75, workspace: '/other' }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.begins).toEqual([{ workspace: WORKSPACE, platform: 'ios' }]);
    expect(f.inputs).toEqual([{ session: 'c1', command: { input: 'touch', phase: 'down', x: 0.25, y: 0.75 } }]);
    const key = JSON.stringify([WORKSPACE, 'ios', 'default']);
    expect(f.exemptAtBegin).toEqual([[key]]);
    expect(f.hub.unrecordedTargets()).toEqual(new Set([key]));
    socket.close();
    await f.hub.stop(WORKSPACE);
    expect(f.hub.unrecordedTargets()).toEqual(new Set([key]));
    vi.advanceTimersByTime(2 * 60_000);
    expect(f.hub.unrecordedTargets()).toEqual(new Set());
  });

  it('with --control, passes the keys input.key names and drops every other key', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    for (const key of ['f1', 'unknown', 7, null]) socket.send(JSON.stringify({ type: 'key', key }));
    for (const key of ['left', 'escape', 'tab', 'a']) socket.send(JSON.stringify({ type: 'key', key }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(4));
    expect(f.inputs).toEqual(
      ['left', 'escape', 'tab', 'a'].map((key) => ({ session: 'c1', command: { input: 'key', key, modifiers: [] } })),
    );
    socket.close();
  });

  it('with --control, keeps the simulator keyboard setting for the share: every viewer sees it, a later one gets it, and each new control session is handed it', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const headers = { origin: origin(url), cookie: await login(url, share.password ?? '') };
    const first = await connect(url, headers);
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    expect(f.keyboards).toEqual([]);
    await vi.waitFor(() =>
      expect(first.messages).toContainEqual({ type: 'deviceKeyboard', available: true, on: false }),
    );

    first.socket.send(JSON.stringify({ type: 'device-keyboard', on: true }));
    await vi.waitFor(() => expect(f.keyboards.at(-1)).toEqual({ session: 'c1', enabled: true }));
    const second = await connect(url, headers);
    await vi.waitFor(() =>
      expect(second.messages).toContainEqual({ type: 'deviceKeyboard', available: true, on: true }),
    );
    expect(first.messages.findLast((m) => m.type === 'deviceKeyboard')).toEqual({
      type: 'deviceKeyboard',
      available: true,
      on: true,
    });

    f.owner?.send({ event: 'control-ended', session: 'c1', reason: 'failed', message: 'stim-frames exited.' });
    first.socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await vi.waitFor(() => expect(f.keyboards.at(-1)).toEqual({ session: 'c2', enabled: true }));

    second.socket.send(JSON.stringify({ type: 'device-keyboard', on: false }));
    await vi.waitFor(() => expect(f.keyboards.at(-1)).toEqual({ session: 'c2', enabled: false }));
    first.socket.close();
    second.socket.close();
  });

  it('with --control, sets and pastes clipboard text, and drops what the clipboard parser refuses', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    const text = 'h\u00e9llo \u{1f600}\n';
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'a'.repeat(MAX_CLIPBOARD_BYTES + 1), paste: true }));
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 7 }));
    socket.send(JSON.stringify({ type: 'clipboard-set', text, paste: true }));
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'no paste' }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    expect(f.inputs).toEqual([
      { session: 'c1', command: { input: 'clipboard', text, paste: true } },
      { session: 'c1', command: { input: 'clipboard', text: 'no paste', paste: false } },
    ]);
    socket.close();
  });

  it('tells the viewer to tap the paste suggestion only when an iOS paste was not typed', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    const notes: unknown[] = [];
    socket.on('message', (data, binary) => {
      if (!binary) notes.push(JSON.parse(data.toString()));
    });
    const suggestion = { type: 'control', message: expect.stringContaining('paste suggestion') };
    f.inputResult = { typed: true };
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'typed', paste: true }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    f.inputResult = null;
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'not typed', paste: true }));
    await vi.waitFor(() => expect(notes).toContainEqual(suggestion));
    expect(notes.filter((note) => JSON.stringify(note).includes('suggestion'))).toHaveLength(1);
    f.inputResult = { code: 'device-busy', message: 'typing' };
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'again', paste: true }));
    await vi.waitFor(() =>
      expect(notes).toContainEqual({ type: 'control', message: expect.stringContaining('still typing') }),
    );
    f.inputResult = null;
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'only set' }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(4));
    expect(notes.filter((note) => JSON.stringify(note).includes('suggestion'))).toHaveLength(1);
    socket.close();
  });

  it('with --control, returns the device clipboard to the viewer that asked and to no other', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const cookie = await login(url, share.password ?? '');
    const asking = await connect(url, { origin: origin(url), cookie });
    const other = await connect(url, { origin: origin(url), cookie });
    const received = (socket: WebSocket) => {
      const messages: unknown[] = [];
      socket.on('message', (data, binary) => {
        if (!binary) messages.push(JSON.parse(data.toString()));
      });
      return messages;
    };
    const mine = received(asking.socket);
    const theirs = received(other.socket);
    f.inputResult = { text: 'from the device' };
    asking.socket.send(JSON.stringify({ type: 'clipboard-get', id: 41 }));
    await vi.waitFor(() => expect(mine).toContainEqual({ type: 'clipboard', id: 41, text: 'from the device' }));
    expect(f.inputs).toEqual([{ session: 'c1', command: { input: 'clipboard-get' } }]);
    other.socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    expect(JSON.stringify(theirs)).not.toContain('"clipboard"');
    asking.socket.close();
    other.socket.close();
  });

  it('answers a polling clipboard read while control is still starting, and serves it once control runs', async () => {
    let release = () => {};
    f.beginGate = new Promise<void>((resolve) => (release = resolve));
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket, messages } = await connect(url, {
      origin: origin(url),
      cookie: await login(url, share.password ?? ''),
    });
    await vi.waitFor(() => expect(f.beginCalls).toBe(1));
    f.inputResult = { text: 'from the device' };
    socket.send(JSON.stringify({ type: 'clipboard-get', id: 1, poll: true }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'clipboard', id: 1, error: expect.any(String) }));
    expect(f.beginCalls).toBe(1);
    expect(f.inputs).toEqual([]);
    release();
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    socket.send(JSON.stringify({ type: 'clipboard-get', id: 2, poll: true }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'clipboard', id: 2, text: 'from the device' }));
    socket.close();
  });

  it('answers a clipboard read at once when control cannot start', async () => {
    f.refuseControl = true;
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    const messages: unknown[] = [];
    socket.on('message', (data, binary) => {
      if (!binary) messages.push(JSON.parse(data.toString()));
    });
    socket.send(JSON.stringify({ type: 'clipboard-get', id: 9 }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'clipboard', id: 9, error: expect.any(String) }));
    socket.close();
  });

  it('answers a refused clipboard read or set with a fixed message, never the internal reason', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    const messages: unknown[] = [];
    socket.on('message', (data, binary) => {
      if (!binary) messages.push(JSON.parse(data.toString()));
    });
    f.inputResult = { code: 'action-failed', message: 'simctl pbpaste failed in /Users/me/secret-app' };
    socket.send(JSON.stringify({ type: 'clipboard-get', id: 5 }));
    socket.send(JSON.stringify({ type: 'clipboard-set', text: 'abc' }));
    await vi.waitFor(() =>
      expect(messages).toEqual(
        expect.arrayContaining([
          { type: 'clipboard', id: 5, error: expect.any(String) },
          { type: 'control', message: expect.any(String) },
        ]),
      ),
    );
    expect(JSON.stringify(messages)).not.toContain('secret-app');
    socket.close();
  });

  describe('page titles', () => {
    const running = (id: string) => payload('Booted', undefined, { id, state: 'running' });
    const title = (body: string) => /<title>(.*)<\/title>/u.exec(body)?.[1];

    it('names the app and device on the viewer and login pages and never the workspace, escaping the app name', async () => {
      f.appNames['dev.pokedex'] = 'Pokedex <b>Demo & Co';
      f.status(running('dev.pokedex'));
      const share = await started(f, { control: true });
      const url = local(share, f.hub.port ?? 0);
      await vi.waitFor(async () => expect(title((await http(url)).body)).toContain('Pokedex'));
      expect(title((await http(url)).body)).toBe('Pokedex &#60;b&#62;Demo &#38; Co \u00b7 Stim');
      const cookie = await login(url, share.password ?? '');
      const page = await http(url, { cookie });
      expect(title(page.body)).toBe('Pokedex &#60;b&#62;Demo &#38; Co \u00b7 iPhone 17 \u00b7 Stim');
      expect(page.body).not.toContain(WORKSPACE);
      expect(page.body).not.toContain('stim-app');
    });

    it('falls back to a generic title when the app name cannot be read', async () => {
      f.status(running('dev.unknown'));
      const share = await started(f, { control: true });
      const url = local(share, f.hub.port ?? 0);
      const page = await http(url, { cookie: await login(url, share.password ?? '') });
      expect(title(page.body)).toBe('Live iOS app \u00b7 iPhone 17 \u00b7 Stim');
      expect(title((await http(url)).body)).toBe('Shared app \u00b7 Stim');
    });

    it('sends the title to a viewer and again when the app changes', async () => {
      f.appNames['dev.one'] = 'One';
      f.appNames['dev.two'] = 'Two';
      f.status(running('dev.one'));
      const share = await started(f, { control: true });
      const url = local(share, f.hub.port ?? 0);
      const { socket, messages } = await connect(url, {
        origin: origin(url),
        cookie: await login(url, share.password ?? ''),
      });
      const titles = () => messages.filter((m) => m.type === 'title' || m.type === 'hello').map((m) => m.title);
      await vi.waitFor(() => expect(titles().at(-1)).toBe('One \u00b7 iPhone 17 \u00b7 Stim'));
      f.status(running('dev.two'));
      await vi.waitFor(() => expect(titles().at(-1)).toBe('Two \u00b7 iPhone 17 \u00b7 Stim'));
      socket.close();
    });

    it('titles the page of an ended or unknown link "Share ended"', async () => {
      const share = await started(f);
      const url = local(share, f.hub.port ?? 0);
      const unknown = await http(url.replace(/\/s\/[^/]+\//, '/s/' + 'x'.repeat(43) + '/'));
      expect(unknown.status).toBe(404);
      expect(title(unknown.body)).toBe('Share ended &middot; Stim');
    });
  });

  describe('with a view password next to the control one', () => {
    const touch = (x = 0.25) => JSON.stringify({ type: 'touch', phase: 'down', x, y: 0.75 });
    const signed = async (control = 'control pass', view = 'view password') => {
      const share = await started(f, { control: true, password: control, view: { password: view } });
      const url = local(share, f.hub.port ?? 0);
      return { share, url, headers: { origin: origin(url) } };
    };

    it('refuses a view password without control or with a password it equals, and never returns either', async () => {
      expect(await f.hub.start(shareRequest({ view: {} }))).toMatchObject({ code: 'bad-request' });
      expect(await f.hub.start(shareRequest({ control: true, passwordless: true, view: {} }))).toMatchObject({
        code: 'bad-request',
      });
      expect(
        await f.hub.start(shareRequest({ control: true, password: 'same one!', view: { password: 'same one!' } })),
      ).toMatchObject({ code: 'bad-request' });
      const share = await started(f, { control: true, view: {} });
      expect(share).toMatchObject({ auth: 'generated', viewAuth: 'generated' });
      expect(share.viewPassword).toMatch(/^[a-z2-9]{16}$/);
      expect(share.viewPassword).not.toBe(share.password);
      const chosen = await started(f, { control: true, view: { password: 'watch only' } });
      expect(chosen).toMatchObject({ viewAuth: 'set' });
      expect(JSON.stringify([chosen, f.hub.list()])).not.toContain('watch only');
    });

    it('lets the control password tap and drops every input from a viewer that logged in with the view password', async () => {
      const { url, headers } = await signed();
      const watcher = await connect(url, { ...headers, cookie: await login(url, 'view%20password') });
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.beginCalls).toBe(0);
      const driver = await connect(url, { ...headers, cookie: await login(url, 'control%20pass') });
      for (const type of ['touch', 'text', 'key', 'button', 'rotate']) {
        watcher.socket.send(
          JSON.stringify({
            type,
            phase: 'down',
            x: 0.5,
            y: 0.5,
            text: 'a',
            key: 'left',
            button: 'home',
            direction: 'left',
          }),
        );
      }
      driver.socket.send(touch());
      await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.inputs).toEqual([{ session: 'c1', command: { input: 'touch', phase: 'down', x: 0.25, y: 0.75 } }]);
      watcher.socket.close();
      driver.socket.close();
    });

    it('never sets or reads the device clipboard for a viewer that logged in with the view password', async () => {
      const { url, headers } = await signed();
      f.inputResult = { text: 'device secret' };
      const watcher = await connect(url, { ...headers, cookie: await login(url, 'view%20password') });
      const received: string[] = [];
      watcher.socket.on('message', (data, binary) => {
        if (!binary) received.push(data.toString());
      });
      watcher.socket.send(JSON.stringify({ type: 'clipboard-set', text: 'abc', paste: true }));
      watcher.socket.send(JSON.stringify({ type: 'clipboard-get', id: 1 }));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.inputs).toEqual([]);
      expect(received.join('')).not.toContain('device secret');
      watcher.socket.close();
    });

    it('serves a view session the view-only page with the upgrade offer, and a control session the controls', async () => {
      const { url } = await signed();
      const watching = (await http(url, { cookie: await login(url, 'view%20password') })).body;
      expect(watching).toContain('data-control="false"');
      expect(watching).toContain('data-view-only="true"');
      expect(watching).toContain('data-upgrade="true"');
      const driving = (await http(url, { cookie: await login(url, 'control%20pass') })).body;
      expect(driving).toContain('data-control="true"');
      expect(driving).toContain('data-view-only="false"');
      expect(driving).toContain('data-upgrade="false"');
    });

    it('offers the simulator keyboard setting only to a control session, and ignores it from a view session', async () => {
      const { url, headers } = await signed();
      const watcher = await connect(url, { ...headers, cookie: await login(url, 'view%20password') });
      const driver = await connect(url, { ...headers, cookie: await login(url, 'control%20pass') });
      await vi.waitFor(() =>
        expect(driver.messages).toContainEqual({ type: 'deviceKeyboard', available: true, on: false }),
      );
      watcher.socket.send(JSON.stringify({ type: 'device-keyboard', on: true }));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(watcher.messages.map((m) => m.type)).not.toContain('deviceKeyboard');
      expect(driver.messages.filter((m) => m.type === 'deviceKeyboard')).toEqual([
        { type: 'deviceKeyboard', available: true, on: false },
      ]);
      expect(f.keyboards.filter((entry) => entry.enabled)).toEqual([]);
      watcher.socket.close();
      driver.socket.close();
    });

    it('raises a view session to control on the control password, keeps it view on a wrong one, and never lowers one', async () => {
      const { url, headers } = await signed();
      const cookie = await login(url, 'view%20password');
      const wrong = await http(`${url}login`, { method: 'POST', body: 'password=nope', cookie });
      expect(wrong).toMatchObject({ status: 303 });
      expect(wrong.headers.location).toContain('?upgrade=wrong');
      expect(wrong.headers['set-cookie']).toBeUndefined();
      const { socket } = await connect(url, { ...headers, cookie });
      socket.send(touch());
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.inputs).toEqual([]);

      const raised = await http(`${url}login`, { method: 'POST', body: 'password=control%20pass', cookie });
      expect(raised.status).toBe(303);
      expect(raised.headers['set-cookie']).toBeUndefined();
      socket.send(touch());
      await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
      await http(`${url}login`, { method: 'POST', body: 'password=view%20password', cookie });
      socket.send(touch(0.5));
      await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
      socket.close();
    });

    it('counts a wrong upgrade password against the share, like any wrong password', async () => {
      const { url } = await signed();
      const cookie = await login(url, 'view%20password');
      for (let attempt = 0; attempt < 3; attempt++)
        await http(`${url}login`, { method: 'POST', body: 'password=x', cookie });
      const locked = await http(`${url}login`, { method: 'POST', body: 'password=control%20pass', cookie });
      expect(locked.headers.location).toContain('?upgrade=limited');
    });

    it('names each viewer, tells it who it is, and shows the others on the roster without echoing its own entry', async () => {
      const { url, headers } = await signed();
      const named = await http(`${url}login`, {
        method: 'POST',
        body: 'password=control%20pass&name=%20%20Ann%E2%80%AE%20',
      });
      const first = await connect(url, { ...headers, cookie: String(named.headers['set-cookie']).split(';')[0] ?? '' });
      const firstMessages = first.messages;
      const second = await connect(url, { ...headers, cookie: await login(url, 'view%20password') });
      const secondMessages = second.messages;
      await vi.waitFor(() => expect(firstMessages.map((m) => m.type)).toContain('presence'));
      expect(firstMessages.find((m) => m.type === 'you')).toMatchObject({ name: 'Ann', color: 2, access: 'control' });
      expect(firstMessages.filter((m) => m.type === 'presence')).toEqual([
        {
          type: 'presence',
          participants: [{ id: expect.any(String), kind: 'viewer', name: 'Guest 1', color: 3, viewOnly: true }],
        },
      ]);
      await vi.waitFor(() => expect(secondMessages.find((m) => m.type === 'you')).toBeDefined());
      expect(secondMessages.find((m) => m.type === 'you')).toMatchObject({ name: 'Guest 1', color: 3, access: 'view' });
      second.socket.close();
      await vi.waitFor(() =>
        expect(firstMessages.at(-1)).toMatchObject({
          type: 'presence',
          participants: [{ name: 'Guest 1', touch: null }],
        }),
      );
      first.socket.close();
    });

    it("tells a viewer whose touch another holds who holds the pointer, and lifts a closed socket's pointer", async () => {
      const { url, headers } = await signed();
      const { socket, messages } = await connect(url, { ...headers, cookie: await login(url, 'control%20pass') });
      f.busy = 'Ann';
      socket.send(touch());
      await vi.waitFor(() => expect(messages).toContainEqual({ type: 'busy', name: 'Ann' }));
      expect(messages.filter((m) => m.type === 'control')).toEqual([]);
      socket.close();
      await vi.waitFor(() => expect(f.releases).toEqual(['Guest 1']));
    });
  });

  it('sends nothing for a viewer that left while its first input waited for the control session', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    let open: () => void = () => {};
    f.beginGate = new Promise((resolve) => {
      open = resolve;
    });
    const cookie = await login(url, share.password ?? '');
    const { socket } = await connect(url, { origin: origin(url), cookie });
    const stays = await connect(url, { origin: origin(url), cookie });
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await new Promise((resolve) => setImmediate(resolve));
    socket.close();
    await vi.waitFor(() => expect(f.hub.list()[0]?.viewers).toBe(1));
    open();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.inputs).toEqual([]);
    stays.socket.close();
  });

  describe('on a share without a login', () => {
    it('names a viewer by what it sends, one change per five seconds, and falls back to Guest N', async () => {
      const share = await started(f, { passwordless: true, control: true });
      const url = local(share, f.hub.port ?? 0);
      const headers = { origin: origin(url) };
      const { socket } = await connect(url, headers);
      const other = await connect(url, headers);
      const seen = new Promise<Record<string, unknown>[]>((resolve) => {
        const received: Record<string, unknown>[] = [];
        other.socket.on('message', (data, binary) => {
          if (binary) return;
          received.push(JSON.parse(String(data)));
          if (received.some((m) => m.type === 'presence' && JSON.stringify(m).includes('Zed'))) resolve(received);
        });
      });
      socket.send(JSON.stringify({ type: 'name', name: '  Zed\u202e ' }));
      socket.send(JSON.stringify({ type: 'name', name: 'Too soon' }));
      const received = await seen;
      expect(JSON.stringify(received)).not.toContain('Too soon');
      socket.close();
      other.socket.close();
    });
  });

  describe('names that only the server assigns', () => {
    const seen = (messages: Record<string, unknown>[]) => messages.filter((m) => m.type === 'you').map((m) => m.name);

    it('shows a viewer that logs in as Host, Agent or Guest N under its Guest N, never under that name', async () => {
      const share = await started(f, { control: true });
      const url = local(share, f.hub.port ?? 0);
      const headers = { origin: origin(url) };
      const names: string[] = [];
      for (const chosen of ['host', 'AGENT', 'Agent%20%C2%B7%20tap', 'Guest%207']) {
        const answer = await http(`${url}login`, { method: 'POST', body: `password=${share.password}&name=${chosen}` });
        expect(answer.status).toBe(303);
        const { socket, messages } = await connect(url, {
          ...headers,
          cookie: String(answer.headers['set-cookie']).split(';')[0] ?? '',
        });
        await vi.waitFor(() => expect(seen(messages)).toHaveLength(1));
        names.push(String(seen(messages).at(0)));
        socket.close();
        await vi.waitFor(() => expect(f.hub.list()[0]?.viewers).toBe(0));
      }
      expect(names).toEqual(['Guest 1', 'Guest 1', 'Guest 1', 'Guest 1']);
      const named = await http(`${url}login`, { method: 'POST', body: `password=${share.password}&name=Hostel` });
      const { socket, messages } = await connect(url, {
        ...headers,
        cookie: String(named.headers['set-cookie']).split(';')[0] ?? '',
      });
      await vi.waitFor(() => expect(seen(messages)).toEqual(['Hostel']));
      socket.close();
    });

    it('keeps a viewer that renames itself to one of them under its Guest N', async () => {
      const share = await started(f, { passwordless: true });
      const url = local(share, f.hub.port ?? 0);
      const { socket, messages } = await connect(url, { origin: origin(url) });
      await vi.waitFor(() => expect(seen(messages)).toEqual(['Guest 1']));
      socket.send(JSON.stringify({ type: 'name', name: ' Host ' }));
      await vi.waitFor(() => expect(seen(messages)).toEqual(['Guest 1', 'Guest 1']));
      socket.close();
    });
  });

  describe('with two shares of one device', () => {
    const key = presenceKey(WORKSPACE, 'ios', 'default', false);
    const text = (messages: Record<string, unknown>[]) => JSON.stringify(messages.filter((m) => m.type === 'presence'));

    it("keeps each share's viewers to itself and shows both the host's touches and the agent", async () => {
      const first = await started(f, { passwordless: true, control: true });
      const second = await started(f, { passwordless: true, control: true });
      const join = async (share: StartedShare, name: string) => {
        const url = local(share, f.hub.port ?? 0);
        const client = await connect(url, { origin: origin(url) });
        client.socket.send(JSON.stringify({ type: 'name', name }));
        await vi.waitFor(() => expect(client.messages.filter((m) => m.type === 'you')).toHaveLength(2));
        const you = client.messages.findLast((m) => m.type === 'you');
        return { ...client, who: { id: String(you?.id), kind: 'viewer' as const, name, color: Number(you?.color) } };
      };
      const ann = await join(first, 'Ann');
      const bea = await join(second, 'Bea');
      const bob = await join(second, 'Bob');
      f.presence.touch(key, bea.who, { phase: 'down', x: 0.5, y: 0.5, at: 1 });
      f.presence.agent(key, 'press', 'start');
      f.presence.touch(
        key,
        { id: 'c1', kind: 'host', name: 'Host', color: 0 },
        { phase: 'down', x: 0.1, y: 0.2, at: 2 },
      );
      for (const client of [ann, bea, bob]) {
        await vi.waitFor(() => expect(text(client.messages)).toContain('"kind":"host"'));
        expect(text(client.messages)).toContain('Agent \u00b7 press');
      }
      expect(text(ann.messages)).not.toMatch(/Bea|Bob/);
      expect(text(bob.messages)).toMatch(/Bea/);
      expect(text(bea.messages)).toMatch(/Bob/);
      expect(text(bea.messages)).not.toMatch(/Ann/);
      expect(text(bob.messages)).not.toMatch(/Ann/);
      bea.socket.close();
      await vi.waitFor(() => expect(text(bob.messages)).toMatch(/"name":"Bea","color":\d,"touch":null/));
      expect(text(ann.messages)).not.toMatch(/Bea|Bob/);
      for (const client of [ann, bob]) client.socket.close();
    });
  });

  describe('when many sessions log in', () => {
    const body = (password: string) => ({ method: 'POST', body: `password=${password}` });
    const cookieOf = (answer: { headers: Record<string, string | string[] | undefined> }) =>
      String(answer.headers['set-cookie']).split(';')[0] ?? '';

    it('never drops a control session to make room for a view login, and drops the oldest view one first', async () => {
      f = fixture({ maxViewLogins: 1000 });
      const share = await started(f, { control: true, password: 'control pass', view: { password: 'view pass' } });
      const url = local(share, f.hub.port ?? 0);
      const control = cookieOf(await http(`${url}login`, body('control%20pass')));
      const firstView = cookieOf(await http(`${url}login`, body('view%20pass')));
      const views: string[] = [];
      for (let attempt = 0; attempt < 40; attempt++)
        views.push(cookieOf(await http(`${url}login`, body('view%20pass'))));
      expect((await http(url, { cookie: control })).body).toContain('data-control="true"');
      expect((await http(url, { cookie: firstView })).body).toContain('name="access"');
      expect((await http(url, { cookie: views.at(-1) })).body).toContain('data-view-only="true"');
    });

    it('refuses a view login that would have to drop a control session, and lets a control login drop the oldest one', async () => {
      f = fixture({ maxViewLogins: 1000 });
      const share = await started(f, { control: true, password: 'control pass', view: { password: 'view pass' } });
      const url = local(share, f.hub.port ?? 0);
      const controls: string[] = [];
      for (let attempt = 0; attempt < 32; attempt++)
        controls.push(cookieOf(await http(`${url}login`, body('control%20pass'))));
      const refused = await http(`${url}login`, body('view%20pass'));
      expect(refused.status).toBe(429);
      expect(refused.headers['set-cookie']).toBeUndefined();
      const another = cookieOf(await http(`${url}login`, body('control%20pass')));
      expect((await http(url, { cookie: controls[0] })).body).toContain('name="access"');
      expect((await http(url, { cookie: controls[1] })).body).toContain('data-control="true"');
      expect((await http(url, { cookie: another })).body).toContain('data-control="true"');
    });

    it('limits new view sessions per share and window, and leaves control logins and other shares alone', async () => {
      const share = await started(f, { control: true, password: 'control pass', view: { password: 'view pass' } });
      const other = await started(f, { control: true, password: 'control pass', view: { password: 'view pass' } });
      const url = local(share, f.hub.port ?? 0);
      const control = cookieOf(await http(`${url}login`, body('control%20pass')));
      for (let attempt = 0; attempt < 30; attempt++)
        expect((await http(`${url}login`, body('view%20pass'))).status).toBe(303);
      const limited = await http(`${url}login`, body('view%20pass'));
      expect(limited.status).toBe(429);
      expect(limited.headers['set-cookie']).toBeUndefined();
      expect((await http(`${url}login`, body('control%20pass'))).status).toBe(303);
      expect((await http(url, { cookie: control })).body).toContain('data-control="true"');
      expect((await http(`${local(other, f.hub.port ?? 0)}login`, body('view%20pass'))).status).toBe(303);
    });
  });

  it('gives the viewer a toolbar control for every button the server accepts and for both rotations', () => {
    for (const platform of ['ios', 'android'] as const) {
      const page = viewerPage({
        title: 'Test',
        control: true,
        viewOnly: false,
        upgrade: false,
        platform,
        buttons: BUTTONS[platform],
        rotate: true,
      });
      for (const button of BUTTONS[platform]) expect(page).toContain(`data-button="${button}"`);
      for (const direction of ['left', 'right']) expect(page).toContain(`data-rotate="${direction}"`);
    }
  });

  it("styles the viewer with Stim Desktop's design tokens in light and dark", async () => {
    const share = await started(f);
    const base = new URL(local(share, f.hub.port ?? 0)).origin;
    const css = (await http(`${base}/s/assets/viewer.css`)).body;
    const dark = css.indexOf('prefers-color-scheme: dark');
    const variables = (block: string) =>
      Object.fromEntries([...block.matchAll(/--([a-z-]+): (#[0-9a-f]{6}|rgba?\([^)]*\));/g)].map((m) => [m[1], m[2]]));
    const light = variables(css.slice(0, dark));
    const night = variables(css.slice(dark, css.indexOf('}\n}', dark)));
    const names = {
      bg: 'background',
      canvas: 'grouped',
      card: 'surface',
      raised: 'raised',
      line: 'border',
      fg: 'text',
      muted: 'secondary',
      tertiary: 'tertiary',
      accent: 'primary',
      control: 'accent',
      'on-accent': 'onPrimary',
      live: 'success',
      danger: 'error',
    } as const;
    const source = readFileSync(new URL('../../../apps/mobile/src/design/tokens.ts', import.meta.url), 'utf8');
    const tokens = (opening: string): Record<string, string> => {
      const block = source.slice(source.indexOf(opening)).split('\n}')[0] ?? '';
      return Object.fromEntries([...block.matchAll(/^\s+(\w+): '([^']+)'/gm)].map((m) => [m[1] ?? '', m[2] ?? '']));
    };
    const pick = (values: Record<string, string>) =>
      Object.fromEntries(Object.keys(names).map((key) => [key, values[key]]));
    const expected = (palette: Record<string, string>) =>
      Object.fromEntries(Object.entries(names).map(([key, token]) => [key, (palette[token] ?? '').toLowerCase()]));
    expect(pick(light)).toEqual(expected(tokens('const light = {')));
    expect(pick(night)).toEqual(expected(tokens('const dark: Record<ColorToken, string> = {')));
    expect(light.screen).toBe((tokens('export const media = {').screen ?? '').toLowerCase());
    expect(light.note).toBe(tokens('export const media = {').note);
  });

  it('serves its stylesheet and scripts without a token, and nothing else under that path', async () => {
    const share = await started(f);
    const base = new URL(local(share, f.hub.port ?? 0)).origin;
    const script = await http(`${base}/s/assets/viewer.js`);
    expect(script.status).toBe(200);
    expect(String(script.headers['content-type'])).toContain('javascript');
    expect((await http(`${base}/s/assets/viewer.css`)).status).toBe(200);
    expect((await http(`${base}/s/assets/gestures.js`)).status).toBe(200);
    expect((await http(`${base}/s/assets/secret.js`)).status).toBe(404);
    expect((await http(`${base}/s/assets/viewer.js`, { method: 'POST', body: 'x=1' })).status).toBe(404);
  });

  it('tells a viewer when the share expires and sends the device artwork as image data', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port ?? 0);
    const messages: Record<string, unknown>[] = [];
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}ws`, {
      headers: { origin: origin(url), cookie: await login(url, share.password ?? '') },
    });
    socket.on('message', (data, binary) => {
      if (!binary) messages.push(JSON.parse(String(data)));
    });
    await vi.waitFor(() => expect(f.subscribed).toHaveLength(1));
    f.subscribed[0]?.listener.artwork?.({
      width: 10,
      height: 20,
      aperture: { x: 1, y: 1, width: 8, height: 18 },
      cornerRadius: 2,
      quarterTurns: 0,
      background: 'Qkc=',
      foreground: 'Rkc=',
    });
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[0]).toEqual({
      type: 'hello',
      expiresAt: share.expiresAt,
      title: 'Live iOS app \u00b7 iPhone 17 \u00b7 Stim',
    });
    expect(messages[1]).toMatchObject({ type: 'you', name: 'Guest 1', access: 'view' });
    expect(messages[2]).toMatchObject({
      type: 'artwork',
      artwork: {
        aperture: { width: 8 },
        background: 'data:image/png;base64,Qkc=',
        foreground: 'data:image/png;base64,Rkc=',
      },
    });
    socket.close();
  });

  it('with --control, rotates the shared device in the two directions only', async () => {
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password ?? '') });
    socket.send(JSON.stringify({ type: 'rotate', direction: 'up' }));
    socket.send(JSON.stringify({ type: 'rotate', direction: 'left' }));
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.inputs).toEqual([{ session: 'c1', command: { input: 'rotate', direction: 'left' } }]);
    socket.close();
  });

  it('keeps no recording exemption for a device whose control another client holds', async () => {
    f.refuseControl = true;
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port ?? 0);
    const { socket, messages } = await connect(url, {
      origin: origin(url),
      cookie: await login(url, share.password ?? ''),
    });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'control' })));
    const told = messages.find((message) => message.type === 'control');
    expect(told?.message).not.toContain('Desktop');
    expect(f.inputs).toEqual([]);
    expect(f.hub.unrecordedTargets()).toEqual(new Set());
    socket.close();
  });

  it('never exempts from recording a device something else already drives', async () => {
    f.refuseControl = true;
    const share = await started(f, { control: true });
    f.status(payload('Booted', { state: 'driven', driver: { tool: 'agent-device' }, basis: ['agent-device-lease'] }));
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    expect(f.exemptAtBegin).toEqual([[]]);
    socket.close();
  });

  it('ends when stopped: closes viewers, stops capture and removes the route with the last share', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port ?? 0);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    expect((await f.hub.stop(WORKSPACE)).map((row) => row.id)).toHaveLength(1);
    await closed;
    expect(f.subscribed[0]!.unsubscribed).toBe(true);
    expect(f.routeCloses).toBe(1);
    expect(f.listenerBoundAtRouteClose).toEqual([true]);
    expect(f.hub.port).toBeNull();
    expect(f.hub.list()).toEqual([]);
  });

  it('stops only the share with the given id, in its own workspace, and leaves the others live', async () => {
    const first = await started(f);
    const second = await started(f, { control: true });
    expect(await f.hub.stopOne('/work/other', first.id)).toBeNull();
    expect(await f.hub.stopOne(WORKSPACE, 'w99')).toBeNull();
    expect(f.hub.list()).toHaveLength(2);
    expect((await f.hub.stopOne(WORKSPACE, first.id))?.id).toBe(first.id);
    expect(f.hub.list().map((row) => row.id)).toEqual([second.id]);
    expect(f.routeCloses).toBe(0);
    expect((await f.hub.stop(WORKSPACE)).map((row) => row.id)).toEqual([second.id]);
    expect(f.routeCloses).toBe(1);
  });

  describe('with a slug', () => {
    it('serves the share at /s/<slug>/ behind its password and lists the slug', async () => {
      const share = await started(f, { slug: 'pokedex' });
      expect(share.url).toBe('https://mac.tail.ts.net:10000/s/pokedex/');
      expect(share).toMatchObject({ auth: 'generated', slug: 'pokedex' });
      expect(f.hub.list()).toMatchObject([{ slug: 'pokedex' }]);
      const url = local(share, f.hub.port ?? 0);
      const page = await http(url);
      expect(page.body).toContain('name="access"');
      expect(page.body).not.toContain('id="screen"');
      expect((await connect(url, { origin: origin(url) })).status).toBe(401);
      expect((await http(`${url}login`, { method: 'POST', body: 'password=wrong' })).status).toBe(401);
      const cookie = await login(url, share.password ?? '');
      const { socket, status } = await connect(url, { origin: origin(url), cookie });
      expect(status).toBeNull();
      socket.close();
    });

    it('refuses a slug without a password', async () => {
      expect(await f.hub.start(shareRequest({ slug: 'pokedex', passwordless: true }))).toMatchObject({
        code: 'bad-request',
      });
      expect(f.hub.list()).toEqual([]);
    });

    it('refuses a slug a live share holds, naming it, and frees it when that share ends', async () => {
      const first = await started(f, { slug: 'pokedex' });
      const firstUrl = local(first, f.hub.port ?? 0);
      const oldCookie = await login(firstUrl, first.password ?? '');
      const refused = await f.hub.start(shareRequest({ slug: 'pokedex', control: true }));
      expect(refused).toMatchObject({ code: 'action-failed' });
      expect('message' in refused && refused.message).toContain(first.id);
      expect(f.hub.list().map((row) => row.id)).toEqual([first.id]);
      await f.hub.stop(WORKSPACE);
      const second = await started(f, { slug: 'pokedex' });
      expect(second.url).toBe(first.url);
      const url = local(second, f.hub.port ?? 0);
      expect((await http(url, { cookie: oldCookie })).body).toContain('name="access"');
      expect((await connect(url, { origin: origin(url), cookie: oldCookie })).status).toBe(401);
    });

    it('gives a slug to only one of two shares that start at once', async () => {
      const results = await Promise.all([
        f.hub.start(shareRequest({ slug: 'pokedex' })),
        f.hub.start(shareRequest({ slug: 'pokedex' })),
      ]);
      expect(results.filter((result) => 'url' in result)).toHaveLength(1);
      expect(results.filter((result) => 'code' in result)).toMatchObject([{ code: 'action-failed' }]);
      expect(f.hub.list()).toHaveLength(1);
    });
  });

  it('keeps the port a route that failed to be removed still points at bound until a later route replaces it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await started(f);
    const first = f.hub.port!;
    f.failRoute.close = true;
    await f.hub.stop(WORKSPACE);
    expect(await bound(first)).toBe(true);

    f.failRoute = { open: true, close: false };
    expect(await f.hub.start(shareRequest())).toMatchObject({ code: 'action-failed' });
    expect(await bound(first)).toBe(true);

    f.failRoute.open = false;
    await started(f);
    expect(await bound(first)).toBe(false);
  });

  it('reports idle once its last share ended and its route is gone, and after a start it refused', async () => {
    await started(f);
    await started(f, { control: true });
    await f.hub.stop(WORKSPACE);
    await vi.waitFor(() => expect(f.idle).toBe(1));
    expect(f.routeCloses).toBe(1);

    expect(await f.hub.start(shareRequest({ platform: 'android' }))).toMatchObject({ code: 'action-failed' });
    await vi.waitFor(() => expect(f.idle).toBe(2));
  });

  it('is not idle while a share is starting, nor while a route it could not remove is public', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = f.hub.start(shareRequest());
    expect(f.hub.isIdle()).toBe(false);
    await pending;

    f.failRoute.close = true;
    await f.hub.stop(WORKSPACE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.hub.isIdle()).toBe(false);
    expect(f.idle).toBe(0);

    vi.advanceTimersByTime(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.idle).toBe(0);

    f.failRoute.close = false;
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(f.idle).toBe(1));
    expect(f.strandedPort).toBeNull();
  });

  it('ends at its expiry', async () => {
    await started(f, { expiresMinutes: 1 });
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(f.routeCloses).toBe(1));
    expect(f.hub.list()).toEqual([]);
  });

  describe('when its device goes away', () => {
    const signedIn = async (overrides: Partial<ShareRequest> = {}) => {
      const share = await started(f, overrides);
      const url = local(share, f.hub.port ?? 0);
      const cookie = await login(url, share.password!);
      const viewer = await connect(url, { origin: origin(url), cookie });
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(1));
      return { share, url, cookie, ...viewer };
    };
    const frames = (socket: WebSocket) => {
      const received: Buffer[] = [];
      socket.on('message', (data, binary) => {
        if (binary) received.push(data as Buffer);
      });
      return received;
    };
    const frame = { width: 1, height: 1, capturedAt: '', data: JPEG.toString('base64') };

    it('waits instead of ending: viewers stay connected and signed in, capture stops and control is released', async () => {
      const { share, url, cookie, socket, messages } = await signedIn({ control: true });
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
      await vi.waitFor(() => expect(f.begins).toHaveLength(1));
      const expiresAt = f.hub.list()[0]?.expiresAt;

      f.status(payload('Shutdown'));

      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('stopped'));
      expect(stateOf(f)).toBe('waiting');
      expect(f.hub.list()).toEqual([expect.objectContaining({ id: share.id, expiresAt, viewers: 1 })]);
      expect(socket.readyState).toBe(socket.OPEN);
      expect(f.subscribed[0]!.unsubscribed).toBe(true);
      expect(f.endFors).toHaveLength(1);
      expect(f.routeCloses).toBe(0);
      expect(f.hub.port).not.toBeNull();
      expect((await http(url, { cookie })).status).toBe(200);
      expect((await http(`${url}login`, { method: 'POST', body: `password=${share.password}` })).status).toBe(303);
      socket.close();
    });

    it('resumes on the same page when the device is back: frames flow again, with no new login and a fresh control session', async () => {
      const { cookie, url, socket, messages } = await signedIn({ control: true });
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
      await vi.waitFor(() => expect(f.begins).toHaveLength(1));
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      const received = frames(socket);

      f.status(payload('Booted'));

      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('resumed'));
      expect(stateOf(f)).toBe('live');
      expect(f.subscribed).toHaveLength(2);
      f.subscribed[1]!.listener.frame(frame);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(Buffer.compare(received[0]!, JPEG)).toBe(0);
      expect((await http(url, { cookie })).body).toContain('data-control="true"');
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
      await vi.waitFor(() => expect(f.begins).toHaveLength(2));
      socket.close();
    });

    it('does not lock control or tell the viewer it is refused when the device changed while control was starting', async () => {
      let release = () => {};
      f.beginGate = new Promise<void>((resolve) => (release = resolve));
      const { socket, messages } = await signedIn({ control: true });
      await vi.waitFor(() => expect(f.beginCalls).toBe(1));
      const other = payload('Booted');
      other.environments[0]!.ios.udid = 'SIM-2';
      f.status(other);
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(2));
      f.beginGate = null;
      release();
      await vi.advanceTimersByTimeAsync(20);

      await vi.waitFor(() => expect(f.begins).toHaveLength(1));
      expect(messages.map((message) => message.type)).not.toContain('control');
      socket.close();
    });

    it('ends only the control session a stale begin started, not the one the share started on the new source', async () => {
      let release = () => {};
      f.startGate = new Promise<void>((resolve) => (release = resolve));
      const { socket } = await signedIn({ control: true });
      await vi.waitFor(() => expect(f.begins).toHaveLength(1));
      f.startGate = null;
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(f.startedSessions).toEqual(['c2']));
      await vi.advanceTimersByTimeAsync(20);
      expect(f.endedSessions).toEqual([]);

      release();
      await vi.advanceTimersByTimeAsync(20);

      expect(f.startedSessions).toEqual(['c2', 'c1']);
      expect(f.endedSessions).toEqual(['c1']);
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
      await vi.waitFor(() => expect(f.inputs).toEqual([expect.objectContaining({ session: 'c2' })]));
      socket.close();
    });

    it('tells a viewer the share resumed before the frame the new source replays at once', async () => {
      const { socket } = await signedIn();
      const order: string[] = [];
      socket.on('message', (data, binary) => order.push(binary ? 'frame' : String(JSON.parse(String(data)).type)));
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      f.replay = frame;
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(order).toContain('frame'));
      expect(order.slice(order.indexOf('resumed'))).toEqual(['resumed', 'frame']);
      socket.close();
    });

    it('starts control again after a resume even while the control that was starting before is still pending', async () => {
      let release = () => {};
      f.beginGate = new Promise<void>((resolve) => (release = resolve));
      const { socket } = await signedIn({ control: true });
      await vi.waitFor(() => expect(f.beginCalls).toBe(1));
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(2));
      await vi.waitFor(() => expect(f.beginCalls).toBe(2));
      f.beginGate = null;
      release();
      await vi.advanceTimersByTimeAsync(20);
      expect(f.begins).toHaveLength(1);
      socket.close();
    });

    it('refuses input while it waits and does not begin another control session', async () => {
      const { socket } = await signedIn({ control: true });
      await vi.waitFor(() => expect(f.begins).toHaveLength(1));
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
      await vi.advanceTimersByTimeAsync(50);
      expect(f.beginCalls).toBe(1);
      expect(f.inputs).toEqual([]);
      socket.close();
    });

    it('lets a viewer join a waiting share and feeds it when the device is back', async () => {
      const share = await started(f);
      const url = local(share, f.hub.port ?? 0);
      const cookie = await login(url, share.password!);
      f.status(payload('Shutdown'));

      const { socket, messages } = await connect(url, { origin: origin(url), cookie });
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('stopped'));
      expect(f.subscribed).toEqual([]);
      const received = frames(socket);
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(1));
      f.subscribed[0]!.listener.frame(frame);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      socket.close();
    });

    it('waits when its frames fail, and looks for the device again until the stream is back', async () => {
      const { socket, messages } = await signedIn();
      f.subscribed[0]!.listener.failed?.('the frame helper stopped');
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      expect(messages.map((message) => message.type)).toContain('stopped');

      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => expect(stateOf(f)).toBe('live'));
      expect(f.subscribed).toHaveLength(2);

      f.subscribed[1]!.listener.failed?.('the frame helper stopped again');
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      vi.advanceTimersByTime(2000);
      expect(stateOf(f)).toBe('waiting');
      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => expect(stateOf(f)).toBe('live'));
      socket.close();
    });

    it('ignores a failure its old source reports after the share resumed', async () => {
      const { socket } = await signedIn();
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(2));
      await vi.waitFor(() => expect(stateOf(f)).toBe('live'));
      f.subscribed[0]!.listener.failed?.('late');
      await vi.advanceTimersByTimeAsync(20);
      for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
      expect(viewerPhases).toEqual(['waiting', 'live']);
      socket.close();
    });

    /**
     * Moves the clock in 31 s steps. Each step passes one 30 s ping of the share's socket, and the client's pong
     * crosses a real connection, so the pong is awaited before the next step; otherwise the next ping would find
     * the socket unanswered and terminate it.
     */
    const stepLive = async (socket: WebSocket, ms: number) => {
      const ping = { heard: false };
      const heard = () => (ping.heard = true);
      socket.on('ping', heard);
      await vi.advanceTimersByTimeAsync(ms);
      for (let turn = 0; turn < 200 && !ping.heard && socket.readyState === socket.OPEN; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      socket.off('ping', heard);
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    };

    const failUntilEnded = async (socket: WebSocket, message: string) => {
      f.subscribed[0]?.listener.failed?.(message);
      for (let round = 0; round < 20 && f.hub.list().length; round++) {
        await stepLive(socket, 31_000);
        f.subscribed.at(-1)?.listener.failed?.(message);
        await vi.advanceTimersByTimeAsync(1);
      }
    };

    it('ends a share whose device is there but cannot stream, and tells viewers a reason that names nothing private', async () => {
      const { socket, messages } = await signedIn();
      await failUntilEnded(socket, 'xcrun simctl io /Users/someone/secret-project/ios failed (code 1)');
      expect(f.hub.list()).toEqual([]);
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('ended'));
      const ended = messages.find((message) => message.type === 'ended');
      expect(ended).toEqual({ type: 'ended', message: 'This share has ended: its device could not stream.' });
      expect(messages.map((message) => message.type).filter((type) => type === 'stopped').length).toBeGreaterThan(2);
      expect(f.gaveUp).toEqual([expect.objectContaining({ workspace: WORKSPACE, platform: 'ios' })]);
      expect(f.routeCloses).toBe(1);
      socket.close();
    });

    it("holds the share's link until its saved link is marked stopped, and tells viewers at once", async () => {
      const LINK = 'L'.repeat(43);
      let release = () => {};
      f.gaveUpGate = new Promise<void>((resolve) => (release = resolve));
      const { socket, messages } = await signedIn({ token: LINK });
      await failUntilEnded(socket, 'xcrun simctl io failed (code 1)');
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('ended'));
      expect(f.gaveUp).toHaveLength(1);
      expect(f.gaveUpLinks).toEqual([digest(LINK).toString('hex')]);

      expect(f.hub.list()).toEqual([]);
      expect(f.hub.isIdle()).toBe(false);
      expect(f.routeCloses).toBe(0);
      expect(f.idle).toBe(0);
      expect(await f.hub.start(shareRequest({ token: LINK }))).toMatchObject({
        code: 'bad-request',
        message: 'That link is live now.',
      });

      release();
      await vi.waitFor(() => expect(f.routeCloses).toBe(1));
      await vi.waitFor(() => expect(f.idle).toBe(1));
      expect(f.gaveUp).toHaveLength(1);
      socket.close();
    });

    it('reports idle after the last mark settles, also when another share ended and closed the listener during the wait', async () => {
      let release = () => {};
      f.gaveUpGate = new Promise<void>((resolve) => (release = resolve));
      const { socket } = await signedIn();
      const other = await started(f);
      f.subscribed[0]?.listener.failed?.('xcrun simctl io failed (code 1)');
      for (let round = 0; round < 20 && f.gaveUp.length === 0; round++) {
        await stepLive(socket, 31_000);
        f.subscribed.at(-1)?.listener.failed?.('xcrun simctl io failed (code 1)');
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(f.gaveUp).toHaveLength(1);

      await f.hub.stopOne(WORKSPACE, other.id);
      await vi.waitFor(() => expect(f.routeCloses).toBe(1));
      await vi.advanceTimersByTimeAsync(10);
      expect(f.idle).toBe(0);

      release();
      await vi.waitFor(() => expect(f.idle).toBe(1));
      socket.close();
    });

    it('still ends the share, once, when marking its saved link fails or the share is stopped meanwhile', async () => {
      let release = () => {};
      f.gaveUpGate = new Promise<void>((resolve) => (release = resolve));
      f.gaveUpFails = true;
      const { socket, messages } = await signedIn();
      await failUntilEnded(socket, 'xcrun simctl io failed (code 1)');
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('ended'));
      await f.hub.stop(WORKSPACE);
      release();
      await vi.waitFor(() => expect(f.routeCloses).toBe(1));
      await vi.advanceTimersByTimeAsync(10);
      expect(f.routeCloses).toBe(1);
      expect(f.hub.list()).toEqual([]);
      expect(messages.filter((message) => message.type === 'ended')).toHaveLength(1);
      socket.close();
    });

    it('names the missing frame helper to viewers when that is why the device cannot stream', async () => {
      const { socket, messages } = await signedIn();
      await failUntilEnded(
        socket,
        'This app or physical device streams through the stim-frames helper, which this Mac has not built.',
      );
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('ended'));
      expect(messages.find((message) => message.type === 'ended')).toMatchObject({
        message: expect.stringContaining('a helper that this Mac has not built'),
      });
      socket.close();
    });

    it('does not end a share whose device is away for longer than that: it is only stopped until the device is back', async () => {
      const { socket } = await signedIn();
      f.subscribed[0]?.listener.failed?.('the frame helper stopped');
      await vi.advanceTimersByTimeAsync(10);
      f.status(payload('Shutdown'));
      for (let minute = 0; minute < 40; minute++) await stepLive(socket, 30_000);
      expect(f.hub.list()).toEqual([expect.objectContaining({ viewers: 1 })]);
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(2));
      f.subscribed[1]?.listener.failed?.('the frame helper stopped');
      await vi.advanceTimersByTimeAsync(10);
      expect(f.hub.list()).toHaveLength(1);
      socket.close();
    });

    it('counts the failing stretch per device: a device that replaces a failing one during the wait starts with a clean clock', async () => {
      const { socket } = await signedIn();
      f.subscribed[0]?.listener.failed?.('the frame helper stopped');
      for (let round = 0; round < 9; round++) {
        await stepLive(socket, 31_000);
        f.subscribed.at(-1)?.listener.failed?.('the frame helper stopped');
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(f.hub.list()).toHaveLength(1);

      const other = payload('Booted');
      const environment = other.environments[0];
      if (environment) environment.ios.udid = 'SIM-2';
      f.status(other);
      await stepLive(socket, 31_000);
      expect(f.subscribed.at(-1)?.device).toMatchObject({ udid: 'SIM-2' });
      f.subscribed.at(-1)?.listener.failed?.('the frame helper stopped');
      await vi.advanceTimersByTimeAsync(10);
      expect(f.hub.list()).toHaveLength(1);
      expect(f.gaveUp).toEqual([]);
      socket.close();
    });

    it('does not count a failing stretch nobody watched: a viewer that joins hours later and sees one short failure keeps the share', async () => {
      const { url, cookie, socket } = await signedIn();
      f.subscribed[0]?.listener.failed?.('the frame helper stopped');
      socket.close();
      await vi.waitFor(() => expect(f.hub.list()[0]?.viewers).toBe(0));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(f.hub.list()).toHaveLength(1);

      const joined = await connect(url, { origin: origin(url), cookie });
      await vi.waitFor(() => expect(f.subscribed.length).toBeGreaterThan(1));
      f.subscribed.at(-1)?.listener.failed?.('the capture closed for an install');
      await vi.advanceTimersByTimeAsync(10);
      expect(f.hub.list()).toHaveLength(1);
      joined.socket.close();
    });

    it('follows its slot to another simulator, without a new login', async () => {
      const { socket, messages } = await signedIn();
      const other = payload('Booted');
      other.environments[0]!.ios.udid = 'SIM-2';
      f.status(other);
      await vi.waitFor(() => expect(f.subscribed).toHaveLength(2));
      expect(f.subscribed[1]!.device).toMatchObject({ udid: 'SIM-2' });
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('resumed'));
      expect(messages.map((message) => message.type)).toContain('stopped');
      socket.close();
    });

    it('keeps its expiry while it waits, and ends when that comes', async () => {
      const { socket, messages } = await signedIn({ expiresMinutes: 1 });
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('stopped'));
      expect(f.hub.list()).toHaveLength(1);
      vi.advanceTimersByTime(60_000);
      await vi.waitFor(() => expect(f.hub.list()).toEqual([]));
      expect(f.routeCloses).toBe(1);
      socket.close();
    });

    it('is ended by an explicit stop, and is not idle while it waits', async () => {
      const { share, socket, messages } = await signedIn();
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('stopped'));
      expect(f.hub.isIdle()).toBe(false);
      expect(await f.hub.stopOne(WORKSPACE, share.id)).toMatchObject({ id: share.id });
      socket.close();
      expect(f.gaveUp).toEqual([]);
      expect(f.hub.list()).toEqual([]);
      expect(f.routeCloses).toBe(1);
      f.status(payload('Booted'));
      expect(f.hub.list()).toEqual([]);
    });

    it('releases the recording exemption it held for control when it starts waiting', async () => {
      const { socket, messages } = await signedIn({ control: true });
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
      await vi.waitFor(() => expect(f.begins).toHaveLength(1));
      expect(f.hub.unrecordedTargets().size).toBe(1);
      f.status(payload('Shutdown'));
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('stopped'));
      vi.advanceTimersByTime(2 * 60_000);
      expect(f.hub.unrecordedTargets().size).toBe(0);
      socket.close();
    });
  });

  describe('started again under the link of a share that was stopped', () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

    it('serves the same link and password to a viewer, until the exact expiry it was given', async () => {
      const expiresAt = Date.now() + 25 * 60_000;
      const again = shareRequest({ token: TOKEN, expiresAt, password: 'saved-password', expiresMinutes: 25 });
      const first = await started(f, again);
      expect(first.url.endsWith(`/s/${TOKEN}/`)).toBe(true);
      expect(first.expiresAt).toBe(new Date(expiresAt).toISOString());
      const url = local(first, f.hub.port ?? 0);
      expect((await http(url)).body).toContain('name="access"');
      expect(await login(url, 'saved-password')).toContain('stim_share=');

      await f.hub.stop(WORKSPACE);
      const second = await started(f, again);
      expect(second.url).toBe(first.url);
      const restarted = local(second, f.hub.port ?? 0);
      expect((await http(`${restarted}login`, { method: 'POST', body: 'password=wrong-password' })).status).toBe(401);
      expect(await login(restarted, 'saved-password')).toContain('stim_share=');
      expect(f.hub.list()[0]?.expiresAt).toBe(new Date(expiresAt).toISOString());

      vi.advanceTimersByTime(25 * 60_000);
      await vi.waitFor(() => expect(f.hub.list()).toEqual([]));
    });

    it('refuses a link that is live or waiting now, and one whose expiry has passed, without opening a listener', async () => {
      const again = shareRequest({ token: TOKEN, expiresAt: Date.now() + 60_000, expiresMinutes: 1 });
      await started(f, again);
      f.status(payload('Shutdown'));
      expect(await f.hub.start(again)).toMatchObject({ code: 'bad-request', message: 'That link is live now.' });
      await f.hub.stop(WORKSPACE);
      expect(f.routeCloses).toBe(1);
      const opens = f.routeOpens.length;
      expect(await f.hub.start({ ...again, expiresAt: Date.now() - 1 })).toMatchObject({
        code: 'bad-request',
        message: 'That link has expired.',
      });
      expect(f.routeOpens).toHaveLength(opens);
    });

    it('replaces the share a restore started when its link is started again, with the new expiry and the saved password', async () => {
      const saved = shareRequest({ token: TOKEN, password: 'saved-password', expiresAt: Date.now() + 60_000 });
      const restored = await f.hub.start(saved, { restore: true });
      if ('code' in restored) throw new Error(restored.message);
      const { expiresAt: _expires, ...rest } = saved;
      const again = await f.hub.start({ ...rest, expiresMinutes: 30 });
      if ('code' in again) throw new Error(again.message);
      expect(again.id).not.toBe(restored.id);
      expect(again.url).toBe(restored.url);
      expect(f.hub.list().map((row) => row.id)).toEqual([again.id]);
      expect(Date.parse(again.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
      expect(await login(local(again, f.hub.port ?? 0), 'saved-password')).toContain('stim_share=');
      expect(await f.hub.start({ ...rest, expiresMinutes: 30 })).toMatchObject({
        code: 'bad-request',
        message: 'That link is live now.',
      });
    });

    it('ends the shares a restore started for a target once a new share of it replaced them', async () => {
      const restored = await f.hub.start(shareRequest({ token: TOKEN }), { restore: true });
      if ('code' in restored) throw new Error(restored.message);
      const fresh = await started(f);
      expect(f.hub.list()).toHaveLength(2);
      await f.hub.endReplaced(shareRequest(), fresh.id);
      expect(f.hub.list().map((row) => row.id)).toEqual([fresh.id]);
    });

    it('starts a restored share waiting when its device is not there, and feeds the same link once it is', async () => {
      f.status(payload('Shutdown'));
      expect(await f.hub.start(shareRequest({ token: TOKEN }))).toMatchObject({ code: 'action-failed' });
      const restored = await f.hub.start(shareRequest({ token: TOKEN }), { restore: true });
      if ('code' in restored) throw new Error(restored.message);
      expect(restored.url).toContain(TOKEN);
      expect(f.hub.list()).toHaveLength(1);
      const url = local(restored, f.hub.port ?? 0);
      const cookie = await login(url, restored.password ?? '');
      const { socket, messages } = await connect(url, { origin: origin(url), cookie });
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('stopped'));
      expect(f.subscribed).toEqual([]);
      f.status(payload('Booted'));
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('resumed'));
      expect(f.subscribed).toHaveLength(1);
      expect(f.hub.list()).toHaveLength(1);
      socket.close();
    });

    it('does not keep the token it was given: it appears in no row', async () => {
      await started(f, shareRequest({ token: TOKEN }));
      expect(JSON.stringify(f.hub.list())).not.toContain(TOKEN);
    });
  });

  it('stops only the shares of one slot when asked', async () => {
    const other = payload();
    (other.environments[0] as Record<string, unknown>).slots = [
      { slot: 'beta', ios: { udid: 'SIM-3', owned: true, state: 'Booted', name: 'stim-beta (iPhone 17)' } },
    ];
    f.status(other as never);
    await started(f);
    const beta = await started(f, { slot: 'beta' });
    const stopped = await f.hub.stop(WORKSPACE, undefined, 'beta');
    expect(stopped.map((row) => row.id)).toEqual([beta.id]);
    expect(f.hub.list().map((row) => row.slot)).toEqual(['default']);
    expect(await f.hub.stop(WORKSPACE, undefined, 'default')).toHaveLength(1);
  });

  it('offers rotation on a local simulator, and not on a physical device', async () => {
    const page = async (overrides: Partial<ShareRequest>) => {
      const share = await started(f, overrides);
      const url = local(share, f.hub.port ?? 0);
      return (await http(url, { cookie: await login(url, share.password ?? '') })).body;
    };
    expect(await page({})).toContain('data-can-rotate="true"');
    f.status({
      environments: [{ path: WORKSPACE }],
      deviceLeases: [
        {
          holder: WORKSPACE,
          platform: 'android',
          id: 'PHONE-1',
          expired: false,
          expiresAt: new Date(Date.now() + 1e6).toISOString(),
        },
      ],
    } as never);
    expect(await page({ platform: 'android', physical: true })).toContain('data-can-rotate="false"');
  });

  it('refuses a device the workspace does not own and control of a physical iPhone', async () => {
    expect(await f.hub.start(shareRequest({ platform: 'android' }))).toMatchObject({ code: 'action-failed' });
    expect(await f.hub.start(shareRequest({ physical: true, control: true }))).toMatchObject({ code: 'bad-request' });
    expect(f.routeOpens).toEqual([]);
  });

  describe('of a device a host Mac runs', () => {
    const hostedPayload = (session = 'sess-1', ready = true) => ({
      environments: [
        {
          path: WORKSPACE,
          ios: {
            owned: false,
            state: 'Shutdown',
            host: { machine: 'mini', session, device: ready ? { name: 'iPhone', runtime: '27' } : null },
          },
        },
      ],
    });

    it('streams and drives through the hosted source, never the local frame pool or control hub', async () => {
      f.status(hostedPayload() as never);
      const share = await started(f, { control: true });
      const url = local(share, f.hub.port ?? 0);
      expect(f.hostedSources[0]!.subscribed).toEqual([]);
      const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
      expect(f.subscribed).toEqual([]);
      const record = f.hostedSources[0]!;
      expect(record.subscribed).toHaveLength(1);
      const frame = new Promise<Buffer>((resolve) =>
        socket.on('message', (data, binary) => {
          if (binary) resolve(data as Buffer);
        }),
      );
      record.subscribed[0]!.frame({ width: 1, height: 1, capturedAt: '', data: JPEG.toString('base64') });
      expect(Buffer.compare(await frame, JPEG)).toBe(0);
      socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.25, y: 0.75 }));
      await vi.waitFor(() => expect(record.inputs).toHaveLength(1));
      expect(record.inputs).toEqual([
        { session: 'h1', method: 'input.touch', params: { phase: 'down', x: 0.25, y: 0.75 } },
      ]);
      socket.send(JSON.stringify({ type: 'touch', phase: 'move', x: 0.25, y: 0.75, x2: 0.5, y2: 0.25 }));
      await vi.waitFor(() => expect(record.inputs).toHaveLength(2));
      expect(record.inputs[1]).toEqual({
        session: 'h1',
        method: 'input.touch',
        params: { phase: 'move', x: 0.25, y: 0.75, x2: 0.5, y2: 0.25 },
      });
      expect(f.begins).toEqual([]);
      expect(f.inputs).toEqual([]);
      expect(f.hub.unrecordedTargets()).toEqual(new Set());
      socket.close();
      await vi.waitFor(() => expect(record.unsubscribed).toBe(1));
    });

    it('offers rotation on a hosted simulator, and not on a hosted emulator, which the host refuses', async () => {
      const page = async (platform: 'ios' | 'android') => {
        f.status({
          environments: [
            { path: WORKSPACE, [platform]: { owned: false, host: { machine: 'mini', session: 's', device: {} } } },
          ],
        } as never);
        const share = await started(f, { platform });
        const url = local(share, f.hub.port ?? 0);
        return (await http(url, { cookie: await login(url, share.password ?? '') })).body;
      };
      expect(await page('ios')).toContain('data-can-rotate="true"');
      expect(await page('android')).toContain('data-can-rotate="false"');
    });

    it('refuses to start on a session that is not ready, and waits when its session is replaced or gone', async () => {
      f.status(hostedPayload('sess-1', false) as never);
      expect(await f.hub.start(shareRequest())).toMatchObject({
        code: 'action-failed',
        message: expect.stringContaining('not ready yet'),
      });
      f.status(hostedPayload() as never);
      await started(f);
      f.status(hostedPayload('sess-2', false) as never);
      expect(f.hostedSources[0]!.closed).toBe(1);
      f.status(hostedPayload('sess-2') as never);
      await vi.waitFor(() => expect(f.hostedSources).toHaveLength(2));

      f.status(payload('Shutdown'));
      expect(f.hostedSources[1]!.closed).toBe(1);
    });

    it('waits when the host stream fails, as when an install closes the capture, and resumes on the same session', async () => {
      f.status(hostedPayload() as never);
      const share = await started(f);
      const url = local(share, f.hub.port ?? 0);
      const cookie = await login(url, share.password!);
      const { socket, messages } = await connect(url, { origin: origin(url), cookie });
      await vi.waitFor(() => expect(f.hostedSources[0]!.subscribed).toHaveLength(1));
      f.hostedSources[0]!.subscribed[0]!.failed?.('mini: The hosted capture session ended.');
      await vi.waitFor(() => expect(stateOf(f)).toBe('waiting'));
      expect(messages.map((message) => message.type)).toContain('stopped');
      expect(f.hostedSources[0]!.closed).toBe(1);

      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => expect(f.hostedSources).toHaveLength(2));
      await vi.waitFor(() => expect(f.hostedSources[1]!.subscribed).toHaveLength(1));
      await vi.waitFor(() => expect(messages.map((message) => message.type)).toContain('resumed'));
      expect((await http(url, { cookie })).status).toBe(200);
      socket.close();
    });
  });
});

describe("a web share starting while the workspace's devices may be shut down", () => {
  function claim() {
    const events: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let refusal: { code: 'action-failed'; message: string } | null = null;
    const holdWorkspace: ShareDeps['holdWorkspace'] = async (workspace) => {
      events.push(`hold ${workspace}`);
      await gate;
      if (refusal) return refusal;
      return { release: () => events.push('release') };
    };
    return {
      events,
      open,
      holdWorkspace,
      refuse: (message: string) => {
        refusal = { code: 'action-failed', message };
      },
    };
  }

  it('reads the device only after a shutdown that held the claim has finished', async () => {
    const held = claim();
    const f = fixture({}, { holdWorkspace: held.holdWorkspace });
    const starting = f.hub.start(shareRequest());
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.hub.list()).toEqual([]);
    f.status(payload('Shutdown'));
    held.open();
    expect(await starting).toMatchObject({ code: 'action-failed' });
    expect(f.hub.list()).toEqual([]);
    expect(f.routeOpens).toEqual([]);
    expect(held.events).toEqual([`hold ${WORKSPACE}`, 'release']);
  });

  it('counts every start as in flight until it answers', async () => {
    const held = claim();
    const f = fixture({}, { holdWorkspace: held.holdWorkspace });
    expect(f.hub.startsInFlight).toBe(0);
    const starting = f.hub.start(shareRequest());
    expect(f.hub.startsInFlight).toBe(1);
    const second = f.hub.start(shareRequest({ platform: 'android' }));
    expect(f.hub.startsInFlight).toBe(2);
    held.refuse('`stim ios` holds the native-run claim');
    held.open();
    await Promise.all([starting, second]);
    expect(f.hub.startsInFlight).toBe(0);
  });

  it('is refused with the claim holder named, and registers nothing, when the claim cannot be taken', async () => {
    const held = claim();
    held.refuse('`stim ios` holds the native-run claim');
    const f = fixture({}, { holdWorkspace: held.holdWorkspace });
    const starting = f.hub.start(shareRequest());
    held.open();
    expect(await starting).toEqual({ code: 'action-failed', message: '`stim ios` holds the native-run claim' });
    expect(f.hub.list()).toEqual([]);
    expect(f.routeOpens).toEqual([]);
    expect(held.events).toEqual([`hold ${WORKSPACE}`]);
  });

  it('keeps the claim until the share is registered', async () => {
    const held = claim();
    held.open();
    const registeredAtRelease: number[] = [];
    const f: Fixture = fixture(
      {},
      {
        holdWorkspace: async (workspace, stop) => {
          const hold = await held.holdWorkspace!(workspace, stop);
          if ('code' in hold) return hold;
          return {
            release: () => {
              registeredAtRelease.push(f.hub.list().length);
              hold.release();
            },
          };
        },
      },
    );
    await f.hub.start(shareRequest());
    expect(registeredAtRelease).toEqual([1]);
  });
});
