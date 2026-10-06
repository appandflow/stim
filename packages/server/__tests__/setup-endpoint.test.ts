import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { readSetupJournal, setupJournalFile, type SetupJournal } from '@stim-cli/core/state';
import { readBuildClients, readDeviceHostClients } from '../src/registry.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { writeSetupJournal } from '../src/setup-journal.ts';
import { probeDirectories } from '../src/startup.ts';
import { whois } from '../src/tailscale.ts';

vi.mock('../src/tailscale.ts', async (original) => ({
  ...(await original<typeof import('../src/tailscale.ts')>()),
  whois: vi.fn<typeof import('../src/tailscale.ts').whois>(),
}));
vi.mock('../src/startup.ts', async (original) => {
  const actual = await original<typeof import('../src/startup.ts')>();
  return { ...actual, probeDirectories: vi.fn<typeof actual.probeDirectories>(actual.probeDirectories) };
});

let home: string;
let server: RunningServer | null;
const hash = 'a'.repeat(64);
const peer = '100.64.0.2';
const headers = { 'x-forwarded-for': peer };
const identity = { kind: 'tailnet' as const, nodeId: 'nClient', nodeName: 'client.ts.net', user: 'u' };

function journal(): SetupJournal {
  return {
    v: 1,
    client: { nodeId: 'nClient' },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    capabilities: ['build', 'device-host'],
    steps: [
      { id: 'route', state: 'ok', title: 'Tailnet route' },
      { id: 'tools.xcode', state: 'ok', title: 'Xcode', detail: '27.0' },
    ],
    granted: [],
    done: false,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-setup-http-'));
  process.env.STIM_HOME = home;
  server = null;
  vi.mocked(whois)
    .mockReset()
    .mockImplementation(async (_binary, _env, address) => (address === peer ? identity : null));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function start(wait = true): Promise<string> {
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli: join(home, 'unused.mjs'),
    name: 'Test Mac',
    stimVersion: '1.2.3',
    serverVersion: '1.2.3',
    tailscale: null,
    tailscaleState: { state: 'not-running', backendState: 'Stopped' },
    env: process.env,
    record: false,
    history: false,
    frameHelper: null,
    pullRequests: async () => new Map(),
  });
  if (wait) await server.ready;
  return `http://127.0.0.1:${server.addresses[0]!.port}`;
}

async function refusal(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    type: response.headers.get('content-type'),
    cache: response.headers.get('cache-control'),
  };
}

const notFound = { status: 404, body: 'Not found.\n', type: 'text/plain', cache: 'no-store' };

test('rejects unsafe methods, browser headers, invalid peers and malformed paths without reading a journal or calling whois', async () => {
  const base = await start();
  writeSetupJournal(hash, journal());
  const read = vi.spyOn(await import('@stim-cli/core/state'), 'readSetupJournal');
  for (const options of [
    {},
    { headers: { 'x-forwarded-for': '127.0.0.1' } },
    { headers: { 'x-forwarded-for': 'not-an-ip' } },
    { headers: { ...headers, origin: 'https://example.com' } },
    { headers: { ...headers, 'sec-fetch-site': 'same-origin' } },
    { method: 'POST', headers },
    { method: 'PUT', headers },
  ])
    expect(await refusal(await fetch(`${base}/setup/${hash}`, options))).toEqual(notFound);
  for (const path of [
    '/setup/',
    `/setup/${hash.toUpperCase()}`,
    `/setup/${hash}0`,
    `/setup/${hash}/`,
    `/setup/${hash}?x=1`,
    '/setup/not-a-hash',
  ]) {
    expect(await refusal(await fetch(`${base}${path}`, { headers }))).toEqual(notFound);
  }
  expect(read).not.toHaveBeenCalled();
  expect(whois).not.toHaveBeenCalled();
});

test('checks journal existence, validity and expiry before whois and gives all unavailable hashes the same refusal', async () => {
  const base = await start();
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
  writeSetupJournal(hash, { ...journal(), expiresAt: new Date(Date.now() - 1).toISOString() });
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
  writeFileSync(setupJournalFile(hash)!, '{');
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
  expect(whois).not.toHaveBeenCalled();
});

test('serves only the bound node and exposes toolchain steps only after a build grant', async () => {
  const base = await start();
  const pending = journal();
  writeSetupJournal(hash, pending);
  vi.mocked(whois).mockResolvedValueOnce({ ...identity, nodeId: 'other' });
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers: { 'x-forwarded-for': '100.64.0.3' } }))).toEqual(
    notFound,
  );
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers: { 'x-forwarded-for': '192.0.2.1' } }))).toEqual(
    notFound,
  );
  const response = await fetch(`${base}/setup/${hash}`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ ...pending, steps: [pending.steps[0]] });
  writeSetupJournal(hash, { ...pending, granted: [{ capability: 'device-host', id: 'host' }] });
  expect(await (await fetch(`${base}/setup/${hash}`, { headers })).json()).toMatchObject({ steps: [pending.steps[0]] });
  const granted = { ...pending, granted: [{ capability: 'build' as const, id: 'builder' }] };
  writeSetupJournal(hash, granted);
  expect(await (await fetch(`${base}/setup/${hash}`, { headers })).json()).toEqual(granted);
});

test('coalesces a peer burst into one whois call and refreshes its identity after thirty seconds', async () => {
  const base = await start();
  writeSetupJournal(hash, journal());
  vi.mocked(whois).mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return identity;
  });
  const now = Date.now();
  const date = vi.spyOn(Date, 'now').mockReturnValue(now);
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/setup/${hash}`, { headers })));
  expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
  await Promise.all(responses.map((response) => response.text()));
  expect(whois).toHaveBeenCalledTimes(1);
  date.mockReturnValue(now + 30_001);
  expect((await fetch(`${base}/setup/${hash}`, { headers })).status).toBe(200);
  expect(whois).toHaveBeenCalledTimes(2);
});

test('counts node mismatches as failures and blocks repeated identity attempts without revealing journal data', async () => {
  const base = await start();
  writeSetupJournal(hash, journal());
  vi.mocked(whois).mockResolvedValue({ ...identity, nodeId: 'other' });
  for (let i = 0; i < 30; i++) {
    expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
  }
  const blocked = await fetch(`${base}/setup/${hash}`, { headers });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('cache-control')).toBe('no-store');
  expect(await blocked.text()).not.toContain('nClient');
  expect(whois).toHaveBeenCalledTimes(1);
});

test('returns unavailable before startup is ready without reading journals or resolving peers', async () => {
  let release!: (reason: null) => void;
  vi.mocked(probeDirectories).mockReturnValueOnce({
    result: new Promise((resolve) => {
      release = resolve;
    }),
    cancel: () => release(null),
  });
  const base = await start(false);
  const response = await fetch(`${base}/setup/${hash}`, { headers });
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).toBe('stim-server is not ready.\n');
  expect(whois).not.toHaveBeenCalled();
  release(null);
  await server!.ready;
});

test('prunes retained journals as the server becomes ready', async () => {
  const stale = { ...journal(), expiresAt: new Date(Date.now() - 60 * 60_000 - 1000).toISOString() };
  writeSetupJournal(hash, stale);
  await start();
  expect(readSetupJournal(hash)).toBeNull();
});

test.each(['build', 'device-host'] as const)(
  'carries the optional ticket from a %s hello into its pending registry binding',
  async (capability) => {
    const base = await start();
    const ticket = 'a'.repeat(43);
    const socket = new WebSocket(base.replace('http:', 'ws:'), { headers });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const reply = new Promise<string>((resolve) => socket.once('message', (data) => resolve(data.toString())));
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'hello',
          params: {
            protocol: 1,
            client: { name: 'Test', version: '1' },
            auth: { request: capability, deviceName: 'Laptop', setupTicket: ticket },
          },
        }),
      );
      expect(JSON.parse(await reply)).toMatchObject({ result: { approval: { state: 'pending' }, capabilities: [] } });
      const records = capability === 'build' ? readBuildClients() : readDeviceHostClients();
      expect(records[0]).toHaveProperty('setupTicketHash', createHash('sha256').update(ticket).digest('hex'));
    } finally {
      socket.terminate();
    }
  },
);
