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
