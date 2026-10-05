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
import { deviceHostMachinesFile, macosAppState, readMacosRecord, type MacosAppRecord } from '@stim-cli/core/state';
import logsCommand from '../commands/logs.ts';
import macosCommand, { runMacos } from '../commands/macos.ts';
import { syncHostedMacosLogs } from '../device-host/hosted-logs-sync.ts';
import { agentRemoteConfig, probeHostedMacos, type HostedMacosProbe } from '../device-host/hosted-macos.ts';
import { applyHostedMacosProbe, readHostedMacosStatus } from '../device-host/hosted-macos-status.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { stopMacosApp } from '../macos/stop.ts';
import { BuildConnection } from '../offload/client.ts';
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
  scope: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  lease: { tenant: 'stim.s', runId: 'run-1', clientId: 'agent', deviceKey: 'dev.fixture.app.hosted3@4242' },
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface FakeHost {
  methods: string[];
  blobs: Map<string, Buffer>;
  offers: Record<string, unknown>[];
  capabilities: string[];
  grant: unknown;
  applyArguments: boolean;
  logs: Record<string, unknown>[];
  logPage: number;
  logQueries: Record<string, unknown>[];
  logsRefused: boolean;
  installed: { state: string; launched: true | 'unverified' | null; notice?: string };
  attachReply?: { state: string; notice?: string } | { error: { code: string; message: string } };
  silentMethods: Set<string>;
  forgetSession: string | null;
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
    silentMethods: new Set(),
    forgetSession: null,
    blobs: new Map(),
    offers: [],
    capabilities: ['device-host'],
    grant: { driver: 'none' },
    applyArguments: true,
    logs: [],
    logPage: 1000,
    logQueries: [],
    logsRefused: false,
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
      if (host.silentMethods.has(method)) return;
      const reply = (result: unknown) => socket.send(JSON.stringify({ id, result }));
      if (method === 'hello') {
        if (params.auth.deviceToken !== TOKEN)
          return socket.send(JSON.stringify({ id, error: { code: 'unauthorized', message: 'no' } }));
        return reply({ capabilities: host.capabilities, device: { id: 'client1', name: 'laptop' } });
      }
      if (host.forgetSession === params.session && (method === 'device-host.attach' || method === 'device-host.stop')) {
        return socket.send(
          JSON.stringify({
            id,
            error: { code: 'unknown-session', message: 'This client has no such hosted session.' },
          }),
        );
      }
      if (method === 'device-host.reserve') {
        session = { id: randomUUID(), platform: 'macos', state: 'preparing', appSlot: 3, device: null, ...params };
        return reply(session);
      }
      if (method === 'device-host.attach') {
        if (host.attachReply) {
          if ('error' in host.attachReply) return socket.send(JSON.stringify({ id, ...host.attachReply }));
          return reply({ ...session, ...host.attachReply });
        }
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
        ...(host.applyArguments && host.offers.at(-1)?.arguments ? { arguments: host.offers.at(-1)!.arguments } : {}),
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
      if (method === 'device-host.logs.query') {
        host.logQueries.push(params);
        if (host.logsRefused)
          return socket.send(JSON.stringify({ id, error: { code: 'forbidden', message: 'needs read access' } }));
        const from = params.cursor?.['macos.ndjson'] ?? 0;
        const to = Math.min(host.logs.length, from + host.logPage);
        return reply({
          records: host.logs.slice(from, to),
          cursor: { 'macos.ndjson': to },
          more: to < host.logs.length,
        });
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

beforeEach(() => {
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
  spawned = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    findExecutable: (name: string) => (name === 'agent-device' ? null : real.findExecutable(name)),
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

afterEach(() => {
  resetExecutor();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function statusRecord(): MacosAppRecord {
  return {
    launchId: 'launch',
    arguments: [],
    product: 'Fixture',
    bundle: '/Fixture.app',
    bundleId: 'dev.fixture.app',
    executable: '/Fixture.app/Contents/MacOS/Fixture',
    build: { state: 'ok', startedAt: 'now' },
    hostLaunched: true,
    host: {
      machine: 'mini',
      session: '12345678-1234-1234-1234-123456789abc',
      appSlot: 3,
      appAttempt: 'attempt',
      bundleId: 'dev.fixture.app.hosted3',
      agent: { driver: 'none', setting: 'hosting.agentDriver' },
    },
  };
}

test.each<[HostedMacosProbe, string, boolean | 'unverified']>([
  [{ state: 'ready' }, 'running', true],
  [{ state: 'stopped' }, 'stopped', false],
  [{ state: 'unknown' }, 'unverified', 'unverified'],
  [{ state: 'unreachable', reason: 'closed' }, 'unverified', 'unverified'],
])('host evidence changes only the status snapshot: %j', (probe, state, launched) => {
  const record = statusRecord();
  const facts = applyHostedMacosProbe(record, probe);
  expect(macosAppState(facts.record)).toMatchObject({ state, host: record.host, hostLaunched: launched });
  expect(record.hostLaunched).toBe(true);
  expect(Boolean(facts.warning)).toBe(probe.state !== 'ready');
});

test('a ready session does not promote an unconfirmed app launch to running', () => {
  const record = { ...statusRecord(), hostLaunched: 'unverified' as const };
  const facts = applyHostedMacosProbe(record, { state: 'ready' });
  expect(macosAppState(facts.record)?.state).toBe('unverified');
  expect(facts.record?.host).toEqual(record.host);
});

test('local, absent, stopped and supervised records never ask a host for status', async () => {
  const connect = vi.spyOn(BuildConnection, 'open').mockRejectedValue(new Error('unexpected hosting connection'));
  const local = statusRecord();
  delete local.host;
  const supervised = { ...statusRecord(), supervisor: { pid: 1, processToken: 'token', startedAtMicros: 1 } };
  try {
    for (const record of [null, local, { ...statusRecord(), hostLaunched: false }, supervised]) {
      expect(await readHostedMacosStatus(record)).toEqual({ record });
    }
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});

describe.skipIf(process.platform !== 'darwin')('stim macos --host (SwiftPM and codesign run only on macOS)', () => {
  beforeEach(async () => {
    host = await fakeHost();
  });

  afterEach(async () => {
    await host.close();
  });

  test('places the bundle on the host, records the session, and stop ends it there', async () => {
    host.grant = GRANT;
    const args = ['-autopilot.enabled', 'true', ''];
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({ macos: { product: 'Fixture', infoPlist: 'Info.plist', arguments: args } }),
    );
    const notes: string[] = [];
    const record = await runMacos(root, (line) => notes.push(line), 'mini');
    expect(host.methods.filter((method) => method === 'device-host.reserve')).toHaveLength(1);
    expect(host.offers[0]).toMatchObject({ bundleId: 'dev.fixture.app', mode: 'release' });
    expect(host.offers[0]).not.toHaveProperty('devClientScheme');
    for (const offer of host.offers) expect(offer.arguments).toEqual(args);
    expect(record.arguments).toEqual(args);
    expect(readMacosRecord(root)?.arguments).toEqual(args);
    expect(notes.some((line) => line.includes('did not apply macos.arguments'))).toBe(false);
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
      tenant: 'stim.s',
      sessionIsolation: 'tenant',
      runId: 'run-1',
      leaseId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      leaseBackend: 'macos-app',
      leaseProvider: 'proxy',
      clientId: 'agent',
      deviceKey: 'dev.fixture.app.hosted3@4242',
      platform: 'macos',
    });
    expect(workspaceInUse(root, { managedLocks: false, nativeRun: false })).toEqual(['its macOS app runs on mini']);
    expect(spawned.every((cmd) => cmd === 'swift')).toBe(true);

    await runMacos(root, () => {}, 'mini');
    expect(host.methods.filter((method) => method === 'device-host.reserve')).toHaveLength(1);
    expect(host.offers.at(-1)!.attempt).not.toBe(host.offers[0]!.attempt);

    const calls: string[][] = [];
    setExecutor({
      ...getExecutor(),
      findExecutable: () => '/fake/agent-device',
      runFile: (file: string, commandArgs: string[]) => {
        expect(file).toBe('agent-device');
        expect(existsSync(config)).toBe(true);
        expect(host.methods).not.toContain('device-host.stop');
        calls.push(commandArgs);
        return JSON.stringify({ success: true, data: { connected: true, session: 'default', remoteConfig: config } });
      },
    });
    await stopMacosApp(root);
    expect(calls).toEqual([
      ['connection', 'status', '--json'],
      ['close', '--remote-config', config, '--session', 'default', '--json'],
      ['disconnect', '--session', 'default', '--json'],
    ]);
    expect(host.methods).toContain('device-host.stop');
    expect(existsSync(config)).toBe(false);
    expect(readMacosRecord(root)?.host).toBeUndefined();
    expect(macosAppState(readMacosRecord(root))?.state).toBe('stopped');
  });

  test.each(['different config', 'disconnected', 'unavailable', 'close fails', 'canonical config', 'missing config'])(
    'stop cleans up only its own agent connection, best effort: %s',
    async (scenario) => {
      host.grant = GRANT;
      await runMacos(root, () => {}, 'mini');
      const config = agentRemoteConfig(root);
      const otherConfig = join(dir, 'other-config.json');
      if (scenario === 'canonical config') symlinkSync(config, otherConfig);
      else writeFileSync(otherConfig, '{}');
      if (scenario === 'missing config') rmSync(config);
      const calls: string[][] = [];
      setExecutor({
        ...getExecutor(),
        findExecutable: () => (scenario === 'unavailable' ? null : '/fake/agent-device'),
        runFile: (file: string, args: string[]) => {
          expect(file).toBe('agent-device');
          expect(host.methods).not.toContain('device-host.stop');
          expect(existsSync(config)).toBe(scenario !== 'missing config');
          calls.push(args);
          if (scenario === 'close fails' && args[0] === 'close') throw new Error('app already exited\nclose failed');
          return JSON.stringify({
            success: true,
            data: {
              connected: scenario !== 'disconnected',
              session: 'named-session',
              remoteConfig: ['different config', 'canonical config'].includes(scenario) ? otherConfig : config,
            },
          });
        },
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await stopMacosApp(root);
        expect(calls).toEqual(
          scenario === 'unavailable'
            ? []
            : [
                ['connection', 'status', '--json'],
                ...(['close fails', 'canonical config'].includes(scenario)
                  ? [
                      ['close', '--remote-config', config, '--session', 'named-session', '--json'],
                      ['disconnect', '--session', 'named-session', '--json'],
                    ]
                  : []),
              ],
        );
        expect(stderr).toHaveBeenCalledTimes(['close fails', 'canonical config'].includes(scenario) ? 1 : 0);
        expect(stderr.mock.calls.map(([line]) => line).join('')).toMatch(
          scenario === 'close fails'
            ? /app already exited close failed[^\n]*\n$/
            : scenario === 'canonical config'
              ? /closed agent-device connection for named-session/
              : /^$/,
        );
        expect(host.methods).toContain('device-host.stop');
        expect(existsSync(config)).toBe(false);
        expect(readMacosRecord(root)?.host).toBeUndefined();
      } finally {
        stderr.mockRestore();
      }
    },
  );

  test('over-limit macos.arguments refuse before the host reserves a session', async () => {
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({ macos: { product: 'Fixture', infoPlist: 'Info.plist', arguments: Array(33).fill('a') } }),
    );
    await expect(runMacos(root, () => {}, 'mini')).rejects.toThrow('macos.arguments is too large');
    expect(host.methods).not.toContain('device-host.reserve');
  });

  test.each([undefined, ['-notify.enabled', 'false']])(
    'records the applied arguments %j and warns when the host ignores or changes them',
    async (applied) => {
      host.applyArguments = false;
      Object.assign(host.installed, applied ? { arguments: applied } : {});
      const args = ['-notify.enabled', 'true'];
      writeFileSync(
        join(root, '.stim.json'),
        JSON.stringify({ macos: { product: 'Fixture', infoPlist: 'Info.plist', arguments: args } }),
      );
      const notes: string[] = [];
      const record = await runMacos(root, (line) => notes.push(line), 'mini');
      for (const offer of host.offers) expect(offer.arguments).toEqual(args);
      expect(record.arguments).toEqual(applied ?? []);
      expect(readMacosRecord(root)?.arguments).toEqual(applied ?? []);
      expect(notes).toContain('mini did not apply macos.arguments. Update stim-server on that host.');
    },
  );

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
    for (const offer of host.offers) expect(offer).not.toHaveProperty('arguments');
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

  test('status reports a stopped host session without discarding the placement or changing saved state', async () => {
    await runMacos(root, () => {}, 'mini');
    const saved = readMacosRecord(root)!;
    host.stopSession();
    const facts = await readHostedMacosStatus(saved, { ttlMs: 0 });
    expect(macosAppState(facts.record)).toMatchObject({ state: 'stopped', host: saved.host });
    expect(facts.warning).toContain(`session ${saved.host!.session} stopped`);
    expect(facts.warning).toContain('Run stim macos --host mini');
    expect(facts.warning).toContain('stim stop to clear the placement');
    expect(readMacosRecord(root)).toEqual(saved);
  });

  test('status preserves an unreachable placement as unverified with a cleanup remedy', async () => {
    await runMacos(root, () => {}, 'mini');
    const saved = readMacosRecord(root)!;
    await host.close();
    const started = performance.now();
    const facts = await readHostedMacosStatus(saved, { timeoutMs: 100, ttlMs: 0 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(macosAppState(facts.record)).toMatchObject({ state: 'unverified', host: saved.host });
    expect(facts.warning).toContain('mini could not be checked');
    expect(facts.warning).toContain('run stim stop when the host answers');
    expect(readMacosRecord(root)).toEqual(saved);
  });

  test('status carries an unknown host session notice and requires reconciliation', async () => {
    await runMacos(root, () => {}, 'mini');
    host.attachReply = { state: 'unknown', notice: 'The previous session owner is not attached to this server.' };
    const facts = await readHostedMacosStatus(readMacosRecord(root));
    expect(macosAppState(facts.record)).toMatchObject({ state: 'unverified', host: readMacosRecord(root)!.host });
    expect(facts.warning).toContain(host.attachReply.notice);
    expect(facts.warning).toContain('Run stim stop to reconcile it.');
    const hellos = host.methods.filter((method) => method === 'hello').length;
    await readHostedMacosStatus(readMacosRecord(root));
    expect(host.methods.filter((method) => method === 'hello')).toHaveLength(hellos);
  });

  test('a missing session is stopped, while other attach refusals remain unverified', async () => {
    await runMacos(root, () => {}, 'mini');
    const saved = readMacosRecord(root)!;
    host.attachReply = { error: { code: 'unknown-session', message: 'This client has no such hosted session.' } };
    const missing = await readHostedMacosStatus(saved, { ttlMs: 0 });
    expect(macosAppState(missing.record)).toMatchObject({ state: 'stopped', host: saved.host });
    host.attachReply = { error: { code: 'forbidden', message: 'Current device-host approval is required.' } };
    const refused = await readHostedMacosStatus(saved, { ttlMs: 0 });
    expect(macosAppState(refused.record)?.state).toBe('unverified');
    expect(refused.warning).toContain('Current device-host approval is required.');
  });

  test.each(['preparing', 'stopping'])('an unsettled %s session cannot report a running app', async (state) => {
    await runMacos(root, () => {}, 'mini');
    host.attachReply = { state };
    const facts = await readHostedMacosStatus(readMacosRecord(root), { ttlMs: 0 });
    expect(macosAppState(facts.record)?.state).toBe('unverified');
    expect(facts.warning).toContain(state);
  });

  test('concurrent and recent probes share a connection, then refresh an expired result', async () => {
    await runMacos(root, () => {}, 'mini');
    const placement = readMacosRecord(root)!.host!;
    const hellos = host.methods.filter((method) => method === 'hello').length;
    expect(await Promise.all([probeHostedMacos(placement), probeHostedMacos(placement)])).toEqual([
      { state: 'ready' },
      { state: 'ready' },
    ]);
    host.stopSession();
    expect(await probeHostedMacos(placement)).toEqual({ state: 'ready' });
    expect(host.methods.filter((method) => method === 'hello')).toHaveLength(hellos + 1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    try {
      expect(await probeHostedMacos(placement)).toEqual({ state: 'stopped' });
      expect(host.methods.filter((method) => method === 'hello')).toHaveLength(hellos + 2);
    } finally {
      clock.mockRestore();
    }
  });

  test.each(['hello', 'device-host.attach'])(
    'a silent %s times out, closes the connection and caches failure',
    async (method) => {
      await runMacos(root, () => {}, 'mini');
      host.silentMethods.add(method);
      const saved = readMacosRecord(root)!;
      const started = performance.now();
      const facts = await readHostedMacosStatus(saved, { timeoutMs: 100 });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(macosAppState(facts.record)?.state).toBe('unverified');
      expect(facts.warning).toMatch(/no reply/);
      const hellos = host.methods.filter((each) => each === 'hello').length;
      expect(await readHostedMacosStatus(saved, { timeoutMs: 100 })).toEqual(facts);
      expect(host.methods.filter((each) => each === 'hello')).toHaveLength(hellos);
      await host.close();
    },
  );

  test('a session the host stopped is replaced by a new reservation', async () => {
    const first = await runMacos(root, () => {}, 'mini');
    host.stopSession();
    const second = await runMacos(root, () => {}, 'mini');
    expect(host.methods.filter((method) => method === 'device-host.reserve')).toHaveLength(2);
    expect(second.host?.session).not.toBe(first.host?.session);
  });

  test('a session the host no longer holds is replaced on launch and released by stop', async () => {
    const first = await runMacos(root, () => {}, 'mini');
    host.forgetSession = first.host!.session;
    const second = await runMacos(root, () => {}, 'mini');
    expect(second.host?.session).not.toBe(first.host?.session);
    host.forgetSession = second.host!.session;
    await stopMacosApp(root);
    expect(readMacosRecord(root)?.host).toBeUndefined();
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

  describe('stim logs for a hosted app', () => {
    const originalCwd = process.cwd();
    const clientRecord = (n: number, level = 'info') => ({
      ts: 1_000 + n,
      src: 'client',
      platform: 'macos',
      level,
      msg: `line ${n}`,
    });
    const messages = (lines: string[]) => lines.map((line) => JSON.parse(line).msg);

    async function logs(args: string[]): Promise<{ out: string[]; err: string }> {
      const out: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.chdir(root);
      try {
        const program = new Command();
        logsCommand(program);
        await program.parseAsync(['node', 'stim', 'logs', ...args]);
        return { out, err: stderr.mock.calls.map(([line]) => String(line)).join('') };
      } finally {
        process.chdir(originalCwd);
        log.mockRestore();
        stderr.mockRestore();
      }
    }

    test('copies each host record once, in pages, and picks up new ones on the next run', async () => {
      await runMacos(root, () => {}, 'mini');
      host.logPage = 2;
      host.logs.push(clientRecord(1), clientRecord(2), clientRecord(3, 'error'));
      const first = await logs(['--json', '--source', 'client']);
      expect(messages(first.out)).toEqual(['line 1', 'line 2', 'line 3']);
      expect(host.logQueries.map((query) => query.cursor)).toEqual([undefined, { 'macos.ndjson': 2 }]);
      expect(first.err).toBe('');
      host.logs.push(clientRecord(4));
      const second = await logs(['--json', '--source', 'client']);
      expect(messages(second.out)).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
      expect(host.logQueries.at(-1)).toMatchObject({ cursor: { 'macos.ndjson': 3 } });
      expect(messages((await logs(['--json', '--errors'])).out)).toEqual(['line 3']);
    });

    test('concurrent runs do not duplicate records', async () => {
      await runMacos(root, () => {}, 'mini');
      host.logs.push(clientRecord(1), clientRecord(2));
      const placement = readMacosRecord(root)!.host!;
      await Promise.all([syncHostedMacosLogs(root, placement), syncHostedMacosLogs(root, placement)]);
      expect(messages((await logs(['--json', '--source', 'client'])).out)).toEqual(['line 1', 'line 2']);
    });

    test('a host that refuses costs a stderr warning, never stdout or the exit code', async () => {
      await runMacos(root, () => {}, 'mini');
      host.logsRefused = true;
      const result = await logs(['--json', '--source', 'client']);
      expect(result.out).toEqual([]);
      expect(result.err).toContain('Could not read the app');
      expect(result.err).toContain('needs read access');
    });

    test('stop copies the last records before it forgets the placement', async () => {
      await runMacos(root, () => {}, 'mini');
      host.logs.push(clientRecord(1), clientRecord(2, 'error'));
      await stopMacosApp(root);
      expect(host.methods.lastIndexOf('device-host.logs.query')).toBeGreaterThan(
        host.methods.indexOf('device-host.stop'),
      );
      expect(readMacosRecord(root)?.host).toBeUndefined();
      const after = await logs(['--json', '--source', 'client']);
      expect(messages(after.out)).toEqual(['line 1', 'line 2']);
      expect(host.logQueries).toHaveLength(1);
    });

    test('a host that cannot return the final logs does not block stop', async () => {
      await runMacos(root, () => {}, 'mini');
      host.logsRefused = true;
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await stopMacosApp(root);
        expect(stderr.mock.calls.join('')).toContain('Could not copy the final logs from mini');
      } finally {
        stderr.mockRestore();
      }
      expect(readMacosRecord(root)?.host).toBeUndefined();
    });
  });
});
