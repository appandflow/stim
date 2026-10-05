import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { WebSocketServer } from 'ws';
import { deviceHostMachinesFile, macosAppState, readMacosRecord } from '@stim-cli/core/state';
import macosCommand, { runMacos } from '../commands/macos.ts';
import { agentRemoteConfig } from '../device-host/hosted-macos.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { stopMacosApp } from '../macos/stop.ts';
import { getConfigPath } from '../workspace/config.ts';
import { workspaceInUse } from '../workspace/in-use.ts';

const tailnet = { port: 0, nodeId: 'nMini' };

vi.mock('../offload/tailnet.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../offload/tailnet.ts')>();
  return {
    ...actual,
    pinnedEndpoint: (credential: { machine: string; nodeId: string }) => {
      const status = {
        BackendState: 'Running',
        Peer: { mini: { ID: tailnet.nodeId, DNSName: 'mini.tail1.ts.net.', TailscaleIPs: ['100.64.0.7'] } },
      };
      const target = actual.pinnedEndpoint(credential, () => status);
      return typeof target === 'string'
        ? target
        : { url: `ws://127.0.0.1:${tailnet.port}`, servername: target.servername, host: target.host };
    },
  };
});

const TOKEN = 'device-token-never-printed';
const GRANT_TOKEN = 'g'.repeat(43);
const GRANT = {
  driver: 'agent-device',
  path: '/device-host/agent/12345678-1234-1234-1234-123456789abc/',
  token: GRANT_TOKEN,
  scope: 'lease-1',
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface FakeHost {
  methods: string[];
  blobs: Map<string, Buffer>;
  offers: Record<string, unknown>[];
  capabilities: string[];
  grant: unknown;
  installed: { state: string; launched: true | 'unverified' | null; notice?: string };
  stopSession: () => void;
  close: () => Promise<void>;
}

/** A hosting Mac that speaks the device-host contract for macOS sessions. */
async function fakeHost(): Promise<FakeHost> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((done) => server.once('listening', done));
  tailnet.port = (server.address() as AddressInfo).port;
  let session: Record<string, unknown> | null = null;
  let manifest: { sha256: string; size: number } | null = null;
  const partial = new Map<string, Buffer>();
  const host: FakeHost = {
    methods: [],
    blobs: new Map(),
    offers: [],
    capabilities: ['device-host'],
    grant: { driver: 'none' },
    installed: { state: 'installed', launched: true },
    stopSession: () => void (session = { ...session, state: 'stopped' }),
    close: () => new Promise((done) => server.close(() => done())),
  };
  const files = () =>
    host.blobs.has(manifest!.sha256)
      ? (JSON.parse(String(host.blobs.get(manifest!.sha256))) as { sha256: string; size: number }[])
      : [manifest!];
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const { id, method, params } = JSON.parse(String(data));
      host.methods.push(method);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id, result }));
      if (method === 'hello') {
        if (params.auth.deviceToken !== TOKEN)
          return socket.send(JSON.stringify({ id, error: { code: 'unauthorized', message: 'no' } }));
        return reply({ capabilities: host.capabilities, device: { id: 'client1', name: 'laptop' } });
      }
      if (method === 'device-host.reserve') {
        session = { id: randomUUID(), platform: 'macos', state: 'preparing', appSlot: 3, device: null, ...params };
        return reply(session);
      }
      if (method === 'device-host.attach') {
        if (session!.state === 'preparing')
          session = { ...session, state: 'ready', device: { architecture: 'arm64', macosVersion: '27.0', appSlot: 3 } };
        if (session!.state === 'stopping') session = { ...session, state: 'stopped' };
        return reply(session);
      }
      if (method === 'device-host.stop') {
        session = { id: params.session, platform: 'macos', appSlot: 3, ...session, state: 'stopping' };
        return reply(session);
      }
      const delivery = {
        session: params.session,
        attempt: params.attempt,
        bundleId: 'dev.fixture.app',
        mode: 'release',
      };
      if (method === 'device-host.app.offer') {
        host.offers.push(params);
        manifest = params.manifest;
        const missing = files()
          .filter((file) => !host.blobs.has(file.sha256))
          .map((file) => ({ sha256: file.sha256, size: file.size, offset: partial.get(file.sha256)?.length ?? 0 }));
        return reply({ delivery: { ...delivery, state: 'receiving', launched: null }, missing });
      }
      if (method === 'device-host.app.chunk') {
        const bytes = Buffer.concat([
          partial.get(params.sha256) ?? Buffer.alloc(0),
          Buffer.from(params.data, 'base64'),
        ]);
        partial.set(params.sha256, bytes);
        const size = files().find((file) => file.sha256 === params.sha256)!.size;
        if (bytes.length === size && sha256(bytes) === params.sha256) host.blobs.set(params.sha256, bytes);
        return reply({ offset: bytes.length });
      }
      if (method === 'device-host.app.launch') return reply({ ...delivery, state: 'installing', launched: null });
      if (method === 'device-host.app.attach') return reply({ ...delivery, ...host.installed, agent: host.grant });
      socket.send(JSON.stringify({ id, error: { code: 'unknown-method', message: method } }));
    });
  });
  return host;
}

let dir: string;
let root: string;
let bin: string;
let host: FakeHost;
let spawned: string[];

function credentials(state: 'approved' | 'pending' = 'approved') {
  const machine = { machine: 'mini', nodeId: 'nMini', dnsName: 'mini.tail1.ts.net', deviceId: 'client1' };
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({ version: 1, machines: [{ ...machine, deviceToken: TOKEN, state, requestedAt: 'now' }] }),
  );
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-hosted-macos-')));
  process.env.STIM_HOME = join(dir, 'home');
  mkdirSync(process.env.STIM_HOME);
  root = join(dir, 'app');
  bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(join(bin, 'Fixture.framework', 'Versions', 'A'), { recursive: true });
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ macos: { product: 'Fixture', infoPlist: 'Info.plist' } }));
  writeFileSync(join(root, 'Info.plist'), 'plist');
  writeFileSync(join(bin, 'Fixture'), Buffer.alloc(70 * 1024, 7));
  chmodSync(join(bin, 'Fixture'), 0o755);
  writeFileSync(join(bin, 'Fixture.framework', 'Versions', 'A', 'Fixture'), 'framework');
  symlinkSync('Versions/A/Fixture', join(bin, 'Fixture.framework', 'Fixture'));
  writeFileSync(getConfigPath(), JSON.stringify({ hosting: { machines: ['mini'] } }));
  credentials();
  tailnet.nodeId = 'nMini';
  host = await fakeHost();
  spawned = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    spawn: (cmd: string, args: string[], opts: object) => {
      spawned.push(cmd);
      if (cmd !== 'swift') throw new Error(`unexpected spawn ${cmd}`);
      const script = args.includes('--show-bin-path') ? `console.log(${JSON.stringify(bin)})` : '';
      return real.spawn(process.execPath, ['-e', script], opts);
    },
    runFile: (file: string, args: string[], opts?: object) => {
      if (file === 'plutil')
        return JSON.stringify({ CFBundleIdentifier: 'dev.fixture.app', CFBundleExecutable: 'Fixture' });
      if (file === 'otool') return '@executable_path/../Frameworks';
      if (['/usr/libexec/PlistBuddy', 'codesign', 'install_name_tool'].includes(file)) return '';
      return real.runFile(file, args, opts);
    },
  });
});

afterEach(async () => {
  resetExecutor();
  await host.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe.skipIf(process.platform !== 'darwin')('stim macos --host (SwiftPM and codesign run only on macOS)', () => {
  test('places the bundle on the host, records the session, and stop ends it there', async () => {
    host.grant = GRANT;
    const record = await runMacos(root, () => {}, 'mini');
    expect(host.methods.filter((method) => method === 'device-host.reserve')).toHaveLength(1);
    expect(host.offers[0]).toMatchObject({ bundleId: 'dev.fixture.app', mode: 'release' });
    expect(host.offers[0]).not.toHaveProperty('devClientScheme');
    const manifest = JSON.parse(String(host.blobs.get((host.offers[0]!.manifest as { sha256: string }).sha256)));
    expect(manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Contents/Info.plist', kind: 'file' }),
        expect.objectContaining({ path: 'Contents/MacOS/Fixture', kind: 'exec', size: 70 * 1024 }),
        expect.objectContaining({ path: 'Contents/Frameworks/Fixture.framework/Fixture', kind: 'link' }),
      ]),
    );
    for (const file of manifest) expect(host.blobs.has(file.sha256)).toBe(true);
    expect(record.host).toMatchObject({ machine: 'mini', appSlot: 3, bundleId: 'dev.fixture.app.hosted3' });
    expect(macosAppState(readMacosRecord(root))?.state).toBe('running');
    const config = agentRemoteConfig(root);
    expect(record.host?.agent).toEqual({
      driver: 'agent-device',
      remoteConfig: config,
      command: `agent-device <command> --remote-config ${config}`,
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      daemonBaseUrl: `https://mini.tail1.ts.net:7443${GRANT.path}`,
      daemonAuthToken: GRANT_TOKEN,
      leaseId: 'lease-1',
      platform: 'macos',
    });
    expect(workspaceInUse(root, { managedLocks: false, nativeRun: false })).toEqual(['its macOS app runs on mini']);
    expect(spawned.every((cmd) => cmd === 'swift')).toBe(true);

    await runMacos(root, () => {}, 'mini');
    expect(host.methods.filter((method) => method === 'device-host.reserve')).toHaveLength(1);
    expect(host.offers.at(-1)!.attempt).not.toBe(host.offers[0]!.attempt);

    await stopMacosApp(root);
    expect(host.methods).toContain('device-host.stop');
    expect(existsSync(config)).toBe(false);
    expect(readMacosRecord(root)?.host).toBeUndefined();
    expect(macosAppState(readMacosRecord(root))?.state).toBe('stopped');
  });

  test('--json prints one payload with the placement and never a token', async () => {
    host.grant = GRANT;
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const program = new Command();
      macosCommand(program);
      await program.parseAsync(['node', 'stim', 'macos', '--host', 'mini', '--json']);
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(Object.keys(payload).toSorted()).toEqual(['build', 'host', 'launchId', 'platform', 'product']);
    expect(payload.host).toMatchObject({ machine: 'mini', agent: { driver: 'agent-device' } });
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain(GRANT_TOKEN);
  });

  test.each([
    [
      'an unlisted machine',
      () => writeFileSync(getConfigPath(), JSON.stringify({ hosting: { machines: [] } })),
      'not in hosting.machines',
    ],
    ['an unapproved credential', () => credentials('pending'), 'has not confirmed hosting access'],
    ['a changed tailnet node', () => (tailnet.nodeId = 'nOther'), 'not the pinned nMini'],
    ['a host without hosting access', () => (host.capabilities = ['build']), 'not granted this Mac hosting access'],
  ])('refuses %s before building and never launches locally', async (_name, change, message) => {
    change();
    await expect(runMacos(root, () => {}, 'mini')).rejects.toThrow(message);
    expect(spawned).toEqual([]);
    expect(host.methods).not.toContain('device-host.reserve');
    expect(readMacosRecord(root)).toBeNull();
  });

  test('a session the host stopped is replaced by a new reservation', async () => {
    const first = await runMacos(root, () => {}, 'mini');
    host.stopSession();
    const second = await runMacos(root, () => {}, 'mini');
    expect(host.methods.filter((method) => method === 'device-host.reserve')).toHaveLength(2);
    expect(second.host?.session).not.toBe(first.host?.session);
  });

  test('a launch the host cannot confirm or complete is reported, and the session stays recorded', async () => {
    host.installed = { state: 'installed', launched: 'unverified' };
    await runMacos(root, () => {}, 'mini');
    expect(macosAppState(readMacosRecord(root))?.state).toBe('unverified');

    host.installed = { state: 'unknown', launched: null, notice: 'the executable has no arm64 slice' };
    await expect(runMacos(root, () => {}, 'mini')).rejects.toThrow('no arm64 slice');
    const kept = readMacosRecord(root);
    expect(kept?.host?.session).toBeDefined();
    expect(macosAppState(kept)?.state).toBe('stopped');
  });

  test('a local run refuses while the workspace app runs on a host', async () => {
    await runMacos(root, () => {}, 'mini');
    spawned = [];
    await expect(runMacos(root, () => {})).rejects.toThrow('runs on mini. Run stim stop first');
    expect(spawned).toEqual([]);
  });

  test('workspace removal stops the hosted session, and keeps the workspace when the host cannot confirm', async () => {
    await runMacos(root, () => {}, 'mini');
    const placed = readMacosRecord(root)!;
    await host.close();
    const kept = await reclaimProject(root, { deleteOwnedDevices: true });
    expect(kept.keptEntry).toBe(true);
    expect(kept.failedDevices[0]?.reason).toContain('mini is unreachable');
    expect(readMacosRecord(root)?.host?.session).toBe(placed.host!.session);

    host = await fakeHost();
    const removed = await reclaimProject(root, { deleteOwnedDevices: true });
    expect(host.methods).toContain('device-host.stop');
    expect(removed.failedDevices).toEqual([]);
  });
});
