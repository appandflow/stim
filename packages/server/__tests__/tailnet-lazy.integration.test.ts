import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTailscale } from '@stim-cli/transport-tailscale';
import { serve, type NetThread } from '../src/cli.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { createTailnet } from '../src/tailnet-helper.ts';

const toolchain: { env: NodeJS.ProcessEnv } = vi.hoisted(() => ({ env: {} }));

vi.mock('@stim-cli/core/toolchain', () => ({
  discoverToolchain: () => ({ env: { ...toolchain.env }, entries: [] }),
}));
vi.mock('../src/service-manager.ts', async (original) => ({
  ...(await original<typeof import('../src/service-manager.ts')>()),
  serviceManagerOrNull: () => null,
}));

const fakeTailscale = (log: string) => `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2).join(' ');
if (args === 'status --json') {
  console.log(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['::1'], Self: { DNSName: 'fake.tail.ts.net.', HostName: 'fake-mac' } }));
} else if (args === 'serve status --json') {
  console.log('{}');
} else {
  process.exit(1);
}
`;

let home: string;
let server: RunningServer | null = null;
let thread: NetThread | null = null;
let saved: NodeJS.ProcessEnv;

let state: string;

beforeEach(() => {
  saved = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'stim-tailnet-lazy-'));
  state = join(home, 'state');
  process.env.STIM_HOME = state;
});

afterEach(async () => {
  await server?.close();
  await thread?.close();
  server = thread = null;
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

function fakeBin(): { bin: string; calls: () => string[] } {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const log = join(home, 'tailscale.log');
  writeFileSync(join(bin, 'tailscale'), fakeTailscale(log));
  chmodSync(join(bin, 'tailscale'), 0o755);
  expect(findTailscale({ PATH: bin })).toBe(join(bin, 'tailscale'));
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('a request tailscale serve forwarded loads the transport for this run, and the server then listens on its addresses', async () => {
  const { bin } = fakeBin();
  const env = { PATH: bin, STIM_HOME: state };
  const tailnet = createTailnet(env);
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli: 'unused',
    name: () => tailnet.hostName(),
    stimVersion: '9.9.9',
    serverVersion: '1.2.3',
    env,
    transports: [],
    tailnet,
    record: false,
    history: false,
    statusAtBoot: false,
    pushEndpoint: 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
  });
  await server.ready;
  const port = server.addresses[0]?.port;
  const session = '11111111-1111-4111-8111-111111111111';
  await fetch(`http://127.0.0.1:${port}/device-host/agent/${session}/rpc`, {
    method: 'POST',
    body: '{}',
    headers: { 'x-forwarded-for': '100.64.0.2', authorization: 'Bearer nothing' },
  });
  expect(tailnet.current()).not.toBeNull();
  await vi.waitFor(() => expect(server?.addresses).toContainEqual({ host: '::1', port }));
  expect(existsSync(join(state, 'server', 'tailnet.json'))).toBe(false);
});

test('serve loads the transport at start for a home with the tailnet marker and listens on its addresses', async () => {
  const { bin, calls } = fakeBin();
  toolchain.env = { PATH: bin, STIM_HOME: state };
  delete process.env.XPC_SERVICE_NAME;
  mkdirSync(join(state, 'server'), { recursive: true });
  writeFileSync(join(state, 'server', 'tailnet.json'), '{}');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  thread = await serve(
    {
      port: 0,
      extraEnv: [],
      pathPrepend: [],
      loopbackOnly: false,
      shareOnly: false,
      desktopKey: Buffer.alloc(32, 7).toString('base64url'),
      script: 'unused',
    },
    () => {},
  );
  const port = thread.server.addresses[0]?.port;
  await vi.waitFor(() => expect(thread?.server.addresses).toContainEqual({ host: '::1', port }));
  expect(calls()).toContain('status --json');
});

test('a server nothing asked to use the tailnet runs Tailscale only for /health, at most twice per 30 seconds', async () => {
  const { bin, calls } = fakeBin();
  const env = { PATH: bin, STIM_HOME: state };
  const tailnet = createTailnet(env);
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli: 'unused',
    name: () => tailnet.hostName(),
    stimVersion: '9.9.9',
    serverVersion: '1.2.3',
    env,
    transports: [],
    tailnet,
    record: false,
    history: false,
    statusAtBoot: false,
    pushEndpoint: 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
  });
  await server.ready;
  expect(calls()).toEqual([]);

  const port = server.addresses[0]?.port;
  const bodies = [];
  for (let i = 0; i < 10; i++) bodies.push(await (await fetch(`http://127.0.0.1:${port}/health`)).json());
  expect(calls()).toEqual(['status --json', 'serve status --json']);
  expect(bodies.at(-1)).toMatchObject({
    name: 'fake-mac',
    tailscale: { state: 'running', dnsName: 'fake.tail.ts.net' },
    route: { state: 'missing' },
  });
  expect(existsSync(join(state, 'server', 'tailnet.json'))).toBe(false);
  expect(tailnet.current()).toBeNull();
});
