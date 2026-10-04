import { createServer, get, request, type Server as HttpServer } from 'node:http';
import { connect, type AddressInfo, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createMetroGateway, createMetroBridge, type MetroBridge } from '../metro-bridge.ts';

const active: MetroBridge[] = [];
let metro: HttpServer;
let reads: string[];

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

beforeEach(() => {
  reads = [];
  metro = createServer((incoming, response) => {
    reads.push(incoming.url!);
    incoming.pipe(response);
  });
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((bridge) => bridge.close()));
  metro.closeAllConnections();
  await new Promise<void>((resolve) => metro.close(() => resolve()));
});

async function route(peer = '127.0.0.1', secret = randomBytes(32).toString('hex')) {
  const gateway = createMetroGateway({ metroPort: await listen(metro), peer, secret });
  active.push(gateway);
  const gatewayPort = await listen(gateway.server);
  const bridge = createMetroBridge({ gatewayPort, peer: '127.0.0.1', secret });
  active.push(bridge);
  return { gateway, gatewayPort, bridge, bridgePort: await listen(bridge.server), secret };
}

test('streams a large request and response without changing its HTTP path, headers or bytes', async () => {
  const { bridgePort } = await route();
  const expected = randomBytes(256 * 1024);
  const received = await new Promise<Buffer>((resolve, reject) => {
    const sent = request(
      `http://127.0.0.1:${bridgePort}/index.bundle?platform=ios&dev=true`,
      { method: 'POST' },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    sent.once('error', reject);
    sent.end(expected);
  });
  expect(received.equals(expected)).toBe(true);
  expect(reads).toEqual(['/index.bundle?platform=ios&dev=true']);
});

test.each(['secret', 'peer'])('refuses a wrong %s before sending any request to Metro', async (invalid) => {
  const routed = await route(invalid === 'peer' ? '127.0.0.2' : '127.0.0.1');
  const client = connect(routed.gatewayPort, '127.0.0.1');
  const closed = new Promise<void>((resolve) => {
    client.once('close', () => resolve());
    client.on('error', () => {});
  });
  client.write(
    `${invalid === 'secret' ? 'f'.repeat(64) : routed.secret}\nGET /index.bundle HTTP/1.1\r\nHost: localhost\r\n\r\n`,
  );
  await closed;
  expect(reads).toEqual([]);
});

test('closing the gateway terminates an authenticated request that is still in flight', async () => {
  const { gateway, bridgePort } = await route();
  const client = request(`http://127.0.0.1:${bridgePort}/ongoing`, { method: 'POST' });
  const failure = new Promise<string>((resolve) => {
    client.once('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
    client.once('response', (response) => {
      response.on('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
      response.resume();
    });
  });
  client.write('in flight');
  await vi.waitFor(() => expect(reads).toEqual(['/ongoing']));
  await gateway.close();
  expect(await failure).toBe('ECONNRESET');
});

test('closing the worker endpoint refuses new requests after releasing its exact listener', async () => {
  const { bridge, bridgePort } = await route();
  await bridge.close();
  const code = await new Promise<string>((resolve) => {
    get(`http://127.0.0.1:${bridgePort}/status`).once('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
  });
  expect(code).toBe('ECONNREFUSED');
  expect(reads).toEqual([]);
});

test('closes an accepted worker socket when its gateway TCP connection is refused', async () => {
  const gatewayPort = await listen(metro);
  await new Promise<void>((resolve) => metro.close(() => resolve()));
  const bridge = createMetroBridge({ gatewayPort, peer: '127.0.0.1', secret: 'a'.repeat(64) });
  active.push(bridge);
  const socket = connect(await listen(bridge.server), '127.0.0.1');
  try {
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.on('error', () => {});
    });
    expect(
      await new Promise<number>((resolve, reject) =>
        bridge.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      ),
    ).toBe(0);
  } finally {
    socket.destroy();
  }
});
