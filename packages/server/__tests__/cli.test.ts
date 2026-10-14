import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateNoiseKeyPair, type NoiseKeyPair } from '@stim-cli/core/noise';
import { decodeSecret, keyFingerprint, secretValues } from '@stim-cli/core/noise-session';
import { createPairingToken, readDevices, serverIdentity, spendSecret } from '../src/registry.ts';
import { setupClient } from './noise-client.ts';

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

function spend(token: string, name: string, keyPair: NoiseKeyPair = generateNoiseKeyPair()) {
  const lookup = secretValues(decodeSecret(token)!).lookup.toString('hex');
  return spendSecret(lookup, keyPair.publicKey.toString('base64url'), name, 'test');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-server-cli-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test.each([
  ['3', ''],
  ['0', ''],
  ['0', 'private-invalid-key'],
  ['0', 'x'.repeat(45)],
])('marked private bootstrap refuses invalid fd %s or input before serving', (fd, input) => {
  const result = spawnSync(process.execPath, [BIN, '--port', '0', '--loopback-only'], {
    env: { ...process.env, STIM_HOME: home, STIM_DESKTOP_BOOTSTRAP_FD: fd, PATH: '' },
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('stim-server: Desktop bootstrap input is invalid or unavailable.\n');
});

describe('--json', () => {
  it('pair prints the QR payload with the server key fingerprint and its expiry', () => {
    const output = run('pair', '--json', '--port', '17787') as { qr: Record<string, unknown>; expiresAt: string };
    expect(Object.keys(output.qr).toSorted()).toEqual(['endpoint', 'fingerprint', 'name', 'pairingToken', 'v']);
    expect(output.qr.v).toBe(2);
    expect(output.qr.fingerprint).toBe(keyFingerprint(serverIdentity().publicKey));
    expect(Date.parse(output.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('devices lists paired devices by key fingerprint, without their public keys', () => {
    const keyPair = generateNoiseKeyPair();
    spend(createPairingToken().token, 'Phone', keyPair);
    const { devices } = run('devices', '--json') as { devices: Record<string, unknown>[] };
    expect(devices).toHaveLength(1);
    expect(Object.keys(devices[0]!).toSorted()).toEqual([
      'capabilities',
      'from',
      'id',
      'keyFingerprint',
      'lastSeenAt',
      'name',
      'pairedAt',
    ]);
    expect(devices[0]).toMatchObject({ name: 'Phone', keyFingerprint: keyFingerprint(keyPair.publicKey) });
  });
});

describe('control', () => {
  function plain(...args: string[]) {
    return spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, STIM_HOME: home, PATH: '' },
      encoding: 'utf8',
    });
  }

  it('pair --control pairs a device that can run actions; devices grant changes it from the machine', () => {
    const { qr } = run('pair', '--json', '--port', '17787') as { qr: { pairingToken: string } };
    const control = run('pair', '--control', '--json', '--port', '17787') as { qr: { pairingToken: string } };
    spend(qr.pairingToken, 'Reader');
    spend(control.qr.pairingToken, 'Controller');
    const [reader, controller] = readDevices();
    expect(reader!.capabilities).toEqual(['read']);
    expect(controller!.capabilities).toEqual(['read', 'control']);

    expect(plain('devices', 'grant', reader!.id, '--control').status).toBe(0);
    expect(plain('devices', 'grant', controller!.id, '--read').status).toBe(0);
    expect(readDevices().map((device) => device.capabilities)).toEqual([['read', 'control'], ['read']]);

    expect(plain('devices', 'grant', reader!.id).status).toBe(1);
    expect(plain('devices', 'grant', reader!.id, '--read', '--control').status).toBe(1);
    expect(plain('devices', 'grant', 'nope', '--read').stderr).toContain('no paired device or approved client nope');
    expect(plain('devices', '--control').status).toBe(1);
  }, 20_000);
});

describe.each(['build', 'device-host'] as const)('%s approval', (capability) => {
  function plain(...args: string[]) {
    return spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, STIM_HOME: home, PATH: '' },
      encoding: 'utf8',
    });
  }

  it('grants access only through setup, never through pair or devices grant', () => {
    const result = plain('pair', `--${capability}`, '--port', '17787');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--${capability} applies only to \`stim-server setup\``);
    expect(readdirSync(home)).not.toContain('server');
    const id = setupClient([capability]).records[capability]!.id;
    const granted = plain('devices', 'grant', id, `--${capability}`);
    expect(granted.status).toBe(1);
    expect(granted.stderr).toContain('stim-server setup');
    expect(plain('devices', 'grant', id, '--control').status).toBe(1);
    expect(plain('devices', 'revoke', id).status).toBe(0);
    expect((run('devices', '--json') as { devices: unknown[] }).devices).toEqual([]);
  }, 20_000);
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
