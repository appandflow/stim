import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BuildConnection } from '../offload/client.ts';
import { openMetroLinks, type MetroLinkPool } from '../supervisor/metro-links.ts';

const session = '12345678-1234-1234-1234-123456789abc';

interface FakeLink {
  connection: BuildConnection;
  requests: { method: string; params: unknown }[];
  sent: Buffer[];
  closed: boolean;
  open: () => void;
  receive: (frame: Buffer) => void;
}

let metro: Server;
let metroPort: number;
let links: FakeLink[];
let pool: MetroLinkPool | undefined;
let refusal: string | null;
let openOnRequest: number;
let connectFailures: Error[];
let ready: number;
let errors: string[];

function fakeLink(): FakeLink {
  let event: ((message: Record<string, unknown>) => void) | null = null;
  let binary: ((frame: Buffer) => void) | null = null;
  const link: FakeLink = {
    requests: [],
    sent: [],
    closed: false,
    open: () => event?.({ event: 'device-host.metro.link.open' }),
    receive: (frame) => binary?.(frame),
    connection: {
      supports: (feature: string) => feature === 'hosted-metro-link',
      request: async (method: string, params: unknown) => {
        link.requests.push({ method, params });
        if (openOnRequest > 0) {
          openOnRequest--;
          link.open();
        }
        return refusal ? { error: { code: 'forbidden', message: refusal } } : { result: {} };
      },
      onEvent: (listener: typeof event) => (event = listener),
      onBinary: (listener: typeof binary) => (binary = listener),
      onDropped: () => {},
      sendBinary: async (frame: Buffer) => void link.sent.push(Buffer.from(frame)),
      flushed: async () => {},
      close: () => (link.closed = true),
      get failure() {
        return link.closed ? 'closed' : null;
      },
    } as unknown as BuildConnection,
  };
  return link;
}

function start(): void {
  pool = openMetroLinks({
    machine: 'mini',
    session,
    metroPort,
    onReady: () => ready++,
    onError: (message) => errors.push(message),
    connect: async () => {
      const failure = connectFailures.shift();
      if (failure) throw failure;
      const link = fakeLink();
      links.push(link);
      return link.connection;
    },
  });
}

beforeEach(async () => {
  links = [];
  refusal = null;
  openOnRequest = 0;
  connectFailures = [];
  ready = 0;
  errors = [];
  metro = createServer((request, response) => {
    response.setHeader('connection', 'close');
    response.end(request.url === '/large' ? Buffer.alloc(200 * 1024, 7) : `served ${request.url}`);
  });
  await new Promise<void>((resolve) => metro.listen(0, '127.0.0.1', resolve));
  metroPort = (metro.address() as AddressInfo).port;
});
afterEach(async () => {
  pool?.close();
  pool = undefined;
  metro.closeAllConnections();
  await new Promise<void>((resolve) => metro.close(() => resolve()));
});

test('offers four idle links for the session and reports ready once the host holds one', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  expect(links).toHaveLength(4);
  for (const link of links) expect(link.requests).toEqual([{ method: 'device-host.metro.link', params: { session } }]);
  expect(errors).toEqual([]);
});

test('a paired link carries its stream to loopback Metro in client-sized frames and is replaced', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  const [link] = links;
  assert(link);
  link.open();
  await vi.waitFor(() => expect(links).toHaveLength(5));
  link.receive(Buffer.from('GET /large HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  await vi.waitFor(() => expect(link.closed).toBe(true));
  const response = Buffer.concat(link.sent);
  expect(response.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK/);
  expect(response.subarray(response.indexOf('\r\n\r\n') + 4).equals(Buffer.alloc(200 * 1024, 7))).toBe(true);
  expect(Math.max(...link.sent.map((frame) => frame.length))).toBeLessThanOrEqual(32 * 1024);
  expect(links.slice(1).every((each) => !each.closed)).toBe(true);
});

test('refills links the host opened before their registration reply arrived', async () => {
  openOnRequest = 4;
  start();
  await vi.waitFor(() => expect(links).toHaveLength(8));
  expect(links.slice(4).every((link) => link.requests.length === 1 && !link.closed)).toBe(true);
});

test('does not report one transient connect failure while the other links come up', async () => {
  connectFailures = [new Error('connect ETIMEDOUT')];
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  expect(errors).toEqual([]);
});

test('reports a hosting refusal at once instead of waiting for every link to fail', async () => {
  connectFailures = [
    Object.assign(new Error('mini has not confirmed hosting access'), { code: 'STIM_HOSTING_REFUSED' }),
  ];
  start();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(errors[0]).toContain('has not confirmed hosting access');
});

test('reports a refusal before any link is ready and offers no link', async () => {
  refusal = 'Current device-host approval is required.';
  start();
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
  expect(errors[0]).toContain('Current device-host approval is required.');
  expect(ready).toBe(0);
  expect(links.every((link) => link.closed)).toBe(true);
});

test('closing the pool ends idle and carrying links', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  links[0]?.open();
  await vi.waitFor(() => expect(links).toHaveLength(5));
  pool?.close();
  expect(links.every((link) => link.closed)).toBe(true);
});
