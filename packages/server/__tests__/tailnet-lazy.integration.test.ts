import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTailscale } from '@stim-cli/transport-tailscale';
import { startServer, type RunningServer } from '../src/server.ts';
import { createTailnet } from '../src/tailnet-helper.ts';

const fakeTailscale = (log: string) => `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2).join(' ');
if (args === 'status --json') {
  console.log(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.9'], Self: { DNSName: 'fake.tail.ts.net.', HostName: 'fake-mac' } }));
} else if (args === 'serve status --json') {
  console.log('{}');
} else {
  process.exit(1);
}
`;

let home: string;
let server: RunningServer | null = null;

let state: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-tailnet-lazy-'));
  state = join(home, 'state');
  process.env.STIM_HOME = state;
});

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('a server nothing asked to use the tailnet runs Tailscale only for /health, at most twice per 30 seconds', async () => {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const log = join(home, 'tailscale.log');
  writeFileSync(join(bin, 'tailscale'), fakeTailscale(log));
  chmodSync(join(bin, 'tailscale'), 0o755);
  const env = { PATH: bin, STIM_HOME: state };
  expect(findTailscale(env)).toBe(join(bin, 'tailscale'));
  const tailnet = createTailnet(env);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
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
