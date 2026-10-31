import { recordFromLine } from '../supervisor/server-expo.ts';
import { metroBundleState } from '../metro-bundle.ts';
import { once } from 'node:events';
import { createServer, get, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bundleResponseMiddleware } from '../../shim/bundle-response.cjs';

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
