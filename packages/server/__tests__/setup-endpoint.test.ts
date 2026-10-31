import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SetupJournal } from '@stim-cli/core/state';
import { startServer, type RunningServer } from '../src/server.ts';
import { writeSetupJournal } from '../src/setup-journal.ts';
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
