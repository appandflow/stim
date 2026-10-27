import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupJournal, setupJournalFile, type SetupJournal } from '@stim-cli/core/state';
import { startServer, type RunningServer } from '../src/server.ts';
import { writeSetupJournal } from '../src/setup-journal.ts';
import { probeDirectories } from '../src/startup.ts';
import { tailscaleTransport } from '@stim-cli/transport-tailscale';

vi.mock('../src/startup.ts', async (original) => {
  const actual = await original<typeof import('../src/startup.ts')>();
  return { ...actual, probeDirectories: vi.fn<typeof actual.probeDirectories>(actual.probeDirectories) };
});

let home: string;
let server: RunningServer | null;
const hash = 'a'.repeat(64);
const peer = '100.64.0.2';
const headers = { 'x-forwarded-for': peer };

function journal(): SetupJournal {
  return {
    v: 1,
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function start(wait = true): Promise<string> {
  server = await startServer({
    hostsDevices: true,
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli: join(home, 'unused.mjs'),
    name: 'Test Mac',
    stimVersion: '1.2.3',
    serverVersion: '1.2.3',
    transports: [
      tailscaleTransport({
        env: process.env,
        snapshot: { binary: null, state: { state: 'not-running', backendState: 'Stopped' } },
      }),
    ],
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

test('rejects unsafe methods, browser headers and malformed paths without reading a journal', async () => {
  const base = await start();
  writeSetupJournal(hash, journal());
  const read = vi.spyOn(await import('@stim-cli/core/state'), 'readSetupJournal');
  for (const options of [
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
});

test('gives missing, expired and corrupt journals the same refusal', async () => {
  const base = await start();
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
  writeSetupJournal(hash, { ...journal(), expiresAt: new Date(Date.now() - 1).toISOString() });
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
  writeFileSync(setupJournalFile(hash)!, '{');
  expect(await refusal(await fetch(`${base}/setup/${hash}`, { headers }))).toEqual(notFound);
});

test('serves a named journal to any peer with toolchain steps hidden', async () => {
  const base = await start();
  const pending = journal();
  writeSetupJournal(hash, pending);
  for (const peerHeaders of [headers, {}]) {
    const response = await fetch(`${base}/setup/${hash}`, { headers: peerHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ...pending, steps: [pending.steps[0]] });
  }
});

test('blocks a peer after repeated misses, even for a journal that exists, without blocking other peers', async () => {
  const base = await start();
  writeSetupJournal(hash, journal());
  for (let i = 0; i < 30; i++)
    expect(await refusal(await fetch(`${base}/setup/${'b'.repeat(64)}`, { headers }))).toEqual(notFound);
  const blocked = await fetch(`${base}/setup/${hash}`, { headers });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('cache-control')).toBe('no-store');
  expect(await blocked.text()).not.toContain('Xcode');
  expect((await fetch(`${base}/setup/${hash}`, { headers: { 'x-forwarded-for': '100.64.0.3' } })).status).toBe(200);
});

test('returns unavailable before startup is ready', async () => {
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
  release(null);
  await server!.ready;
});

test('prunes retained journals as the server becomes ready', async () => {
  const stale = { ...journal(), expiresAt: new Date(Date.now() - 60 * 60_000 - 1000).toISOString() };
  writeSetupJournal(hash, stale);
  await start();
  expect(readSetupJournal(hash)).toBeNull();
});
