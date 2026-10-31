import { once } from 'node:events';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
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

test.each(['invalid JSON', '{}', 'null'])('a missing Expo bundle URL skips prefetch: %s', async (body) => {
  const methods: string[] = [];
  const port = await listen((req, res) => {
    methods.push(req.method!);
    res.end(body);
  });
  await warmMetro({ port, platform: 'ios', isExpo: true });
  expect(methods).toEqual(['GET']);
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

describe('the bundle URL an app requested earlier', () => {
  const APP_URL = '/apps/mobile/index.ts.bundle?platform=ios&dev=true&lazy=true&transform.routerRoot=src%2Fapp';
  const MANIFEST = JSON.stringify({ launchAsset: { url: `http://127.0.0.1:1${APP_URL}` } });
  let logsDir: string;
  let serverRoot: string;
  let projectRoot: string;
  beforeEach(() => {
    logsDir = mkdtempSync(join(tmpdir(), 'stim-warmup-'));
    serverRoot = mkdtempSync(join(tmpdir(), 'stim-warmup-root-'));
    projectRoot = join(serverRoot, 'apps', 'mobile');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'index.ts'), '');
  });
  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
    rmSync(serverRoot, { recursive: true, force: true });
  });

  const metroLog = (...lines: string[]) => writeFileSync(join(logsDir, 'metro.ndjson'), `${lines.join('\n')}\n`);
  const started = (platform: string, url: unknown) =>
    JSON.stringify({ ts: 1, src: 'metro', event: 'bundle_response_started', platform, requestId: 'r', url });

  async function warm(platform: 'ios' | 'android' = 'ios', bundleUrl?: string) {
    const requests: string[] = [];
    const port = await listen((req, res) => {
      requests.push(String(req.url));
      res.end(req.url === '/' ? MANIFEST : '');
    });
    await warmMetro({ port, platform, isExpo: true, bundleUrl, logsDir, root: projectRoot });
    return requests;
  }

  test('a record that rotated into the previous log generation is still used', async () => {
    writeFileSync(`${join(logsDir, 'metro.ndjson')}.1`, `${started('ios', APP_URL)}\n`);
    metroLog(started('android', '/other.bundle?platform=android'));
    expect(await warm()).toEqual([APP_URL]);
  });
});
