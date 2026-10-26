import { createServer, get, request, type Server as HttpServer } from 'node:http';
import { connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createMetroBridge, createMetroLinks, type MetroBridge, type MetroLink } from '../metro-bridge.ts';

const active: MetroBridge[] = [];
let metro: HttpServer;
let metroPort: number;
let reads: string[];

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

function link(closed: string[] = []): MetroLink {
  return {
    open: (socket: Socket) => {
      const upstream = connect(metroPort, '127.0.0.1');
      upstream.on('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
      socket.resume();
    },
    close: () => closed.push('closed'),
  };
}

async function bridge(waitMs?: number) {
  const links = createMetroLinks();
  const created = createMetroBridge(links, waitMs);
  active.push(created);
  return { links, bridge: created, port: await listen(created.server) };
}

function failure(path: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    get(`http://127.0.0.1:${port}${path}`)
      .once('response', () => resolve('answered'))
      .once('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
  });
}

beforeEach(async () => {
  reads = [];
  metro = createServer((incoming, response) => {
    reads.push(incoming.url!);
    incoming.pipe(response);
  });
  metroPort = await listen(metro);
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((each) => each.close()));
  metro.closeAllConnections();
  await new Promise<void>((resolve) => metro.close(() => resolve()));
});

test('streams a large request and response over a link without changing its HTTP path, headers or bytes', async () => {
  const { links, port } = await bridge();
  links.add(link());
  const expected = randomBytes(256 * 1024);
  const received = await new Promise<Buffer>((resolve, reject) => {
    const sent = request(
      `http://127.0.0.1:${port}/index.bundle?platform=ios&dev=true`,
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

test('holds a connection that arrives before any link until the client opens one', async () => {
  const { links, port } = await bridge();
  const answered = failure('/status', port);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reads).toEqual([]);
  links.add(link());
  expect(await answered).toBe('answered');
  expect(reads).toEqual(['/status']);
});

test('closes a connection no link takes in time without reaching Metro', async () => {
  const { port } = await bridge(50);
  expect(await failure('/status', port)).toBe('ECONNRESET');
  expect(reads).toEqual([]);
});

test('closing the links ends idle links and refuses connections waiting for one', async () => {
  const { links, port } = await bridge();
  const closed: string[] = [];
  links.add(link(closed));
  links.close();
  expect(closed).toEqual(['closed']);
  expect(links.add(link(closed))).toBe(false);
  expect(await failure('/status', port)).toBe('ECONNRESET');
  expect(reads).toEqual([]);
});

test('closing the bridge terminates a stream in flight and releases its listener', async () => {
  const { links, bridge: created, port } = await bridge();
  links.add(link());
  const client = request(`http://127.0.0.1:${port}/ongoing`, { method: 'POST' });
  const ended = new Promise<string>((resolve) => {
    client.once('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
    client.once('response', (response) => {
      response.on('error', (error: NodeJS.ErrnoException) => resolve(error.code!));
      response.resume();
    });
  });
  client.write('in flight');
  await vi.waitFor(() => expect(reads).toEqual(['/ongoing']));
  await created.close();
  expect(await ended).toBe('ECONNRESET');
  expect(await failure('/status', port)).toBe('ECONNREFUSED');
});
