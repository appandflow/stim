import { once } from 'node:events';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { warmMetro } from '../engine/metro-warmup.ts';
import { bundleResponseMiddleware } from '../../shim/bundle-response.cjs';

let server: Server;
afterEach(async () => {
  vi.useRealTimers();
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const observer = bundleResponseMiddleware(() => {});
  server = createServer((req, res) => observer(req, res, () => handler(req, res)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test.each(['ios', 'android'] as const)(
  'prefetches the bare %s bundle without app-response evidence',
  async (platform) => {
    const records: Record<string, unknown>[] = [];
    const requests: string[] = [];
    const observe = bundleResponseMiddleware((record) => records.push(record));
    const port = await listen((req, res) =>
      observe(req, res, () => {
        requests.push(`${req.method} ${req.url}`);
        res.end();
      }),
    );
    await warmMetro({ port, platform, isExpo: false, appId: 'com.example.app' });
    const requested = new URL(requests[0]!.slice(4), 'http://localhost');
    expect(requests[0]).toMatch(/^GET /);
    expect(requested.pathname).toBe('/index.bundle');
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      platform,
      dev: 'true',
      lazy: 'true',
      minify: 'false',
      ...(platform === 'ios' ? { inlineSourceMap: 'false' } : {}),
      modulesOnly: 'false',
      runModule: 'true',
      excludeSource: 'true',
      sourcePaths: 'url-server',
      app: 'com.example.app',
    });
    expect(records).toEqual([]);
  },
);

test('uses Expo manifest entry/options on the verified local port', async () => {
  const requests: string[] = [];
  const port = await listen((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    expect(req.headers['expo-platform']).toBe('android');
    res.end(
      req.url === '/'
        ? JSON.stringify({
            launchAsset: {
              url: 'https://public.example/node_modules/expo-router/entry.bundle?platform=android&dev=true&lazy=true&transform.engine=hermes',
            },
          })
        : '',
    );
  });
  await warmMetro({ port, platform: 'android', isExpo: true });
  expect(requests).toEqual([
    'GET /',
    'GET /node_modules/expo-router/entry.bundle?platform=android&dev=true&lazy=true&transform.engine=hermes',
  ]);
});

test.each([
  { isExpo: false, platform: 'ios', origin: '' },
  { isExpo: false, platform: 'android', origin: 'http://device.example:8081' },
  { isExpo: true, platform: 'ios', origin: 'https://public.example' },
  { isExpo: true, platform: 'android', origin: '' },
] as const)(
  'a custom $platform URL overrides bundle discovery for Expo=$isExpo',
  async ({ isExpo, platform, origin }) => {
    const path = `/src/native.bundle?platform=${platform}&dev=true&lazy=false&transform.custom=a%2Fb&custom=one&custom=two`;
    const requests: string[] = [];
    const records: Record<string, unknown>[] = [];
    const observe = bundleResponseMiddleware((record) => records.push(record));
    const port = await listen((req, res) =>
      observe(req, res, () => {
        requests.push(req.url!);
        expect(req.headers.host).toBe(`127.0.0.1:${port}`);
        res.end('bundle');
      }),
    );
    await warmMetro({ port, platform, isExpo, bundleUrl: `${origin}${path}`, appId: 'not-added-to-override' });
    expect(requests).toEqual([path]);
    expect(records).toEqual([]);
  },
);

test.each(['invalid JSON', '{}', 'null'])('a missing Expo bundle URL skips prefetch: %s', async (body) => {
  const methods: string[] = [];
  const port = await listen((req, res) => {
    methods.push(req.method!);
    res.end(body);
  });
  await warmMetro({ port, platform: 'ios', isExpo: true });
  expect(methods).toEqual(['GET']);
});

test.each([500, 302])('HTTP %s is best effort and does not follow a redirect', async (status) => {
  let requests = 0;
  const port = await listen((_req, res) => {
    requests++;
    res.writeHead(status, { location: 'http://example.invalid/bundle' });
    res.end();
  });
  await warmMetro({ port, platform: 'ios', isExpo: true });
  expect(requests).toBe(1);
});

test('bounds a stalled request without rejecting', async () => {
  const port = await listen(() => {});
  vi.useFakeTimers();
  const incoming = new Promise<void>((resolve) =>
    server.on('request', (req) => {
      if (req.url?.startsWith('/index.bundle')) resolve();
    }),
  );
  const warming = warmMetro({ port, platform: 'ios', isExpo: false });
  await incoming;
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(warming).resolves.toBeUndefined();
});

test('a pending warmup does not keep the command alive', async () => {
  const port = await listen(() => {});
  const incoming = new Promise<void>((resolve) =>
    server.on('request', (req) => {
      if (req.url?.startsWith('/index.bundle')) resolve();
    }),
  );
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { warmMetro } from ${JSON.stringify(new URL('../engine/metro-warmup.ts', import.meta.url).href)};
    void warmMetro({ port: ${port}, platform: 'ios', isExpo: false });
    setTimeout(() => {}, 100);
  `,
    ],
    { stdio: 'pipe' },
  );
  const exited = once(child, 'exit');
  try {
    await incoming;
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('an older or external Metro without prefetch isolation is left alone', async () => {
  const requests: string[] = [];
  server = createServer((req, res) => {
    requests.push(req.url!);
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await warmMetro({ port: (server.address() as AddressInfo).port, platform: 'ios', isExpo: false });
  expect(requests).toEqual(['/_stim/metro-warmup']);
});
