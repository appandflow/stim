import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect as connectTcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ShareHub, type StartedShare, type StatusListener } from '../src/share.ts';
import { ExposedRoute, resolveExposure, tailscaleLoggedIn, type ShareSettings } from '../src/share-exposure.ts';
import { ShareRoute, type FunnelTool } from '../src/share-route.ts';

const RUNNING = { BackendState: 'Running', Self: { DNSName: 'mac.tail.ts.net.' } };

describe('resolving how shares are exposed', () => {
  const settings = (overrides: Partial<ShareSettings> = {}): ShareSettings => ({
    exposure: undefined,
    publicUrl: undefined,
    port: undefined,
    ...overrides,
  });

  it('defaults to auto: Funnel for a logged-in tailscale, proxy otherwise', async () => {
    expect(await resolveExposure(settings(), async () => true)).toMatchObject({ mode: 'tailscale', port: 7790 });
    expect(await resolveExposure(settings(), async () => false)).toMatchObject({ mode: 'proxy', port: 7790 });
  });

  it('treats a missing, logged-out or stopped tailscale as not logged in', () => {
    expect(tailscaleLoggedIn(RUNNING)).toBe(true);
    expect(tailscaleLoggedIn(null)).toBe(false);
    expect(tailscaleLoggedIn({ BackendState: 'NeedsLogin' })).toBe(false);
    expect(tailscaleLoggedIn({ BackendState: 'Stopped', Self: { DNSName: 'mac.tail.ts.net.' } })).toBe(false);
    expect(tailscaleLoggedIn({ BackendState: 'Running', Self: {} })).toBe(false);
  });

  it('follows an explicit choice without asking tailscale', async () => {
    const asked = vi.fn<() => Promise<boolean>>(async () => true);
    expect(await resolveExposure(settings({ exposure: 'proxy' }), asked)).toMatchObject({ mode: 'proxy' });
    expect(asked).not.toHaveBeenCalled();
    expect(await resolveExposure(settings({ exposure: 'tailscale' }), async () => false)).toMatchObject({
      mode: 'tailscale',
    });
  });

  it('takes the port and the public address, without a trailing slash', async () => {
    expect(
      await resolveExposure(
        settings({ exposure: 'proxy', port: 8123, publicUrl: 'https://demo.example.com/stim/' }),
        async () => false,
      ),
    ).toEqual({ mode: 'proxy', port: 8123, publicUrl: 'https://demo.example.com/stim' });
  });

  it('refuses a hand-edited value the settings registry would not accept, naming the setting', async () => {
    await expect(resolveExposure(settings({ publicUrl: 'http://demo.example.com' }), async () => true)).rejects.toThrow(
      /share\.publicUrl.*stim settings set share\.publicUrl/,
    );
    await expect(
      resolveExposure(settings({ publicUrl: 'https://demo.example.com:abc' }), async () => true),
    ).rejects.toThrow(/share\.publicUrl.*not a valid address/);
    await expect(resolveExposure(settings({ exposure: 'funnel' }), async () => true)).rejects.toThrow(
      /share\.exposure/,
    );
    await expect(resolveExposure(settings({ port: 80 }), async () => true)).rejects.toThrow(/share\.port/);
  });
});

describe('web shares in proxy mode', () => {
  const PUBLIC = 'https://demo.example.com';
  let home: string;
  let hub: ShareHub;
  let tailscaleCalls: string[];
  let tool: FunnelTool;
  let subscribed: number;

  const listeners = new Set<StatusListener>();
  const status = {
    environments: [
      { path: '/work/app', ios: { udid: 'SIM-1', owned: true, state: 'Booted', name: 'stim-app (iPhone 17)' } },
    ],
  };

  function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  function build(
    config: Partial<ShareSettings>,
    funnel: Pick<ShareRoute, 'open' | 'close' | 'stranded' | 'removeStranded'> = new ShareRoute(
      join(home, 'share-route'),
      tool,
    ),
  ) {
    const exposed = new ExposedRoute(
      funnel,
      () => ({ exposure: 'proxy', publicUrl: undefined, port: undefined, ...config }),
      async () => {
        throw new Error('proxy mode must not ask tailscale');
      },
    );
    hub = new ShareHub({
      frames: {
        keyframe: () => {},
        congested: () => {},
        subscribe: () => {
          subscribed++;
          return () => {};
        },
      },
      control: {
        begin: async () => ({ code: 'device-busy', message: 'busy' }),
        targetOf: () => null,
        input: async () => null,
        release: () => {},
        endFor: () => {},
        endById: () => true,
      },
      subscribeStatus: (listener) => {
        listeners.add(listener);
        listener.item(JSON.parse(JSON.stringify(status)));
        return () => listeners.delete(listener);
      },
      route: exposed,
    });
  }

  async function start(config: Partial<ShareSettings>, password = true): Promise<StartedShare> {
    build(config);
    const share = await hub.start({
      workspace: '/work/app',
      platform: 'ios',
      control: false,
      expiresMinutes: 60,
      ...(password ? {} : { passwordless: true }),
    });
    if ('code' in share) throw new Error(share.message);
    return share;
  }

  function http(url: string, options: { method?: string; body?: string; cookie?: string } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
      (resolve, reject) => {
        const sent = request(
          url,
          {
            method: options.method ?? 'GET',
            headers: {
              host: 'demo.example.com',
              ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
              ...(options.cookie ? { cookie: options.cookie } : {}),
            },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
          },
        );
        sent.on('error', reject);
        sent.end(options.body);
      },
    );
  }

  function connect(url: string, headers: Record<string, string>) {
    return new Promise<{ socket: WebSocket; status: number | null }>((resolve) => {
      const socket = new WebSocket(`${url.replace(/^http/, 'ws')}ws`, { headers });
      socket.once('open', () => resolve({ socket, status: null }));
      socket.once('unexpected-response', (_request, response) => resolve({ socket, status: response.statusCode ?? 0 }));
      socket.once('error', () => {});
    });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-share-exposure-'));
    subscribed = 0;
    tailscaleCalls = [];
    const called = async (name: string): Promise<never> => {
      tailscaleCalls.push(name);
      throw new Error(`proxy mode called tailscale ${name}`);
    };
    tool = {
      status: () => called('status'),
      serveConfig: () => called('serveConfig'),
      add: () => called('add'),
      remove: () => called('remove'),
    };
  });
  afterEach(async () => {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('binds the configured loopback port, prints links under the public address and never touches tailscale', async () => {
    const port = await freePort();
    const share = await start({ port, publicUrl: PUBLIC });
    expect(hub.port).toBe(port);
    expect(share.url).toMatch(/^https:\/\/demo\.example\.com\/s\/[A-Za-z0-9_-]{43}\/$/);
    expect(share.warning).toBeUndefined();
    const local = `http://127.0.0.1:${port}${new URL(share.url).pathname}`;
    expect((await http(local)).status).toBe(200);
    await hub.stop(null);
    expect(tailscaleCalls).toEqual([]);
    await vi.waitFor(() => expect(hub.port).toBeNull());
  });

  it('without a public address, prints the loopback link with a warning that names the setting', async () => {
    const port = await freePort();
    const share = await start({ port });
    expect(share.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/s/`));
    expect(share.warning).toContain('stim settings set share.publicUrl');
  });

  it('accepts the frame socket only from the public origin, whatever Host the proxy forwards', async () => {
    const port = await freePort();
    const share = await start({ port, publicUrl: PUBLIC }, false);
    const local = `http://127.0.0.1:${port}${new URL(share.url).pathname}`;
    expect((await connect(local, { origin: 'https://evil.example', host: 'demo.example.com' })).status).toBe(403);
    expect((await connect(local, { origin: `http://127.0.0.1:${port}` })).status).toBe(403);
    expect((await connect(local, { host: 'demo.example.com' })).status).toBe(403);
    const { socket, status: refused } = await connect(local, { origin: PUBLIC, host: '127.0.0.1' });
    expect(refused).toBeNull();
    expect(subscribed).toBe(1);
    socket.close();
  });

  it('serves under a path prefix the proxy keeps, and scopes the session cookie and redirect to it', async () => {
    const port = await freePort();
    const share = await start({ port, publicUrl: `${PUBLIC}/stim` });
    const path = new URL(share.url).pathname;
    expect(path).toMatch(/^\/stim\/s\/[A-Za-z0-9_-]{43}\/$/);
    const local = `http://127.0.0.1:${port}`;
    expect((await http(`${local}${path.replace('/stim', '')}`)).status).toBe(404);
    const answer = await http(`${local}${path}login`, { method: 'POST', body: `password=${share.password ?? ''}` });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe(path);
    const cookie = String(answer.headers['set-cookie']);
    expect(cookie).toContain(`Path=${path};`);
    const { socket, status: refused } = await connect(`${local}${path}`, {
      origin: PUBLIC,
      cookie: cookie.split(';')[0] ?? '',
    });
    expect(refused).toBeNull();
    socket.close();
  });

  const accepts = (port: number) =>
    new Promise<boolean>((resolve) => {
      const probe = connectTcp(port, '127.0.0.1', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });

  it('keeps the listener bound with no share and answers every path with the not-found page and no share data', async () => {
    const port = await freePort();
    build({ port, publicUrl: PUBLIC });
    await hub.keep();
    expect(hub.port).toBe(port);
    const unknown = `/s/${'A'.repeat(43)}/`;
    for (const path of ['/', unknown, `${unknown}login`, '/s/assets/missing.js', '/anything/else']) {
      const answer = await http(`http://127.0.0.1:${port}${path}`);
      expect(answer.status).toBe(404);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(String(answer.headers['content-security-policy'])).toContain("default-src 'none'");
      expect(answer.body).toContain('This share has ended or the link is wrong');
      expect(answer.body).not.toMatch(/work\/app|password|<script/i);
    }
    expect((await http(`http://127.0.0.1:${port}${unknown}login`, { method: 'POST', body: 'password=x' })).status).toBe(
      404,
    );
    expect(tailscaleCalls).toEqual([]);
  });

  it('serves a share on the kept listener and keeps it bound, answering 404 for that link, after the share ends', async () => {
    const port = await freePort();
    build({ port, publicUrl: PUBLIC });
    await hub.keep();
    const share = await hub.start({ workspace: '/work/app', platform: 'ios', control: false, expiresMinutes: 60 });
    if ('code' in share) throw new Error(share.message);
    const local = `http://127.0.0.1:${port}${new URL(share.url).pathname}`;
    expect((await http(local)).status).toBe(200);
    await hub.stop(null);
    expect(hub.port).toBe(port);
    const ended = await http(local);
    expect(ended.status).toBe(404);
    expect(ended.body).toContain('This share has ended or the link is wrong');
    expect(ended.body).not.toContain(new URL(share.url).pathname.split('/')[2] ?? 'missing');
  });

  it('moves a kept listener to the port a changed setting names when the next share starts', async () => {
    const first = await freePort();
    const config = { port: first, publicUrl: PUBLIC };
    build(config);
    await hub.keep();
    expect(await accepts(first)).toBe(true);
    config.port = await freePort();
    const share = await hub.start({ workspace: '/work/app', platform: 'ios', control: false, expiresMinutes: 60 });
    if ('code' in share) throw new Error(share.message);
    expect(hub.port).toBe(config.port);
    expect(await accepts(first)).toBe(false);
  });

  it('releases the port when the server stops', async () => {
    const port = await freePort();
    build({ port, publicUrl: PUBLIC });
    await hub.keep();
    await hub.close();
    expect(hub.port).toBeNull();
    expect(await accepts(port)).toBe(false);
  });

  it('keeps nothing without a public address, where the person has no proxy yet', async () => {
    const port = await freePort();
    build({ port });
    await hub.keep();
    expect(hub.port).toBeNull();
    expect(await accepts(port)).toBe(false);
  });

  it('keeps nothing under tailscale exposure and adds no Funnel route', async () => {
    const opened: number[] = [];
    build(
      { exposure: 'tailscale', port: await freePort(), publicUrl: PUBLIC },
      {
        open: async (target) => {
          opened.push(target);
          return { url: 'https://mac.tail.ts.net', port: 443 };
        },
        close: async () => {},
        stranded: () => null,
        removeStranded: async () => {},
      },
    );
    await hub.keep();
    expect(hub.port).toBeNull();
    expect(opened).toEqual([]);
  });

  it('does not keep a listener for a hub that never called keep, such as the one stim share starts', async () => {
    const port = await freePort();
    await start({ port, publicUrl: PUBLIC });
    await hub.stop(null);
    await vi.waitFor(() => expect(hub.port).toBeNull());
    expect(await accepts(port)).toBe(false);
  });

  it('refuses to start, naming the setting, when the port is taken', async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      await expect(start({ port, publicUrl: PUBLIC })).rejects.toThrow(/stim settings set share\.port/);
    } finally {
      holder.close();
    }
  });
});

describe('the Funnel route of an auto exposure', () => {
  it('is used when tailscale is logged in', async () => {
    const opened: number[] = [];
    const route = {
      open: async (target: number) => {
        opened.push(target);
        return { url: 'https://mac.tail.ts.net', port: 443 };
      },
      close: async () => {},
      stranded: () => null,
      removeStranded: async () => {},
    };
    const exposed = new ExposedRoute(
      route,
      () => ({ exposure: undefined, publicUrl: undefined, port: undefined }),
      async () => true,
    );
    expect(await exposed.prepare()).toBe(0);
    expect(await exposed.open(4321)).toEqual({ url: 'https://mac.tail.ts.net', port: 443 });
    expect(opened).toEqual([4321]);
  });
});
