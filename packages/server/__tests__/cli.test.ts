import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairingToken, spendPairingToken } from '../src/registry.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'stim-server.ts');

let home: string;

function run(...args: string[]): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, STIM_HOME: home, PATH: '' },
      encoding: 'utf8',
    }),
  );
}

const DNS = 'mac.tail1.ts.net';

const FAKE_TAILSCALE = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'status --json') {
  console.log(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.1'], Self: { DNSName: '${DNS}.', HostName: 'mac' } }));
} else if (args === 'serve status --json') {
  console.log(process.env.FAKE_SERVE_STATUS);
} else {
  process.exit(1);
}
`;

function serveConfig(routes: Record<number, string>, funneled: number[] = []): string {
  return JSON.stringify({
    TCP: Object.fromEntries(Object.keys(routes).map((port) => [port, { HTTPS: true }])),
    Web: Object.fromEntries(
      Object.entries(routes).map(([port, target]) => [`${DNS}:${port}`, { Handlers: { '/': { Proxy: target } } }]),
    ),
    AllowFunnel: Object.fromEntries(funneled.map((port) => [`${DNS}:${port}`, true])),
  });
}

// The fake tailscale is a script with a shebang, which Windows cannot execute.
const withTailscale = describe.skipIf(process.platform === 'win32');

function pairWith(serveStatus: string) {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tailscale'), FAKE_TAILSCALE);
  chmodSync(join(bin, 'tailscale'), 0o755);
  const result = spawnSync(process.execPath, [BIN, 'pair', '--port', '7787'], {
    env: { ...process.env, STIM_HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_SERVE_STATUS: serveStatus },
    encoding: 'utf8',
  });
  const endpoint = result.status === 0 ? (JSON.parse(result.stdout) as { endpoint: string }).endpoint : null;
  return { status: result.status, endpoint, stderr: result.stderr };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-server-cli-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('--json', () => {
  it('pair prints the QR payload with its expiry', () => {
    const output = run('pair', '--json', '--port', '17787') as { qr: Record<string, unknown>; expiresAt: string };
    expect(Object.keys(output.qr).toSorted()).toEqual(['endpoint', 'name', 'pairingToken', 'v']);
    expect(output.qr.v).toBe(1);
    expect(Date.parse(output.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('devices lists paired devices without their token hashes', () => {
    spendPairingToken(createPairingToken().token, 'Phone', { kind: 'local' });
    const { devices } = run('devices', '--json') as { devices: Record<string, unknown>[] };
    expect(devices).toHaveLength(1);
    expect(Object.keys(devices[0]!).toSorted()).toEqual([
      'capabilities',
      'id',
      'identity',
      'lastSeenAt',
      'name',
      'pairedAt',
    ]);
    expect(devices[0]!.name).toBe('Phone');
  });
});

withTailscale('pair with Tailscale running', () => {
  const gmailFunnel = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { [`${DNS}:443`]: { Handlers: { '/hook': { Proxy: 'http://127.0.0.1:8788' } } } },
    AllowFunnel: { [`${DNS}:443`]: true },
  });

  it('assumes port 7443 without a route and never suggests the funneled port', () => {
    const { endpoint, stderr } = pairWith(gmailFunnel);
    expect(endpoint).toBe(`wss://${DNS}:7443`);
    expect(stderr).toContain('`tailscale serve --bg --https=7443 http://127.0.0.1:7787`');
    expect(stderr).not.toContain('--https=443');
  });

  it('omits the port for a route on 443', () => {
    expect(pairWith(serveConfig({ 443: 'http://127.0.0.1:7787' })).endpoint).toBe(`wss://${DNS}`);
  });

  it('uses a tailnet-only route on 7443 next to a funneled port serving another app', () => {
    const config = JSON.parse(serveConfig({ 443: 'http://127.0.0.1:8788', 7443: 'http://127.0.0.1:7787' }, [443]));
    const { endpoint, stderr } = pairWith(JSON.stringify(config));
    expect(endpoint).toBe(`wss://${DNS}:7443`);
    expect(stderr).not.toContain('tailscale serve --bg');
  });

  const pathMount = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { [`${DNS}:443`]: { Handlers: { '/stim': { Proxy: 'http://127.0.0.1:7787' } } } },
    AllowFunnel: { [`${DNS}:443`]: true },
  });
  const tcpForward = JSON.stringify({
    TCP: { '443': { TCPForward: '127.0.0.1:7787' } },
    AllowFunnel: { [`${DNS}:443`]: true },
  });
  it.each([
    ['a / route', serveConfig({ 443: 'http://127.0.0.1:7787', 8443: 'http://localhost:7787' }, [443])],
    ['a path mount', pathMount],
    ['a TCP forward', tcpForward],
  ])('refuses to pair when %s to the server is funneled, and creates no token', (_, config) => {
    const { status, stderr } = pairWith(config);
    expect(status).toBe(1);
    expect(stderr).toContain('Funnel is on for port 443');
    expect(stderr).toContain('--https=7443');
    expect(readdirSync(home)).not.toContain('server');
  });
});
