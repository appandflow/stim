import { request } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { WebSocket } from 'ws';
import type { Device, FrameListener } from '../src/frames.ts';
import { ShareHub, type ShareRequest, type StartedShare, type StatusListener } from '../src/share.ts';

const WORKSPACE = '/work/app';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function payload(state: 'Booted' | 'Shutdown' = 'Booted', activity?: Record<string, unknown>) {
  return {
    environments: [
      { path: WORKSPACE, ios: { udid: 'SIM-1', owned: true, state, name: 'stim-app (iPhone 17)', activity } },
    ],
  };
}

interface Fixture {
  hub: ShareHub;
  subscribed: { device: Device; listener: FrameListener; unsubscribed: boolean }[];
  begins: unknown[];
  inputs: unknown[];
  routeOpens: number[];
  routeCloses: number;
  idle: number;
  refuseControl: boolean;
  exemptAtBegin: string[][];
  strandedPort: number | null;
  failRoute: { open: boolean; close: boolean };
  listenerBoundAtRouteClose: boolean[];
  status: (value: ReturnType<typeof payload>) => void;
}

function fixture(): Fixture {
  const listeners = new Set<StatusListener>();
  let latest = payload();
  const f: Fixture = {
    subscribed: [],
    begins: [],
    inputs: [],
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
    hub: null as unknown as ShareHub,
  };
  f.hub = new ShareHub({
    frames: {
      subscribe: (device, listener) => {
        const entry = { device, listener, unsubscribed: false };
        f.subscribed.push(entry);
        return () => {
          entry.unsubscribed = true;
        };
      },
    },
    control: {
      begin: async (_owner, target) => {
        f.begins.push(target);
        f.exemptAtBegin.push([...f.hub.unrecordedTargets()]);
        if (f.refuseControl) return { code: 'device-busy', message: 'This device is driven by Stim Desktop.' };
        return { session: 'c1', platform: 'ios', lease: { grantedAt: 'lease-1', expiresAt: '' }, postures: [] };
      },
      targetOf: (_owner, session) => (session === 'c1' ? { platform: 'ios', postures: [] } : null),
      input: async (_owner, session, command) => {
        f.inputs.push({ session, command });
        return null;
      },
      endFor: () => {},
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
    limits: { maxFailures: 3 },
    idle: () => f.idle++,
  });
  return f;
}

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

function connect(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; status: number | null }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}ws`, { headers });
    socket.once('open', () => resolve({ socket, status: null }));
    socket.once('unexpected-response', (_request, response) => resolve({ socket, status: response.statusCode! }));
    socket.once('error', () => {});
  });
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
    expect(page.body).toContain('type="password"');
    expect(page.headers['cache-control']).toBe('no-store');
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await http(`${url}login`, { method: 'POST', body: 'password=wrong' })).status).toBe(401);
    }
    const locked = await http(`${url}login`, { method: 'POST', body: `password=${share.password!}` });
    expect(locked.status).toBe(429);
    expect(locked.headers['set-cookie']).toBeUndefined();
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
    const frame = new Promise<Buffer>((resolve) => socket.once('message', (data) => resolve(data as Buffer)));
    f.subscribed[0]!.listener.frame({ width: 1, height: 1, capturedAt: '', data: JPEG.toString('base64') });
    expect(Buffer.compare(await frame, JPEG)).toBe(0);

    socket.close();
    await vi.waitFor(() => expect(f.subscribed[0]!.unsubscribed).toBe(true));
    expect(f.hub.list()[0]!.viewers).toBe(0);
  });

  it('drops input without --control and never begins a control session', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    socket.send(JSON.stringify({ type: 'text', text: 'hi' }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.begins).toEqual([]);
    expect(f.inputs).toEqual([]);
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

  it('keeps no recording exemption for a device whose control another client holds', async () => {
    f.refuseControl = true;
    const share = await started(f, { control: true });
    const url = local(share, f.hub.port!);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    const refused = new Promise<string>((resolve) => socket.once('message', (data) => resolve(String(data))));
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    const told = JSON.parse(await refused);
    expect(told).toMatchObject({ type: 'control' });
    expect(told.message).not.toContain('Desktop');
    expect(f.inputs).toEqual([]);
    expect(f.hub.unrecordedTargets()).toEqual(new Set());
    socket.close();
  });

  it('never exempts from recording a device something else already drives', async () => {
    f.refuseControl = true;
    const share = await started(f, { control: true });
    f.status(payload('Booted', { state: 'driven', driver: { tool: 'agent-device' }, basis: ['agent-device-lease'] }));
    const url = local(share, f.hub.port!);
    const { socket } = await connect(url, { origin: origin(url), cookie: await login(url, share.password!) });
    socket.send(JSON.stringify({ type: 'touch', phase: 'down', x: 0.5, y: 0.5 }));
    await vi.waitFor(() => expect(f.begins).toHaveLength(1));
    expect(f.exemptAtBegin).toEqual([[]]);
    socket.close();
  });

  it('ends when stopped: closes viewers, stops capture and removes the route with the last share', async () => {
    const share = await started(f);
    const url = local(share, f.hub.port!);
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

    f.failRoute.close = false;
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(f.idle).toBe(1));
    expect(f.strandedPort).toBeNull();
  });

  it('ends at its expiry, and when its device stops', async () => {
    await started(f, { expiresMinutes: 1 });
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(f.routeCloses).toBe(1));
    expect(f.hub.list()).toEqual([]);

    await started(f);
    f.status(payload('Shutdown'));
    await vi.waitFor(() => expect(f.hub.list()).toEqual([]));
    expect(f.routeCloses).toBe(2);
  });

  it('refuses a device the workspace does not own and control of a physical iPhone', async () => {
    expect(await f.hub.start(shareRequest({ platform: 'android' }))).toMatchObject({ code: 'action-failed' });
    expect(await f.hub.start(shareRequest({ physical: true, control: true }))).toMatchObject({ code: 'bad-request' });
    expect(f.routeOpens).toEqual([]);
  });
});
