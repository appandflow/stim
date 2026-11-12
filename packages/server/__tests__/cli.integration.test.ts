import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateNoiseKeyPair, type NoiseKeyPair } from '@stim-cli/core/noise';
import { decodeSecret, keyFingerprint, secretValues } from '@stim-cli/core/noise-session';
import { createPairingToken, readDevices, serverIdentity, spendSecret, touchDevice } from '../src/registry.ts';
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

function pairWith(serveStatus: string, ...args: string[]) {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tailscale'), FAKE_TAILSCALE);
  chmodSync(join(bin, 'tailscale'), 0o755);
  const result = spawnSync(process.execPath, [BIN, 'pair', '--port', '7787', ...args], {
    env: { ...process.env, STIM_HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_SERVE_STATUS: serveStatus },
    encoding: 'utf8',
  });
  const printed = result.status === 0 ? JSON.parse(result.stdout) : null;
  const endpoint: string | null = printed ? (printed.qr ?? printed).endpoint : null;
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

test.skipIf(process.platform === 'win32')(
  'a port another process holds is refused with that pid and the remedy',
  async () => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const { port } = holder.address() as { port: number };
    try {
      const result = spawnSync(process.execPath, [BIN, '--port', String(port), '--loopback-only'], {
        env: { ...process.env, STIM_HOME: home },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `stim-server: port ${port} is held by pid ${process.pid}; stop it (kill ${process.pid}), or run stim serve --port <n>.\n`,
      );
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  },
);

describe('--json', () => {
  it('pair prints the QR payload with the server key fingerprint and its expiry', () => {
    const output = run('pair', '--json', '--port', '17787') as { qr: Record<string, unknown>; expiresAt: string };
    expect(Object.keys(output.qr).toSorted()).toEqual(['endpoint', 'fingerprint', 'name', 'pairingToken', 'v']);
    expect(output.qr.v).toBe(2);
    expect(output.qr.fingerprint).toBe(keyFingerprint(serverIdentity().publicKey));
    expect(Date.parse(output.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('devices lists each record with its kind, access and owner, by key fingerprint, without public keys', () => {
    const phoneKey = generateNoiseKeyPair();
    spend(createPairingToken(Date.now(), ['read', 'control']).token, 'Phone', phoneKey);
    const machine = setupClient(['build', 'device-host'], 'Laptop');
    const { devices } = run('devices', '--json') as { devices: Record<string, unknown>[] };
    const machineKey = keyFingerprint(machine.keyPair.publicKey);
    const shape = ({ id, pairedAt, lastSeenAt, ...rest }: Record<string, unknown>) => {
      expect(typeof id).toBe('string');
      expect(Date.parse(String(pairedAt))).not.toBeNaN();
      expect(Date.parse(String(lastSeenAt))).not.toBeNaN();
      return rest;
    };
    const client = { name: 'Laptop', from: 'test', keyFingerprint: machineKey, owner: 'theirs-running-here' };
    expect(devices.map(shape)).toEqual([
      {
        name: 'Phone',
        from: 'test',
        keyFingerprint: keyFingerprint(phoneKey.publicKey),
        capabilities: ['read', 'control'],
        kind: 'phone',
        access: ['view', 'control'],
        owner: 'this-machine',
      },
      { ...client, capabilities: ['build'], kind: 'build-client', access: ['build'] },
      { ...client, capabilities: ['device-host'], kind: 'device-host-client', access: ['run-devices'] },
    ]);
  });

  it('devices lists the entries it cannot read beside the records, and an empty list when there are none', () => {
    spend(createPairingToken().token, 'Phone');
    expect(run('devices', '--json')).toMatchObject({ unreadable: [] });
    const file = join(home, 'server', 'devices.json');
    const [phone] = readDevices();
    assert(phone);
    writeFileSync(file, JSON.stringify({ version: 2, devices: [{ id: 'bad', name: 5 }, phone, 'opaque'] }));
    expect(run('devices', '--json')).toMatchObject({
      devices: [{ id: phone.id }],
      unreadable: [
        { file: 'devices.json', index: 0, id: 'bad' },
        { file: 'devices.json', index: 2 },
      ],
    });
  });

  it('devices lists a registry file that a newer Stim wrote as a whole, without reading its records', () => {
    spend(createPairingToken().token, 'Phone');
    writeFileSync(join(home, 'server', 'devices.json'), JSON.stringify({ version: 3, devices: [{ id: 'future' }] }));
    expect(run('devices', '--json')).toMatchObject({ devices: [], unreadable: [{ file: 'devices.json', version: 3 }] });
    const refused = spawnSync(process.execPath, [BIN, 'devices', 'revoke', 'nope'], {
      env: { ...process.env, STIM_HOME: home, PATH: '' },
      encoding: 'utf8',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('devices.json is registry version 3, written by a newer Stim');
  });

  it('devices reports Stim Desktop as desktop, any other or unrecorded app as phone, and the recorded app additively', () => {
    const desktop = spend(createPairingToken().token, 'Studio Mac')?.device;
    const phone = spend(createPairingToken().token, 'Phone')?.device;
    const legacy = spend(createPairingToken().token, 'Old phone')?.device;
    const machine = setupClient(['build'], 'Studio Mac');
    const build = machine.records.build;
    assert(desktop && phone && legacy && build);
    touchDevice(desktop.id, { name: 'Stim Desktop', version: '1.4.0' });
    touchDevice(phone.id, { name: 'stim-mobile', version: '0.9.0' });
    touchDevice(build.id, { name: 'Stim Desktop', version: '1.4.0' });
    expect(run('devices', '--json')).toMatchObject({
      devices: [
        {
          id: desktop.id,
          kind: 'desktop',
          clientApp: 'Stim Desktop',
          clientVersion: '1.4.0',
          access: ['view'],
          owner: 'this-machine',
          capabilities: ['read'],
        },
        { id: phone.id, kind: 'phone', clientApp: 'stim-mobile', clientVersion: '0.9.0' },
        { id: legacy.id, kind: 'phone' },
        { id: build.id, kind: 'build-client', clientApp: 'Stim Desktop' },
      ],
    });
    expect(readDevices().find((record) => record.id === legacy.id)).not.toHaveProperty('clientApp');
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

  it('devices rename renames a record and refuses an unknown id or an unprintable name', () => {
    const phone = spend(createPairingToken().token, 'Phone')?.device;
    assert(phone);
    expect(plain('devices', 'rename', phone.id, 'Kitchen iPad').stdout).toBe(`Renamed ${phone.id}.\n`);
    const unknown = plain('devices', 'rename', 'nope', 'Name');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no paired device or approved client nope');
    expect(plain('devices', 'rename', phone.id, 'two\nlines').status).toBe(1);
    expect(plain('devices', 'rename', phone.id).status).toBe(1);
    expect(readDevices()).toEqual([{ ...phone, name: 'Kitchen iPad' }]);
  }, 20_000);
});

describe('entries it cannot read', () => {
  it('stay as they are through a rename, and a rename, grant or revoke that names one is refused', () => {
    const phone = spend(createPairingToken().token, 'Phone')?.device;
    assert(phone);
    const file = join(home, 'server', 'devices.json');
    const bad = '{"id":"bad","name":5}';
    writeFileSync(file, `{"version":2,"devices":[${bad},${JSON.stringify(phone)}]}`);
    const plain = (...args: string[]) =>
      spawnSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, STIM_HOME: home, PATH: '' },
        encoding: 'utf8',
      });

    expect(plain('devices', 'rename', phone.id, 'Kitchen').status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain(bad);
    const before = readFileSync(file, 'utf8');
    for (const args of [
      ['devices', 'rename', 'bad', 'Name'],
      ['devices', 'grant', 'bad', '--control'],
      ['devices', 'revoke', 'bad'],
    ]) {
      const refused = plain(...args);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('bad is an entry of devices.json that this stim-server cannot read');
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(plain('devices').stdout).toContain('unreadable  devices.json entry 0  bad');
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
    expect(result.stderr).toContain(`--${capability} applies only to \`stim setup\``);
    expect(readdirSync(home)).not.toContain('server');
    const id = setupClient([capability]).records[capability]!.id;
    expect(plain('devices', 'rename', id, 'Renamed').status).toBe(0);
    const granted = plain('devices', 'grant', id, `--${capability}`);
    expect(granted.status).toBe(1);
    expect(granted.stderr).toContain('stim setup');
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

  it('pairs on the direct tailnet address without a route and never suggests the funneled port', () => {
    const { endpoint, stderr } = pairWith(gmailFunnel);
    expect(endpoint).toBe('ws://100.64.0.1:7787');
    expect(stderr).toContain('`tailscale serve --bg --https=7443 http://127.0.0.1:7787`');
    expect(stderr).not.toContain('--https=443');
  });

  it('pairs on the direct tailnet address when tailscale serve status cannot be read', () => {
    const { endpoint, stderr } = pairWith('not json');
    expect(endpoint).toBe('ws://100.64.0.1:7787');
    expect(stderr).toContain('tailnet address directly');
    expect(stderr).not.toContain('tailscale serve --bg');
  });

  it('--json prints the same endpoint and still explains it on stderr', () => {
    const { endpoint, stderr } = pairWith(gmailFunnel, '--json');
    expect(endpoint).toBe('ws://100.64.0.1:7787');
    expect(stderr).toContain('single use');
    expect(stderr).toContain('tailnet address directly');
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
