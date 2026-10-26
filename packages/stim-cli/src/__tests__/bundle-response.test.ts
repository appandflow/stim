import { once } from 'node:events';
import { createServer, get, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bundleResponseMiddleware } from '../../shim/bundle-response.cjs';
import { recordFromLine } from '../supervisor/server-expo.ts';
import { metroBundleState } from '../metro-bundle.ts';

let server: Server;
afterEach(async () => {
  vi.restoreAllMocks();
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(
  handler: (res: ServerResponse) => void,
  options?: Parameters<typeof bundleResponseMiddleware>[1],
) {
  const records: Record<string, unknown>[] = [];
  const middleware = bundleResponseMiddleware((record) => records.push(record), options);
  server = createServer((req, res) => middleware(req, res, () => handler(res)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { records, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('completion follows the actual HTTP response, preserving platform and request identity', async () => {
  let response: ServerResponse;
  const { records, url } = await listen((res) => {
    response = res;
    res.write('first chunk');
  });
  const request = get(`${url}/index.bundle?platform=android`);
  const [incoming] = await once(request, 'response');
  incoming.resume();
  expect(records.map((r) => r.event)).toEqual(['bundle_response_started']);
  const ended = once(incoming, 'end');
  response!.end('last chunk');
  await ended;
  expect(records).toHaveLength(2);
  expect(records[1]).toMatchObject({
    event: 'bundle_response_finished',
    platform: 'android',
    statusCode: 200,
    requestId: records[0]!.requestId,
  });
  const line = `stim-bundle-response: ${JSON.stringify(records[1])}`;
  expect(recordFromLine(line, { stream: 'stderr' })).toEqual(records[1]);
  expect(recordFromLine(line)?.event).toBe('expo_stdout');
});

test("Metro's multipart progress parts become at most one progress record a second, which status reads", async () => {
  let clock = Date.parse('2026-09-27T10:00:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const BOUNDARY = '3beqjf3apnqeu3h5jqorms4i';
  let response: ServerResponse;
  const part = (done: number, total: number, percent: number) => {
    response.write(`\r\n--${BOUNDARY}\r\n`);
    response.write('Content-Type: application/json\r\n\r\n');
    response.write(JSON.stringify({ done, total, percent }));
  };
  const { records, url } = await listen((res) => {
    response = res;
    res.writeHead(200, { 'Content-Type': `multipart/mixed; boundary="${BOUNDARY}"` });
    res.write('If you are seeing this, your client does not support multipart response');
  });
  const request = get(`${url}/index.bundle?platform=android`, { headers: { accept: 'multipart/mixed' } });
  const [incoming] = await once(request, 'response');
  incoming.resume();
  part(120, 2400, 5);
  clock += 500;
  part(1200, 2400, 50);
  clock += 1000;
  part(2160, 2400, 90);

  const lines = () => records.map((record) => JSON.stringify(record));
  expect(records.map((r) => [r.event, r.percent])).toEqual([
    ['bundle_response_started', undefined],
    ['bundle_response_progress', 5],
    ['bundle_response_progress', 90],
  ]);
  expect(recordFromLine(`stim-bundle-response: ${lines()[2]}`, { stream: 'stderr' })).toEqual(records[2]);
  expect(metroBundleState(lines(), { running: true, now: clock })).toEqual({
    bundling: true,
    platform: 'android',
    startedAt: '2026-09-27T10:00:00.000Z',
    percent: 90,
  });

  clock += 700;
  const ended = once(incoming, 'end');
  response!.end(`\r\n--${BOUNDARY}--\r\n`);
  await ended;
  expect(metroBundleState(lines(), { running: true, now: clock })).toEqual({
    bundling: false,
    last: { platform: 'android', status: 'ok', durationMs: 2200, finishedAt: '2026-09-27T10:00:02.200Z' },
  });
});

test("Stim's warmup prefetch is recorded apart from app requests, without a client lookup", async () => {
  const runLsof = vi.fn<(args: string[]) => Promise<string>>(async () => '');
  const { records, url } = await listen(
    (res) => {
      res.statusCode = 500;
      res.end();
    },
    { runLsof },
  );
  const request = get(`${url}/index.bundle?platform=ios`, { headers: { 'x-stim-metro-warmup': '1' } });
  const [incoming] = await once(request, 'response');
  incoming.resume();
  await once(incoming, 'end');
  expect(records.map((r) => [r.event, r.level])).toEqual([
    ['bundle_prefetch_started', 'debug'],
    ['bundle_prefetch_failed', 'debug'],
  ]);
  expect(runLsof).not.toHaveBeenCalled();
});

test('an aborted response cannot report completion', async () => {
  const { records, url } = await listen((res) => res.write('partial'));
  const request = get(`${url}/index.bundle?platform=ios`);
  const [incoming] = await once(request, 'response');
  const closed = once(incoming, 'close');
  incoming.destroy();
  await closed;
  await vi.waitFor(() => expect(records).toHaveLength(2));
  expect(records[1]).toMatchObject({ event: 'bundle_response_failed', platform: 'ios', level: 'error' });
});

test.each([304, 500])('HTTP status %s is classified without trusting a build marker', async (status) => {
  const { records, url } = await listen((res) => {
    res.statusCode = status;
    res.end();
  });
  const request = get(`${url}/index.bundle?platform=ios`);
  const [incoming] = await once(request, 'response');
  incoming.resume();
  await once(incoming, 'end');
  expect(records[1]).toMatchObject({
    event: status === 304 ? 'bundle_response_finished' : 'bundle_response_failed',
    statusCode: status,
  });
});

test.each(['/index.map?platform=ios', '/assets/icon.png?platform=ios', '/index.bundle?platform=web', '/index.bundle'])(
  'ignores non-native bundle request %s',
  async (path) => {
    const { records, url } = await listen((res) => res.end());
    const request = get(`${url}${path}`);
    const [incoming] = await once(request, 'response');
    incoming.resume();
    await once(incoming, 'end');
    expect(records).toEqual([]);
  },
);

test.each([
  ['ios', 'this connection', 4242],
  ['ios', 'another connection on the same client port', undefined],
  ['ios', 'lookup failure', undefined],
  ['android', 'this connection', undefined],
])('a %s delivery names the process lsof shows on %s: %s', async (platform, connection, clientPid) => {
  let args: string[] = [];
  let lsof = '';
  let lookupSettled = false;
  let servedBeforeLookup = false;
  const { records, url } = await listen(
    (res) => {
      servedBeforeLookup = !lookupSettled;
      res.end('bundle');
    },
    {
      runLsof: async (lsofArgs) => {
        args = lsofArgs;
        await new Promise((resolve) => setTimeout(resolve, 20));
        lookupSettled = true;
        if (connection === 'lookup failure') throw new Error('lsof failed');
        return lsof;
      },
    },
  );
  const request = get(`${url}/index.bundle?platform=${platform}`);
  request.on('socket', (socket) =>
    socket.on('connect', () => {
      const ports = `${socket.localPort}->127.0.0.1:${new URL(url).port}`;
      lsof =
        connection === 'this connection'
          ? `p1\nn127.0.0.1:${new URL(url).port}->127.0.0.1:${socket.localPort}\np4242\nn127.0.0.1:${ports}\n`
          : `p4242\nn127.0.0.1:${socket.localPort}->10.0.0.9:443\n`;
    }),
  );
  const [incoming] = await once(request, 'response');
  incoming.resume();
  await once(incoming, 'end');
  await vi.waitFor(() => expect(records).toHaveLength(2));
  expect(records.map((r) => r.event)).toEqual(['bundle_response_started', 'bundle_response_finished']);
  expect(records.map((r) => r.clientPid)).toEqual([clientPid, clientPid]);
  expect(servedBeforeLookup).toBe(platform !== 'ios');
  expect(args.length ? [args[0], args[1]!.replace(/\d+$/, 'N'), args[2]] : []).toEqual(
    platform === 'ios' ? ['-nP', '-iTCP:N', '-Fpn'] : [],
  );
});

describe('the Expo dev client manifest request', () => {
  async function fetchPath(url: string, path: string, headers: Record<string, string> = {}) {
    const [incoming] = await once(get(`${url}${path}`, { headers }), 'response');
    incoming.resume();
    await once(incoming, 'end');
  }
  const arm = (url: string) => fetchPath(url, '/_stim/metro-warmup');

  test.each(['ios', 'android'] as const)(
    'a %s manifest request is recorded from its start to the end of its response, in the form the supervisor accepts',
    async (platform) => {
      const { records, url } = await listen((res) => res.end('{}'), { manifests: true });
      await arm(url);
      await fetchPath(url, '/', { 'expo-platform': platform });
      await vi.waitFor(() => expect(records).toHaveLength(2));
      expect(records.map((r) => r.event)).toEqual(['manifest_request_started', 'manifest_request_finished']);
      expect(records[1]).toMatchObject({ platform, statusCode: 200, requestId: records[0]?.requestId, level: 'debug' });
      for (const record of records) {
        const line = `stim-bundle-response: ${JSON.stringify(record)}`;
        expect(recordFromLine(line, { stream: 'stderr' })).toEqual(record);
      }
    },
  );

  test('a manifest the server refuses is recorded as failed', async () => {
    const { records, url } = await listen(
      (res) => {
        res.statusCode = 500;
        res.end();
      },
      { manifests: true },
    );
    await arm(url);
    await fetchPath(url, '/manifest', { 'expo-platform': 'android' });
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toMatchObject({ event: 'manifest_request_failed', statusCode: 500 });
  });

  test.each([
    ['a request without a platform', '/', {}],
    ['another path', '/index.html', { 'expo-platform': 'ios' }],
    ['a platform Metro does not serve natively', '/', { 'expo-platform': 'web' }],
    ['Stim warmup fetch', '/', { 'expo-platform': 'android', 'x-stim-metro-warmup': '1' }],
  ])('%s is not recorded', async (_name, path, headers) => {
    const { records, url } = await listen((res) => res.end(), { manifests: true });
    await arm(url);
    await fetchPath(url, path, headers);
    expect(records).toEqual([]);
  });

  test('a server that never saw the warmup probe, or a bare React Native one, records no manifest requests', async () => {
    const unarmed = await listen((res) => res.end(), { manifests: true });
    await fetchPath(unarmed.url, '/', { 'expo-platform': 'android' });
    expect(unarmed.records).toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const bare = await listen((res) => res.end());
    await arm(bare.url);
    await fetchPath(bare.url, '/', { 'expo-platform': 'android' });
    expect(bare.records).toEqual([]);
  });
});

test('an HMR update Metro pushes over /hot after a file change is recorded, at most once a minute, in the form the supervisor accepts', async () => {
  const { records, url } = await listen((res) => res.end());
  const hmrMessages: string[] = [];
  server.on('upgrade', (_req, socket) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    for (const message of hmrMessages) socket.write(Buffer.from(message));
    socket.end();
  });
  const upgrade = async (path: string) => {
    const request = get(`${url}${path}`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    const [, socket] = await once(request, 'upgrade');
    socket.on('error', () => {});
    socket.destroy();
  };
  const [incoming] = await once(get(`${url}/status`), 'response');
  incoming.resume();
  await once(incoming, 'end');

  hmrMessages.push(JSON.stringify({ type: 'update-start', body: { isInitialUpdate: true } }));
  await upgrade('/hot');
  expect(records).toEqual([]);

  hmrMessages.push(JSON.stringify({ type: 'update-start', body: { isInitialUpdate: false } }));
  await upgrade('/message');
  expect(records).toEqual([]);
  await upgrade('/hot');
  await upgrade('/hot');
  expect(records.map((record) => record.event)).toEqual(['hmr_update']);
  const line = `stim-bundle-response: ${JSON.stringify(records[0])}`;
  expect(recordFromLine(line, { stream: 'stderr' })).toEqual(records[0]);
});
