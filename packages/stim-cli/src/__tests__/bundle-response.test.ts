import { once } from 'node:events';
import { createServer, get, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bundleResponseMiddleware } from '../../shim/bundle-response.cjs';
import { recordFromLine } from '../supervisor/server-expo.ts';

let server: Server;
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(handler: (res: ServerResponse) => void) {
  const records: Record<string, unknown>[] = [];
  const middleware = bundleResponseMiddleware((record) => records.push(record));
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
