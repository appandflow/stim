import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { deviceHostMachinesFile } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { BuildConnection } from '../offload/client.ts';
import type { ConnectFailure } from '../offload/tailnet.ts';
import { openMetroLinks, type MetroLinkPool } from '../supervisor/metro-links.ts';
import { getConfigPath } from '../workspace/config.ts';
import { FAKE_SERVER_PUBLIC } from './_noise-server.ts';

const session = '12345678-1234-1234-1234-123456789abc';
const TAILSCALE_STATUS = JSON.stringify({
  BackendState: 'Running',
  Peer: { nMini: { ID: 'nMini', DNSName: 'mini.tail1.ts.net.', TailscaleIPs: ['100.64.0.7'] } },
});
const SILENT: ConnectFailure = {
  failure: 'Opening handshake has timed out',
  refused: false,
  transport: { kind: 'silent' },
};

interface FakeLink {
  connection: BuildConnection;
  requests: { method: string; params: unknown }[];
  sent: Buffer[];
  closed: boolean;
  closeCode: number | null;
  watched: boolean;
  paused: boolean;
  resumed: number;
  open: () => void;
  receive: (frame: Buffer) => void;
  drop: (code: number) => void;
}

let dir: string;
let metro: Server;
let metroPort: number;
let links: FakeLink[];
let pool: MetroLinkPool | undefined;
let refusal: string | null;
let openOnRequest: number;
let connectOutcomes: ConnectFailure[];
let tailscale: string[][];
let ready: number;
let lost: number;
let errors: string[];

function fakeLink(): FakeLink {
  let event: ((message: Record<string, unknown>) => void) | null = null;
  let binary: ((frame: Buffer) => void) | null = null;
  let dropped: ((code: number) => void) | null = null;
  const link: FakeLink = {
    requests: [],
    sent: [],
    closed: false,
    closeCode: null,
    watched: false,
    paused: false,
    resumed: 0,
    open: () => event?.({ event: 'device-host.metro.link.open' }),
    receive: (frame) => binary?.(frame),
    drop: (code) => {
      link.closed = true;
      dropped?.(code);
    },
    connection: Object.create(
      BuildConnection.prototype,
      Object.getOwnPropertyDescriptors({
        supports: (feature: string) => feature === 'hosted-metro-link',
        request: async (method: string, params: unknown) => {
          link.requests.push({ method, params });
          if (openOnRequest > 0) {
            openOnRequest--;
            link.open();
          }
          return refusal ? { error: { code: 'action-failed', message: refusal } } : { result: {} };
        },
        onEvent: (listener: typeof event) => (event = listener),
        onBinary: (listener: typeof binary) => (binary = listener),
        onDropped: (listener: typeof dropped) => (dropped = listener),
        sendBinary: async (frame: Buffer) => void link.sent.push(Buffer.from(frame)),
        flushed: async () => {},
        watch: () => (link.watched = true),
        unwatch: () => (link.watched = false),
        pause: () => (link.paused = true),
        resume: () => {
          link.paused = false;
          link.resumed++;
        },
        close: (code = 1000) => {
          link.closed = true;
          link.closeCode ??= code;
        },
        get failure() {
          return link.closed ? 'closed' : null;
        },
      }),
    ) as BuildConnection,
  };
  return link;
}

function start(): void {
  pool = openMetroLinks({
    machine: 'mini',
    session,
    metroPort,
    onReady: () => ready++,
    onLost: () => lost++,
    onError: (message) => errors.push(message),
  });
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-links-')));
  process.env.STIM_HOME = join(dir, 'home');
  mkdirSync(process.env.STIM_HOME);
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini'] } }));
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({
      version: 2,
      machines: [
        {
          machine: 'mini',
          transport: 'tailscale',
          address: 'mini.tail1.ts.net',
          deviceId: 'client1',
          serverKey: FAKE_SERVER_PUBLIC,
          state: 'approved',
          requestedAt: 'now',
        },
      ],
    }),
  );
  links = [];
  refusal = null;
  openOnRequest = 0;
  connectOutcomes = [];
  tailscale = [];
  ready = 0;
  lost = 0;
  errors = [];
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (_file: string, args: string[]) => {
      tailscale.push(args);
      return TAILSCALE_STATUS;
    },
  });
  vi.spyOn(BuildConnection, 'open').mockImplementation(async () => {
    const outcome = connectOutcomes.shift();
    if (outcome) return outcome;
    const link = fakeLink();
    links.push(link);
    return link.connection;
  });
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
  vi.restoreAllMocks();
  resetExecutor();
  metro.closeAllConnections();
  await new Promise<void>((resolve) => metro.close(() => resolve()));
  delete process.env.STIM_HOME;
  rmSync(dir, { recursive: true, force: true });
});

test('offers four idle links for the session, reports ready once the host holds one, and reads Tailscale once', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  expect(links).toHaveLength(4);
  for (const link of links) expect(link.requests).toEqual([{ method: 'device-host.metro.link', params: { session } }]);
  links[0]?.open();
  await vi.waitFor(() => expect(links).toHaveLength(5));
  expect(tailscale).toEqual([['status', '--json']]);
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
  expect(link.closeCode).toBe(1000);
  expect(links.slice(1).every((each) => !each.closed)).toBe(true);
  expect(lost).toBe(0);
});

test('idle links drop on silence, but a carrying link does not, since its own queued sends delay the pongs', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  expect(links.every((link) => link.watched)).toBe(true);
  links[0]?.open();
  await vi.waitFor(() => expect(links).toHaveLength(5));
  await vi.waitFor(() => expect(links.map((link) => link.watched)).toEqual([false, true, true, true, true]));
});

test('refills links the host opened before their registration reply arrived', async () => {
  openOnRequest = 4;
  start();
  await vi.waitFor(() => expect(links).toHaveLength(8));
  expect(links.slice(4).every((link) => link.requests.length === 1 && !link.closed)).toBe(true);
});

test('retries a connect that timed out without reporting it or diagnosing the network', async () => {
  connectOutcomes = [SILENT];
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  expect(errors).toEqual([]);
  await vi.waitFor(() => expect(links).toHaveLength(4), { timeout: 3000 });
  expect(tailscale.filter((args) => args[0] !== 'status')).toEqual([]);
});

test('keeps retrying when every first link times out, and links once the host answers', async () => {
  connectOutcomes = [SILENT, SILENT, SILENT, SILENT];
  start();
  await vi.waitFor(() => expect(ready).toBe(1), { timeout: 3000 });
  expect(errors).toEqual([]);
});

test('reports a hosting refusal at once and stops opening links', async () => {
  connectOutcomes = [
    { failure: 'This machine has not approved this client for device-host.', refused: true, code: 'forbidden' },
  ];
  start();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(errors[0]).toContain('mini refused this machine: This machine has not approved this client for device-host');
  await vi.waitFor(() => expect(links.every((link) => link.closed)).toBe(true));
  const opened = vi.mocked(BuildConnection.open).mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(vi.mocked(BuildConnection.open).mock.calls.length).toBe(opened);
  expect(ready).toBe(0);
});

test('reports a refusal before any link is ready and offers no link', async () => {
  refusal = 'Current device-host approval is required.';
  start();
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
  expect(errors[0]).toContain('Current device-host approval is required.');
  expect(ready).toBe(0);
  expect(links.every((link) => link.closed)).toBe(true);
});

test('reports the links lost when the host drops all of them, then ready again once it takes new ones', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  connectOutcomes = [
    { failure: 'connect ECONNREFUSED 100.64.0.7:7443', refused: false, transport: { kind: 'refused' } },
  ];
  for (const link of links.slice(0, 4)) link.drop(1006);
  expect(lost).toBe(1);
  await vi.waitFor(() => expect(ready).toBe(2), { timeout: 3000 });
  await vi.waitFor(() => expect(links.slice(4).filter((link) => !link.closed)).toHaveLength(4), { timeout: 3000 });
  expect(errors).toEqual([]);
});

test('after the host held links, a refusal while its session is not attached again is retried until it links', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  refusal = 'Only a ready session attached to this owner can link Metro.';
  for (const link of links.slice(0, 4)) link.drop(1006);
  expect(lost).toBe(1);
  await vi.waitFor(() => expect(links.length).toBeGreaterThan(8), { timeout: 3000 });
  refusal = null;
  await vi.waitFor(() => expect(ready).toBe(2), { timeout: 5000 });
  expect(errors).toEqual([]);
});

test('a host that turns this machine away after it held links stops the pool instead of retrying', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  connectOutcomes = Array.from({ length: 8 }, () => ({
    failure: 'This machine has not approved this client for device-host.',
    refused: true,
    code: 'forbidden',
  }));
  for (const link of links.slice(0, 4)) link.drop(4401);
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(errors[0]).toContain('mini refused this machine');
  const opened = vi.mocked(BuildConnection.open).mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(vi.mocked(BuildConnection.open).mock.calls.length).toBe(opened);
});

test('retries while Tailscale cannot name the host and links once it can', async () => {
  let statusReads = 0;
  setExecutor({
    ...getExecutor(),
    runFileAsync: async () =>
      statusReads++ === 0 ? JSON.stringify({ BackendState: 'Running', Peer: {} }) : TAILSCALE_STATUS,
  });
  start();
  await vi.waitFor(() => expect(ready).toBe(1), { timeout: 3000 });
  expect(errors).toEqual([]);
  expect(statusReads).toBe(2);
});

test('stops reading the link while loopback Metro is not reading, and resumes when it drains', async () => {
  const received: Buffer[] = [];
  const accepted: Socket[] = [];
  const slow = createNetServer((socket) => {
    accepted.push(socket);
    socket.pause();
    socket.on('data', (chunk: Buffer) => received.push(chunk));
  });
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  metroPort = (slow.address() as AddressInfo).port;
  try {
    start();
    await vi.waitFor(() => expect(ready).toBe(1));
    const [link] = links;
    assert(link);
    link.open();
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    const frame = Buffer.alloc(32 * 1024, 9);
    let fed = 0;
    while (!link.paused && fed < 64 * 1024 * 1024) {
      link.receive(frame);
      fed += frame.length;
      await setImmediate();
    }
    expect(link.paused).toBe(true);
    expect(fed).toBeLessThan(16 * 1024 * 1024);
    accepted[0]?.resume();
    await vi.waitFor(() => expect(link.resumed).toBe(1));
    await vi.waitFor(() => expect(Buffer.concat(received).length).toBe(fed));
  } finally {
    pool?.close();
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  }
});

test('a link the host ends cleanly ends Metro, and one the host resets resets Metro', async () => {
  const ends: string[] = [];
  const recorder = createNetServer((socket) => {
    socket.once('end', () => ends.push('end'));
    socket.once('error', (error: NodeJS.ErrnoException) => ends.push(error.code ?? 'error'));
  });
  await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve));
  metroPort = (recorder.address() as AddressInfo).port;
  try {
    start();
    await vi.waitFor(() => expect(ready).toBe(1));
    const [clean, reset] = links;
    assert(clean && reset);
    clean.open();
    reset.open();
    await vi.waitFor(() => expect(links).toHaveLength(6));
    clean.drop(1000);
    reset.drop(4410);
    await vi.waitFor(() => expect(ends.toSorted()).toEqual(['ECONNRESET', 'end']));
  } finally {
    pool?.close();
    await new Promise<void>((resolve) => recorder.close(() => resolve()));
  }
});

test('a link whose loopback Metro refuses the connection closes with a reset code', async () => {
  const closedPort = createNetServer();
  await new Promise<void>((resolve) => closedPort.listen(0, '127.0.0.1', resolve));
  metroPort = (closedPort.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closedPort.close(() => resolve()));
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  const [link] = links;
  assert(link);
  link.open();
  await vi.waitFor(() => expect(link.closeCode).toBe(4410));
});

test('closing the pool ends idle and carrying links', async () => {
  start();
  await vi.waitFor(() => expect(ready).toBe(1));
  links[0]?.open();
  await vi.waitFor(() => expect(links).toHaveLength(5));
  pool?.close();
  await vi.waitFor(() => expect(links.every((link) => link.closed)).toBe(true));
});
