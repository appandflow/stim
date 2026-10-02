import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, get } from 'node:http';
import { createServer as createHttp2Server, type ServerHttp2Stream } from 'node:http2';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { homedir, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  readStatsReport,
  buildSlotPath,
  machineCapacity,
  readViewedDevices,
  tryAcquireBuildSlotClaim,
} from '@stim-cli/core/state';
import type { HelloResult, MachineUsage, ServerMessage, StatusEvent } from '../src/protocol.ts';
import { runNodeCommand } from '../src/stim-command.ts';
import { readAudit } from '../src/actions.ts';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  PAIRING_TTL_MS,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  revokeDevice,
} from '../src/registry.ts';
import { watchTailscale } from '../src/tailscale-monitor.ts';
import type { TailscaleState } from '../src/tailscale.ts';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';
import { workspaceStateDir } from '@stim-cli/core';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';

const registryWatch = vi.hoisted(() => ({ dropEvents: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (path: string, listener: (event: string, filename: string | null) => void) =>
      fs.watch(path, registryWatch.dropEvents ? () => {} : listener),
  };
});

const FAKE_STIM = `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const env = process.env;
const pidFile = join(env.FAKE_STIM_PIDS, String(process.pid));
mkdirSync(env.FAKE_STIM_PIDS, { recursive: true });
writeFileSync(pidFile, args.join(' '));
appendFileSync(env.FAKE_STIM_CALLS, JSON.stringify({ args: args.join(' '), cwd: process.cwd() }) + '\\n');
const exit = (code) => {
  rmSync(pidFile, { force: true });
  process.exit(code);
};
process.on('SIGTERM', () => env.FAKE_STIM_STUBBORN || exit(0));
const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const [command] = args;
if (command === 'status') {
  const payloads = JSON.parse(env.FAKE_STIM_PAYLOADS);
  let index = 0;
  setInterval(() => {
    if (index < payloads.length) return void print(payloads[index++]);
    if (env.FAKE_STIM_EXIT) {
      process.stderr.write('status failed on purpose');
      exit(3);
    }
  }, 20);
} else if (command === 'logs') {
  const from = args.indexOf('--source');
  const sources = from === -1 || !env.FAKE_STIM_BY_SOURCE ? null : args.slice(from + 1).filter((arg) => !arg.startsWith('-'));
  for (const record of JSON.parse(env.FAKE_STIM_RECORDS)) if (!sources || sources.includes(record.src)) print(record);
  if (!args.includes('--follow')) exit(0);
  if (env.FAKE_STIM_EXIT) {
    process.stderr.write('logs failed on purpose');
    setTimeout(() => exit(3), 50);
  }
  if (env.FAKE_STIM_FLOOD) {
    const msg = 'x'.repeat(20000);
    setInterval(() => {
      for (let i = 0; i < 20; i++) print({ ts: Date.now(), src: 'device', level: 'info', msg });
    }, 1);
  } else {
    setInterval(() => {}, 1000);
  }
} else if (command === 'device' && args[1] === 'lock') {
  if (env.FAKE_STIM_LOCK_BUSY) {
    print({ code: 'STIM_DEVICE_BUSY', message: 'Another workspace leases this device.', remedy: 'Wait.' });
    exit(1);
  }
  const grantedAt = env.FAKE_STIM_LOCK_GRANTED ?? new Date().toISOString();
  print({ platform: args[2], id: args[3], grantedAt, expiresAt: new Date(Date.now() + 120000).toISOString() });
  exit(0);
} else if (command === 'device' && args[1] === 'unlock') {
  print([]);
  exit(0);
} else if (command === 'doctor') {
  print({ project: process.cwd(), buildMachines: [{ machine: 'mini', state: 'approved', args: args.join(' ') }] });
  exit(0);
} else if (env.FAKE_STIM_REFUSE) {
  print({ code: 'STIM_NO_DEVICE', message: 'No system image is installed.', remedy: 'Install one.' });
  exit(1);
} else if (args.includes('--plan')) {
  const answer = () => {
    print({ platform: command, args: args.join(' '), cwd: process.cwd(), cacheHit: 'local' });
    exit(0);
  };
  if (!env.FAKE_STIM_PLAN_GATE) answer();
  else setInterval(() => existsSync(env.FAKE_STIM_PLAN_GATE) && answer(), 10);
} else if (command === 'settings' && env.FAKE_STIM_SETTINGS_MS) {
  setTimeout(() => {
    appendFileSync(env.FAKE_STIM_CALLS, JSON.stringify({ ended: args.join(' ') }) + '\\n');
    print({ command });
    exit(0);
  }, Number(env.FAKE_STIM_SETTINGS_MS));
} else if (env.FAKE_STIM_GRANDCHILD) {
  const { spawn } = await import('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    detached: true,
    stdio: 'inherit',
  });
  writeFileSync(env.FAKE_STIM_GRANDCHILD, String(grandchild.pid));
  setInterval(() => {}, 1000);
} else if (env.FAKE_STIM_HANG || env.FAKE_STIM_STUBBORN) {
  setInterval(() => {}, 1000);
} else if (env.FAKE_STIM_JSON_FAIL) {
  print({ code: 'STIM_NO_LIVE_APP', message: 'No live app in this workspace.', remedy: 'Run stim ios.' });
  exit(1);
} else if (env.FAKE_STIM_FAIL || env.FAKE_STIM_FAIL_COMMAND === command) {
  process.stderr.write(command + ' failed on purpose');
  exit(1);
} else {
  print({ command, cwd: process.cwd() });
  exit(0);
}
`;

const FAKE_TAILSCALE = `#!/usr/bin/env node
const [command, , ip] = process.argv.slice(2);
const delay = Number(process.env.FAKE_TAILSCALE_DELAY_MS || 0);
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
if (command === 'status') {
  console.log(JSON.stringify({ BackendState: 'Stopped' }));
  process.exit(0);
}
if (command === 'serve') {
  console.log(require('node:fs').readFileSync(process.env.FAKE_SERVE_STATUS, 'utf8'));
  process.exit(0);
}
const peer = JSON.parse(process.env.FAKE_TAILSCALE_PEERS)[ip];
if (command !== 'whois' || !peer) {
  console.error('peer not found');
  process.exit(1);
}
console.log(JSON.stringify({ Node: { ID: 1, StableID: peer.node, Name: peer.node + '.tail.ts.net.' }, UserProfile: { LoginName: peer.user } }));
`;

const RECORDS = [
  { ts: 1, src: 'metro', level: 'info', msg: 'Bundled' },
  { ts: 2, src: 'client', level: 'warn', msg: 'Slow render', slot: 'tablet' },
  { ts: 3, src: 'build', level: 'error', msg: 'Compile failed' },
];

const FAKE_WORKER = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv[2] === 'offer') {
  print({ stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', cocoapods: '1.16.2', runtimes: ['iOS-27-0'] });
} else {
  const job = JSON.parse(readFileSync(0, 'utf8'));
  writeFileSync(join(process.env.FAKE_STIM_PIDS, '..', 'job.json'), JSON.stringify({ job, home: process.env.STIM_HOME, gradle: process.env.GRADLE_USER_HOME, pid: process.pid }));
  print({ type: 'phase', phase: 'build', msg: 'compiling' });
  print({ type: 'log', record: { src: 'build', level: 'info', msg: 'CompileC' } });
  if (process.env.FAKE_WORKER_HANG) {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else {
    if (process.env.FAKE_WORKER_GATE) {
      const { existsSync } = await import('node:fs');
      while (!existsSync(process.env.FAKE_WORKER_GATE)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    mkdirSync(join(job.area, 'out', job.job), { recursive: true });
    const archive = Buffer.from('app archive bytes');
    writeFileSync(join(job.area, 'out', job.job, 'app.tgz'), archive);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    print({ type: 'result', ok: true, artifact: { name: 'App.app', size: archive.length, sha256 }, fingerprint: job.expectedFingerprint, compilationCache: { status: 'reported', hits: 3, cacheableTasks: 4, hitRatePercent: 75 }, timings: { buildMs: 5 } });
  }
}
`;

const PAYLOADS = [
  { environments: [], capacity: { live: 0 }, deviceLeases: [], unprovisionedWorktrees: [], simctlAvailable: true },
  { environments: [{ path: '/work/app', live: true }], capacity: { live: 1 }, deviceLeases: [], simctlAvailable: true },
];

// The fake tailscale is a script with a shebang, which Windows cannot execute.
const fakeTailscale = process.platform !== 'win32';

const CLIENT = { name: 'test client', version: '0.0.0' };

const PEERS = {
  '100.64.0.2': { node: 'nPhoneA', user: 'janic@example.com' },
  '100.64.0.3': { node: 'nPhoneB', user: 'janic@example.com' },
};

interface Client {
  socket: WebSocket;
  next: () => Promise<ServerMessage>;
  closed: Promise<number>;
  request: (method: string, params?: unknown) => Promise<ServerMessage>;
}

let root: string;
let pids: string;
let calls: string;
let workspace: string;
let server: RunningServer | null;
let clients: WebSocket[];

async function start(
  overrides: {
    exit?: boolean;
    whoisDelayMs?: number;
    authTimeoutMs?: number;
    maxAuthFailures?: number;
    env?: Record<string, string>;
    logLimits?: ServerOptions['logLimits'];
    commandLimits?: ServerOptions['commandLimits'];
    actionLimits?: ServerOptions['actionLimits'];
    tailscaleState?: ServerOptions['tailscaleState'];
    tailscaleMonitor?: ServerOptions['tailscaleMonitor'];
    listenRetryMs?: number;
    frameLimits?: ServerOptions['frameLimits'];
    frameHelper?: string | null;
    foldHelper?: string;
    record?: boolean;
    recordLimits?: ServerOptions['recordLimits'];
    controlLimits?: ServerOptions['controlLimits'];
    history?: boolean;
    pushEndpoint?: string;
    buildLimits?: ServerOptions['buildLimits'];
  } = {},
): Promise<number> {
  const stimCli = join(root, 'fake-stim.mjs');
  writeFileSync(stimCli, FAKE_STIM);
  writeFileSync(join(root, 'offload-worker.mjs'), FAKE_WORKER);
  const tailscale = join(root, 'tailscale');
  writeFileSync(tailscale, FAKE_TAILSCALE);
  chmodSync(tailscale, 0o755);
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli,
    name: 'Test Mac',
    stimVersion: '9.9.9',
    serverVersion: '1.2.3',
    tailscale,
    tailscaleState: overrides.tailscaleState ?? { state: 'not-running', backendState: 'Stopped' },
    env: {
      ...process.env,
      FAKE_STIM_PIDS: pids,
      FAKE_STIM_CALLS: calls,
      FAKE_STIM_PAYLOADS: JSON.stringify(PAYLOADS),
      FAKE_STIM_RECORDS: JSON.stringify(RECORDS),
      FAKE_TAILSCALE_PEERS: JSON.stringify(PEERS),
      ...(overrides.exit ? { FAKE_STIM_EXIT: '1' } : {}),
      ...(overrides.whoisDelayMs ? { FAKE_TAILSCALE_DELAY_MS: String(overrides.whoisDelayMs) } : {}),
      ...overrides.env,
    },
    tailscaleMonitor: overrides.tailscaleMonitor,
    listenRetryMs: overrides.listenRetryMs,
    authTimeoutMs: overrides.authTimeoutMs,
    maxAuthFailures: overrides.maxAuthFailures,
    logLimits: overrides.logLimits,
    commandLimits: overrides.commandLimits,
    actionLimits: overrides.actionLimits,
    frameLimits: { lingerMs: 50, ...overrides.frameLimits },
    frameHelper: overrides.frameHelper ?? null,
    foldHelper: overrides.foldHelper,
    record: overrides.record ?? false,
    recordLimits: overrides.recordLimits,
    controlLimits: overrides.controlLimits,
    history: overrides.history ?? false,
    pushEndpoint: overrides.pushEndpoint ?? 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
    buildLimits: overrides.buildLimits,
  });
  return server.addresses[0]!.port;
}

function connect(port: number, peer?: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: peer ? { 'x-forwarded-for': peer } : {} });
  clients.push(socket);
  const inbox: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  socket.on('message', (data, isBinary) => {
    const message = (isBinary ? { binary: data } : JSON.parse(data.toString())) as ServerMessage;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  const next = () =>
    inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<ServerMessage>((resolve) => waiting.push(resolve));
  let id = 0;
  const request = (method: string, params?: unknown) => {
    socket.send(JSON.stringify({ id: ++id, method, params }));
    return next();
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, next, closed, request }));
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once('error', reject);
  });
}

async function pair(port: number, peer?: string, control = false): Promise<{ id: string; token: string }> {
  const client = await connect(port, peer);
  const reply = await client.request('hello', {
    protocol: 1,
    client: CLIENT,
    auth: { pairingToken: createPairingToken(Date.now(), capabilitiesFor(control)).token, deviceName: 'Test phone' },
  });
  if (!('result' in reply)) throw new Error(JSON.stringify(reply));
  const result = reply.result as HelloResult;
  client.socket.close();
  return { id: result.device.id, token: result.deviceToken! };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

function childPids(): number[] {
  return existsSync(pids) ? readdirSync(pids).map(Number).filter(alive) : [];
}

function stimCalls(): { args: string; cwd: string }[] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string; cwd: string });
}

async function authed(port: number, control = false): Promise<Client> {
  const { token } = await pair(port, undefined, control);
  const client = await connect(port);
  await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
  return client;
}

async function records(client: Client, count: number): Promise<unknown[]> {
  const seen: unknown[] = [];
  while (seen.length < count) {
    const message = await client.next();
    if (!('event' in message) || message.event !== 'logs') throw new Error(JSON.stringify(message));
    seen.push(...message.records);
  }
  return seen;
}

beforeEach(() => {
  registryWatch.dropEvents = false;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-server-')));
  pids = join(root, 'pids');
  calls = join(root, 'calls.ndjson');
  workspace = join(root, 'app');
  mkdirSync(workspace);
  process.env.STIM_HOME = join(root, 'home');
  mkdirSync(process.env.STIM_HOME);
  writeFileSync(join(process.env.STIM_HOME, 'config.json'), JSON.stringify({ projects: { [workspace]: {} } }));
  server = null;
  clients = [];
});

afterEach(async () => {
  for (const socket of clients) socket.terminate();
  await server?.close();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe('pairing', () => {
  it('trades a pairing token for a device token and stores only its hash', async () => {
    const port = await start();
    const client = await connect(port);
    const { token } = createPairingToken();
    const reply = await client.request('hello', {
      protocol: 1,
      client: CLIENT,
      auth: { pairingToken: token, deviceName: 'Test phone' },
    });

    expect(reply).toMatchObject({
      result: {
        protocol: 1,
        server: { name: 'Test Mac', version: '1.2.3', stim: '9.9.9', home: homedir() },
        capabilities: ['read'],
        features: ['physical-ios', 'physical-android', 'notifications'],
        actions: [],
      },
    });
    const deviceToken = 'result' in reply && 'deviceToken' in reply.result ? reply.result.deviceToken! : '';
    const stored = readFileSync(join(root, 'home', 'server', 'devices.json'), 'utf8');
    expect(stored).not.toContain(deviceToken);
    expect(readFileSync(join(root, 'home', 'server', 'pairing.json'), 'utf8')).not.toContain(token);
    expect(readDevices()).toEqual([expect.objectContaining({ name: 'Test phone', identity: { kind: 'local' } })]);

    const again = await connect(port);
    const hello = await again.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken } });
    expect(hello).toMatchObject({ result: { device: { name: 'Test phone' } } });
    expect('result' in hello && 'deviceToken' in hello.result).toBe(false);
  });

  it('refuses a pairing token that was already spent', async () => {
    const port = await start();
    const { token } = createPairingToken();
    const first = await connect(port);
    await first.request('hello', { protocol: 1, client: CLIENT, auth: { pairingToken: token, deviceName: 'First' } });

    const second = await connect(port);
    const reply = await second.request('hello', {
      protocol: 1,
      client: CLIENT,
      auth: { pairingToken: token, deviceName: 'Second' },
    });
    expect(reply).toMatchObject({
      error: { code: 'pairing-expired', message: expect.stringContaining('already used') },
    });
    expect(await second.closed).toBe(4401);
    expect(readDevices().map((device) => device.name)).toEqual(['First']);
  });

  it('refuses an expired pairing token', async () => {
    const port = await start();
    const { token } = createPairingToken(Date.now() - PAIRING_TTL_MS - 1000);
    const client = await connect(port);
    const reply = await client.request('hello', {
      protocol: 1,
      client: CLIENT,
      auth: { pairingToken: token, deviceName: 'Late' },
    });
    expect(reply).toMatchObject({ error: { code: 'pairing-expired', message: expect.stringContaining('expired') } });
    expect(await client.closed).toBe(4401);
    expect(readDevices()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)('binds a device token to the tailnet node that paired it', async () => {
    const port = await start();
    const { token } = await pair(port, '100.64.0.2');
    expect(readDevices()[0]?.identity).toEqual({
      kind: 'tailnet',
      nodeId: 'nPhoneA',
      nodeName: 'nPhoneA.tail.ts.net',
      user: 'janic@example.com',
    });

    const same = await connect(port, '100.64.0.2');
    expect(await same.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } })).toHaveProperty(
      'result',
    );

    for (const peer of ['100.64.0.3', undefined]) {
      const other = await connect(port, peer);
      expect(await other.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } })).toMatchObject(
        {
          error: { code: 'unauthorized', message: expect.stringContaining('different tailnet node') },
        },
      );
      expect(await other.closed).toBe(4401);
    }

    const unknown = await connect(port, '100.64.0.9');
    expect(await unknown.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } })).toMatchObject(
      {
        error: { code: 'identity-unavailable' },
      },
    );
  });

  it.each([false, true])(
    'closes revoked sessions and refuses the token with watch events dropped: %s',
    async (dropEvents) => {
      registryWatch.dropEvents = dropEvents;
      const port = await start();
      const { id, token } = await pair(port);
      const live = await connect(port);
      await live.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });

      expect(revokeDevice(id)).toBe(true);
      expect(await live.closed).toBe(4401);
      const after = await connect(port);
      expect(await after.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } })).toMatchObject(
        {
          error: { code: 'unauthorized', message: expect.stringContaining('does not recognize') },
        },
      );
      expect(revokeDevice(id)).toBe(false);
    },
  );
});

describe.each(['build', 'device-host'] as const)('%s access', (capability) => {
  const requestBuild = (client: Client) =>
    client.request('hello', { protocol: 1, client: CLIENT, auth: { request: capability, deviceName: 'Laptop' } });
  const helloWith = (client: Client, deviceToken: string) =>
    client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken } });

  test.skipIf(!fakeTailscale)('holds a request until the Mac approves it, then serves no read method', async () => {
    const port = await start({ maxAuthFailures: 2 });
    const asking = await connect(port, '100.64.0.2');
    const reply = await requestBuild(asking);
    expect(reply).toMatchObject({
      result: { capabilities: [], actions: [], approval: { state: 'pending' }, deviceToken: expect.any(String) },
    });
    expect(await asking.closed).toBe(4401);
    const { device, deviceToken } = (reply as { result: HelloResult }).result;

    for (let attempt = 0; attempt < 3; attempt++) {
      const waiting = await connect(port, '100.64.0.2');
      expect(await helloWith(waiting, deviceToken!)).toMatchObject({ error: { code: 'approval-pending' } });
      expect(await waiting.closed).toBe(4401);
    }

    expect(grantDevice(device.id, [capability])).toBe('granted');
    const approved = await connect(port, '100.64.0.2');
    expect(await helloWith(approved, deviceToken!)).toMatchObject({
      result: { capabilities: [capability], actions: [] },
    });
    for (const method of ['status.subscribe', 'machine.get', 'notifications.list', 'stats.get', 'machine.details']) {
      expect(await approved.request(method)).toMatchObject({ error: { code: 'forbidden' } });
    }

    if (capability === 'device-host') {
      expect(await approved.request('build.offer')).toMatchObject({ error: { code: 'forbidden' } });
      expect(await approved.request('control.begin', { workspace: '/unrelated', slot: 'ios' })).toMatchObject({
        error: { code: 'forbidden' },
      });
    }

    const elsewhere = await connect(port, '100.64.0.3');
    expect(await helloWith(elsewhere, deviceToken!)).toMatchObject({ error: { code: 'unauthorized' } });

    expect(revokeDevice(device.id)).toBe(true);
    expect(await approved.closed).toBe(4401);
  });

  test.skipIf(!fakeTailscale)('counts each approval request toward the failed-attempt limit', async () => {
    const port = await start({ maxAuthFailures: 2 });
    const opened = await Promise.all([1, 2, 3].map(() => connect(port, '100.64.0.3')));
    for (const socket of opened.slice(0, 2)) await requestBuild(socket);
    expect(await requestBuild(opened[2]!)).toMatchObject({ error: { code: 'limit-exceeded' } });
    await expect(connect(port, '100.64.0.3')).rejects.toThrow('HTTP 429');
  });

  it('refuses requested access to a connection from this Mac', async () => {
    const port = await start();
    const local = await connect(port);
    expect(await requestBuild(local)).toMatchObject({ error: { code: 'forbidden' } });
    expect([...readBuildClients(), ...readDeviceHostClients()]).toEqual([]);
  });
});

describe('offloaded builds', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const file = (path: string, text: string) => ({ path, kind: 'file', size: text.length, sha256: sha(text) });
  const blob = (text: string) => Buffer.concat([Buffer.from(sha(text), 'hex'), Buffer.from(text)]);
  const START = {
    repo: 'app-1',
    project: 'apps/mobile',
    platform: 'ios',
    configuration: null,
    scheme: null,
    runtime: 'iOS-27-0',
    fingerprint: 'f00d',
    packageName: 'mobile',
    isExpo: true,
    optimizations: null,
    stimBuild: 'b1',
  };
  const configure = (config: Record<string, unknown>) =>
    writeFileSync(
      join(process.env.STIM_HOME!, 'config.json'),
      JSON.stringify({ projects: { [workspace]: {} }, ...config }),
    );

  beforeEach(() => configure({ offload: { maxLoadPerCore: 100_000 } }));

  async function buildClient(
    port: number,
    peer = '100.64.0.2',
  ): Promise<{ client: Client; id: string; deviceToken: string }> {
    const asking = await connect(port, peer);
    const reply = await asking.request('hello', {
      protocol: 1,
      client: CLIENT,
      auth: { request: 'build', deviceName: 'Laptop' },
    });
    const { device, deviceToken } = (reply as { result: HelloResult }).result;
    grantDevice(device.id, ['build']);
    const client = await connect(port, peer);
    await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken } });
    return { client, id: device.id, deviceToken: deviceToken! };
  }

  async function eventually(check: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  }

  async function progress(client: Client): Promise<Record<string, unknown>[]> {
    const events: Record<string, unknown>[] = [];
    for (;;) {
      const message = (await client.next()) as unknown as Record<string, unknown>;
      events.push(message);
      if (message.outcome) return events;
    }
  }

  test.skipIf(!fakeTailscale)(
    'mirrors a content-addressed manifest, builds it and returns the artifact with its digest',
    async () => {
      const port = await start();
      const { client, id } = await buildClient(port);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: {
          toolchain: { stimBuild: 'b1', runtimes: ['iOS-27-0'] },
          capacity: { running: 0, max: 1 },
          warm: { checkout: false, dependencies: false, build: false },
        },
      });

      const first = await client.request('build.sync', {
        repo: 'app-1',
        files: [file('package.json', '{}'), file('apps/mobile/app.json', '{"a":1}')],
        done: false,
      });
      expect(first).toMatchObject({ result: { missing: [sha('{}'), sha('{"a":1}')] } });
      const second = await client.request('build.sync', {
        repo: 'app-1',
        files: [file('apps/mobile/copy.json', '{}')],
        done: true,
      });
      expect(second).toMatchObject({ result: { missing: [] } });
      expect(await client.request('build.start', START)).toMatchObject({ error: { code: 'bad-request' } });

      client.socket.send(blob('{}'));
      client.socket.send(blob('{"a":1}'));
      const started = await client.request('build.start', START);
      expect(started).toMatchObject({ result: { job: expect.any(String) } });
      const job = (started as { result: { job: string } }).result.job;
      const events = await progress(client);
      expect(events).toEqual([
        { event: 'build.progress', job, phase: 'build', msg: 'compiling' },
        { event: 'build.progress', job, record: { src: 'build', level: 'info', msg: 'CompileC' } },
        {
          event: 'build.progress',
          job,
          outcome: expect.objectContaining({
            ok: true,
            artifact: { name: 'App.app', size: 17, sha256: sha('app archive bytes') },
          }),
        },
      ]);

      const area = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1');
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.home).toBe(join(area, 'home'));
      expect(ran.job).toMatchObject({ area, project: 'apps/mobile', expectedFingerprint: 'f00d', runtime: 'iOS-27-0' });
      expect(ran.job.manifest.map((entry: { path: string }) => entry.path).toSorted()).toEqual([
        'apps/mobile/app.json',
        'apps/mobile/copy.json',
        'package.json',
      ]);
      expect(readClaimSet(`${area}.claims`).live).toEqual([]);

      client.socket.send(JSON.stringify({ id: 99, method: 'build.artifact', params: { job } }));
      const frame = (await client.next()) as unknown as { binary: Buffer };
      expect(frame.binary.subarray(0, 32).toString('hex')).toBe(sha('app archive bytes'));
      expect(frame.binary.subarray(32).toString()).toBe('app archive bytes');
      expect(await client.next()).toEqual({
        id: 99,
        result: { name: 'App.app', size: 17, sha256: sha('app archive bytes') },
      });
      expect(existsSync(join(area, 'out', job))).toBe(false);
      expect(readAudit()).toMatchObject([{ action: 'build', workspace: 'app-1', ok: true }]);

      const viewer = await authed(port);
      expect(await viewer.request('build.offer', { repo: 'app-1' })).toMatchObject({ error: { code: 'forbidden' } });
    },
  );

  test.skipIf(!fakeTailscale)(
    "builds an Android job with its Gradle options in the client's own Gradle home",
    async () => {
      const port = await start();
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const android = { variant: null, abi: 'arm64-v8a', gradleBuildCache: true, pch: 'auto', compilerCache: 'ccache' };
      const base = { ...START, platform: 'android', runtime: null };
      expect(await client.request('build.start', base)).toMatchObject({ error: { code: 'bad-request' } });
      expect(await client.request('build.start', { ...base, android: { ...android, abi: '../x' } })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('build.start', { ...base, android })).toMatchObject({
        result: { job: expect.any(String) },
      });
      await progress(client);
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.job).toMatchObject({ platform: 'android', runtime: null, android });
      expect(ran.gradle).toBe(join(process.env.STIM_HOME!, 'build-worker', id, 'cache', 'gradle'));
    },
  );

  test.skipIf(!fakeTailscale)(
    'declines an offer and a start while its own native builds fill concurrency.maxBuilds',
    async () => {
      configure({ concurrency: { maxBuilds: 1 }, offload: { maxLoadPerCore: 100_000 } });
      const building = join(root, 'building');
      mkdirSync(building);
      const attempt = tryAcquireClaim({ root: join(root, 'native-run'), mode: 'exclusive', label: 'native run' });
      const claim = attempt.acquired!;
      mkdirSync(workspaceStateDir(building), { recursive: true });
      const writeActive = (phase: string) =>
        writeFileSync(
          join(workspaceStateDir(building), 'state.json'),
          JSON.stringify({ activeBuild: { phase, claim: { root: claim.root, claimId: claim.claimId } } }),
        );
      writeActive('install');
      const port = await start();
      const { client } = await buildClient(port);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { builds: 0, maxBuilds: 1, declined: null, cpus: expect.any(Number) } },
      });

      writeActive('compile');
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 0, builds: 1, maxBuilds: 1, declined: 'all 1 build slots busy' } },
      });
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({
        error: { code: 'build-busy', message: 'This Mac declines the build: all 1 build slots busy.' },
      });

      releaseClaim(claim);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { builds: 0, declined: null } },
      });
    },
  );

  test.skipIf(!fakeTailscale)(
    'holds one of its build slots for the whole offloaded build, and refuses a start while local runs hold them all',
    async () => {
      configure({ concurrency: { maxBuilds: 1 }, offload: { maxLoadPerCore: 100_000 } });
      const local = tryAcquireBuildSlotClaim({ max: 1, details: { projectRoot: root } })!;
      const port = await start({ env: { FAKE_WORKER_HANG: '1' }, buildLimits: { killGraceMs: 100 } });
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({
        error: { code: 'build-busy', message: 'This Mac declines the build: all 1 build slots busy.' },
      });

      releaseClaim(local.claim);
      const started = await client.request('build.start', START);
      expect(started).toMatchObject({ result: { job: expect.any(String) } });
      const job = (started as { result: { job: string } }).result.job;
      await eventually(() => existsSync(join(root, 'job.json')));
      const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
      expect(await client.next()).toMatchObject({ phase: 'build' });
      expect(await client.next()).toMatchObject({ record: { msg: 'CompileC' } });
      expect(readClaimSet(buildSlotPath(0)).live).toMatchObject([
        { details: { offloaded: true, client: id, repo: 'app-1', job, index: 0 }, child: { pid } },
      ]);
      expect(tryAcquireBuildSlotClaim({ max: 1, details: {} })).toBeNull();
      expect(machineCapacity().builds).toBe(1);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 1, builds: 1, maxBuilds: 1 } },
      });

      expect(await client.request('build.cancel', { job })).toEqual({ id: expect.anything(), result: {} });
      await eventually(() => !alive(pid));
      await eventually(() => readClaimSet(buildSlotPath(0)).live.length === 0);
      expect(machineCapacity().builds).toBe(0);
    },
  );

  test.skipIf(!fakeTailscale)(
    'keeps a build running when its connection drops and hands it to a new connection of the same client',
    async () => {
      const gate = join(root, 'gate');
      const port = await start({ env: { FAKE_WORKER_GATE: gate } });
      const { client, deviceToken } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const job = ((await client.request('build.start', START)) as { result: { job: string } }).result.job;
      expect(await client.next()).toMatchObject({ phase: 'build' });
      client.socket.terminate();
      expect(await client.closed).toBe(1006);

      const other = await buildClient(port, '100.64.0.3');
      expect(await other.client.request('build.attach', { job })).toMatchObject({ error: { code: 'bad-request' } });

      const again = await connect(port, '100.64.0.2');
      await again.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken } });
      expect(await again.request('build.attach', { job })).toEqual({ id: 2, result: { outcome: null } });
      writeFileSync(gate, '');
      expect((await progress(again)).at(-1)).toMatchObject({ job, outcome: { ok: true } });
      again.socket.send(JSON.stringify({ id: 3, method: 'build.artifact', params: { job } }));
      expect(((await again.next()) as unknown as { binary: Buffer }).binary.subarray(32).toString()).toBe(
        'app archive bytes',
      );
      expect(await again.next()).toMatchObject({ id: 3, result: { name: 'App.app' } });
    },
  );

  test.skipIf(!fakeTailscale)(
    'moves a build off a connection that is still open, so closing that one does not cancel it',
    async () => {
      const gate = join(root, 'gate');
      const port = await start({ env: { FAKE_WORKER_GATE: gate } });
      const { client, deviceToken } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const job = ((await client.request('build.start', START)) as { result: { job: string } }).result.job;

      const again = await connect(port, '100.64.0.2');
      await again.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken } });
      expect(await again.request('build.attach', { job })).toEqual({ id: 2, result: { outcome: null } });
      client.socket.close(1000);
      expect(await client.closed).toBe(1000);
      writeFileSync(gate, '');
      expect((await progress(again)).at(-1)).toMatchObject({ job, outcome: { ok: true } });
    },
  );

  test.skipIf(!fakeTailscale)('cancels a detached build when its client is revoked', async () => {
    const port = await start({
      env: { FAKE_WORKER_HANG: '1' },
      buildLimits: { killGraceMs: 100, detachGraceMs: 60_000 },
    });
    const { client, id } = await buildClient(port);
    await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
    client.socket.send(blob('x'));
    expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });
    await eventually(() => existsSync(join(root, 'job.json')));
    const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
    client.socket.terminate();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(true);
    expect(revokeDevice(id)).toBe(true);
    await eventually(() => !alive(pid));
  });

  test.skipIf(!fakeTailscale)(
    'cancels a build at once when its connection closes cleanly, and after the grace period when it drops',
    async () => {
      const port = await start({
        env: { FAKE_WORKER_HANG: '1' },
        buildLimits: { killGraceMs: 100, detachGraceMs: 1500 },
      });
      const pidOf = async () => {
        await eventually(() => existsSync(join(root, 'job.json')));
        const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
        rmSync(join(root, 'job.json'));
        return pid;
      };
      const run = async () => {
        const { client } = await buildClient(port);
        await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
        client.socket.send(blob('x'));
        expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });
        return { client, pid: await pidOf() };
      };

      const closing = await run();
      closing.client.socket.close(1000);
      await eventually(() => !alive(closing.pid));

      const dropping = await run();
      const dropped = Date.now();
      dropping.client.socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(alive(dropping.pid)).toBe(true);
      await eventually(() => !alive(dropping.pid));
      expect(Date.now() - dropped).toBeGreaterThanOrEqual(1500);
    },
  );

  test.skipIf(!fakeTailscale)(
    'refuses paths outside the mirror, and closes the connection on a blob it did not ask for or whose bytes differ',
    async () => {
      const port = await start();
      const { client } = await buildClient(port);
      for (const path of ['../escape', '/abs', 'a/./b', '.GIT/config', 'a//b']) {
        expect(
          await client.request('build.sync', { repo: 'app-1', files: [file(path, 'x')], done: true }),
        ).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
      client.socket.send(blob('unasked'));
      expect(await client.closed).toBe(4400);

      const { client: again } = await buildClient(port);
      await again.request('build.sync', { repo: 'app-1', files: [file('a', 'right')], done: true });
      again.socket.send(Buffer.concat([Buffer.from(sha('right'), 'hex'), Buffer.from('wrong')]));
      expect(await again.closed).toBe(4400);
    },
  );

  test.each([false, true])(
    'stops a revoked build and frees its claim with watch events dropped: %s',
    { skip: !fakeTailscale },
    async (dropEvents) => {
      registryWatch.dropEvents = dropEvents;
      const port = await start({ env: { FAKE_WORKER_HANG: '1' }, buildLimits: { killGraceMs: 100 } });
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });
      await eventually(() => existsSync(join(root, 'job.json')));
      const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
      const area = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1');
      expect(readClaimSet(`${area}.claims`).live).toHaveLength(1);

      const other = await buildClient(port, '100.64.0.3');
      expect(await other.client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 1, max: 1 } },
      });

      expect(revokeDevice(id)).toBe(true);
      expect(await client.closed).toBe(4401);
      await eventually(() => !alive(pid));
      await eventually(() => readClaimSet(`${area}.claims`).live.length === 0);
    },
  );

  describe('warm Gradle daemons', () => {
    const daemons: ChildProcess[] = [];
    const gradleHome = (client: string) => join(process.env.STIM_HOME!, 'build-worker', client, 'cache', 'gradle');
    const daemonOf = (client: string) => {
      const jar = join(gradleHome(client), 'wrapper', 'dists', 'gradle-9.4.1', 'lib', 'gradle-daemon-main-9.4.1.jar');
      mkdirSync(gradleHome(client), { recursive: true });
      const daemon = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', jar, 'org.gradle.launcher.daemon.bootstrap.GradleDaemon'],
        { stdio: 'ignore' },
      );
      daemons.push(daemon);
      return daemon;
    };
    const running = (daemon: ChildProcess) => daemon.exitCode === null && daemon.signalCode === null;
    const android = { variant: null, abi: 'arm64-v8a', gradleBuildCache: true, pch: 'auto', compilerCache: 'ccache' };
    const ANDROID_START = { ...START, platform: 'android', runtime: null, android };
    const launch = async (client: Client) => {
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const started = await client.request('build.start', ANDROID_START);
      return (started as { result: { job: string } }).result.job;
    };

    afterEach(() => {
      for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL');
    });

    test.skipIf(!fakeTailscale)(
      'tells the worker how long to keep the daemon, and stops an idle one once its client is revoked',
      async () => {
        configure({ offload: { maxLoadPerCore: 100_000, gradleDaemonIdleMinutes: 45 } });
        const port = await start({ buildLimits: { daemonSweepMs: 50, minFreeMemoryBytes: 0 } });
        const { client, id } = await buildClient(port);
        await launch(client);
        await progress(client);
        const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
        expect(ran.job.gradleDaemonIdleMs).toBe(45 * 60_000);

        const other = await buildClient(port, '100.64.0.3');
        const kept = daemonOf(other.id);
        const revoked = daemonOf(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(running(kept) && running(revoked)).toBe(true);
        expect(revokeDevice(id)).toBe(true);
        await eventually(() => !running(revoked));
        expect(running(kept)).toBe(true);
      },
    );

    test.skipIf(!fakeTailscale)(
      'stops idle daemons under low memory, but not one whose client is building',
      async () => {
        const gate = join(root, 'gate');
        const port = await start({
          env: { FAKE_WORKER_GATE: gate },
          buildLimits: { daemonSweepMs: 50, minFreeMemoryBytes: Number.MAX_SAFE_INTEGER },
        });
        const { client, id } = await buildClient(port);
        const other = await buildClient(port, '100.64.0.3');
        await launch(client);
        const building = daemonOf(id);
        const idle = daemonOf(other.id);
        await eventually(() => !running(idle));
        expect(running(building)).toBe(true);
        writeFileSync(gate, '');
        expect((await progress(client)).at(-1)).toMatchObject({ outcome: { ok: true } });
        await eventually(() => !running(building));
      },
    );

    test.skipIf(!fakeTailscale)("stops the client's daemon when its build is cancelled", async () => {
      const port = await start({
        env: { FAKE_WORKER_HANG: '1' },
        buildLimits: { killGraceMs: 100, minFreeMemoryBytes: 0 },
      });
      const { client, id } = await buildClient(port);
      const job = await launch(client);
      const daemon = daemonOf(id);
      expect(await client.request('build.cancel', { job })).toMatchObject({ result: {} });
      expect((await progress(client)).at(-1)).toMatchObject({ outcome: { ok: false, code: 'cancelled' } });
      await eventually(() => !running(daemon));
    });
  });
});

describe('health', () => {
  it('answers requests from this Mac in full and tailnet peers with the server version only', async () => {
    const port = await start();
    const local = await fetch(`http://127.0.0.1:${port}/health`);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({
      server: 'stim-server',
      name: 'Test Mac',
      version: '1.2.3',
      stim: '9.9.9',
      protocol: 1,
      stimHome: process.env.STIM_HOME,
      tailscale: { state: 'not-running', backendState: 'Stopped' },
    });
    const forwarded = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '100.64.0.2' } });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual({ server: 'stim-server', version: '1.2.3', protocol: 1 });
    const fromPage = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'x-forwarded-for': '100.64.0.2', origin: 'http://attacker.example' },
    });
    expect(fromPage.status).toBe(426);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/health', headers: { host: `attacker.example:${port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(rebound).toBe(426);
  });

  it('follows Tailscale coming up and going away after start', async () => {
    let next: TailscaleState = { state: 'unavailable', reason: 'it timed out' };
    const initial = { binary: null, state: next };
    const monitor = watchTailscale({
      env: {},
      initial,
      find: () => 'tailscale',
      read: async () => next,
      backoffMs: 10,
      maxMs: 20,
    });
    const port = await start({ tailscaleState: initial.state, tailscaleMonitor: monitor });
    const health = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { tailscale: unknown }).tailscale;
    const eventually = async (done: () => boolean | Promise<boolean>) => {
      for (let attempt = 0; attempt < 200 && !(await done()); attempt++) await new Promise((r) => setTimeout(r, 10));
      expect(await done()).toBe(true);
    };
    expect(await health()).toEqual({ state: 'unavailable', reason: 'it timed out' });
    expect(server!.addresses).toHaveLength(1);
    next = { state: 'running', ips: ['::1'], dnsName: 'mac.tail1.ts.net', hostName: 'mac' };
    await eventually(() => server!.addresses.length === 2);
    expect(server!.addresses[1]).toEqual({ host: '::1', port });
    expect(await health()).toEqual({ state: 'running', dnsName: 'mac.tail1.ts.net' });
    const tailnetClient = new WebSocket(`ws://[::1]:${port}`);
    clients.push(tailnetClient);
    await new Promise((resolve) => tailnetClient.once('open', resolve));
    const dropped = new Promise((resolve) => tailnetClient.once('close', resolve));
    next = { state: 'not-running', backendState: 'Stopped' };
    await eventually(() => server!.addresses.length === 1);
    await dropped;
    expect(await health()).toEqual({ state: 'not-running', backendState: 'Stopped' });
    monitor.stop();
  });

  it('listens again on a Tailscale address that failed to bind', async () => {
    let next: TailscaleState = { state: 'unavailable', reason: 'it timed out' };
    const monitor = watchTailscale({
      env: {},
      initial: { binary: null, state: next },
      find: () => 'tailscale',
      read: async () => next,
      backoffMs: 10,
      maxMs: 20,
    });
    const port = await start({ tailscaleState: next, tailscaleMonitor: monitor, listenRetryMs: 20 });
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(port, '::1', resolve));
    try {
      next = { state: 'running', ips: ['::1'], dnsName: null, hostName: null };
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(server!.addresses).toHaveLength(1);
      await new Promise((resolve) => blocker.close(resolve));
      for (let attempt = 0; attempt < 200 && server!.addresses.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server!.addresses).toEqual([
        { host: '127.0.0.1', port },
        { host: '::1', port },
      ]);
    } finally {
      monitor.stop();
      blocker.close();
    }
  });

  test.skipIf(!fakeTailscale)('reports the current tailscale serve route to the server', async () => {
    const serveStatus = join(root, 'serve.json');
    writeFileSync(serveStatus, '{}');
    const port = await start({
      tailscaleState: { state: 'running', ips: [], dnsName: 'mac.tail1.ts.net', hostName: 'mac' },
      env: { FAKE_SERVE_STATUS: serveStatus },
    });
    const route = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { route: unknown }).route;
    expect(await route()).toEqual({ state: 'missing', port: 7443 });
    writeFileSync(
      serveStatus,
      JSON.stringify({
        TCP: { '7443': { HTTPS: true } },
        Web: { 'mac.tail1.ts.net:7443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
      }),
    );
    expect(await route()).toEqual({ state: 'routed', port: 7443 });
  });
});

describe('unauthenticated connections', () => {
  it('refuses requests before hello', async () => {
    const port = await start();
    const client = await connect(port);
    expect(await client.request('status.subscribe')).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await client.closed).toBe(4401);
    expect(readdirSync(root)).not.toContain('pids');
  });

  test.skipIf(!fakeTailscale)(
    'closes a silent connection after the timeout and rate-limits repeated failures',
    async () => {
      const port = await start({ authTimeoutMs: 100, maxAuthFailures: 2 });
      const silent = await connect(port, '100.64.0.2');
      expect(await silent.closed).toBe(4408);
      const wrong = await connect(port, '100.64.0.2');
      await wrong.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: 'nope' } });

      await expect(connect(port, '100.64.0.2')).rejects.toThrow('HTTP 429');
      const otherPeer = await connect(port, '100.64.0.3');
      expect(otherPeer.socket.readyState).toBe(WebSocket.OPEN);
    },
  );
});

describe('a client that leaves during hello', () => {
  test.skipIf(!fakeTailscale)('keeps the pairing token and starts no status child', async () => {
    const port = await start({ whoisDelayMs: 300 });
    const { token } = createPairingToken();
    const leaving = await connect(port, '100.64.0.2');
    leaving.socket.send(
      JSON.stringify({
        id: 1,
        method: 'hello',
        params: { protocol: 1, client: CLIENT, auth: { pairingToken: token, deviceName: 'Gone' } },
      }),
    );
    leaving.socket.send(JSON.stringify({ id: 2, method: 'status.subscribe' }));
    leaving.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(readDevices()).toEqual([]);
    expect(readdirSync(root)).not.toContain('pids');
    const retry = await connect(port, '100.64.0.2');
    expect(
      await retry.request('hello', { protocol: 1, client: CLIENT, auth: { pairingToken: token, deviceName: 'Back' } }),
    ).toHaveProperty('result.deviceToken');
  });
});

describe('status.subscribe', () => {
  it('shares one status child across subscribers and stops it with the last one', async () => {
    const port = await start();
    const { token } = await pair(port);
    const first = await connect(port);
    await first.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    expect(await first.request('status.subscribe')).toEqual({ id: 2, result: { subscription: 's1' } });
    expect(await first.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[0] });
    expect(await first.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[1] });

    const [pid] = childPids();
    expect(readFileSync(join(pids, String(pid)), 'utf8')).toBe('status --watch --json');

    const second = await connect(port);
    await second.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    await second.request('status.subscribe');
    expect(await second.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[1] });
    expect(await second.request('status.subscribe')).toMatchObject({ result: { subscription: 's2' } });
    expect(await second.next()).toEqual({ event: 'status', subscription: 's2', payload: PAYLOADS[1] });
    expect(childPids()).toEqual([pid]);

    expect(await first.request('unsubscribe', { subscription: 's1' })).toEqual({ id: 3, result: {} });
    expect(await first.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(alive(pid!)).toBe(true);

    second.socket.close();
    await until(() => !alive(pid!));
  });

  it('stops the status child when the server closes', async () => {
    const port = await start();
    const { token } = await pair(port);
    const client = await connect(port);
    await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    await client.request('status.subscribe');
    await client.next();
    const [pid] = childPids();
    expect(alive(pid!)).toBe(true);

    await server!.close();
    server = null;
    await until(() => !alive(pid!));
  });

  it('sends the CPU and memory history beside the payload once a payload reports machine owners', async () => {
    const machine = {
      memorySource: 'footprint',
      owners: [
        {
          kind: 'simulator',
          name: 'sim',
          workspace: '/work/app',
          id: 'UDID-1',
          owned: true,
          cpuPercent: 12.5,
          residentMb: 3000,
          memoryMb: 1500,
          processes: 40,
        },
      ],
    };
    const port = await start({ env: { FAKE_STIM_PAYLOADS: JSON.stringify([{ ...PAYLOADS[1], machine }]) } });
    const { token } = await pair(port);
    const client = await connect(port);
    await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    await client.request('status.subscribe');
    const event = (await client.next()) as StatusEvent;
    expect(event.payload).toEqual({ ...PAYLOADS[1], machine });
    expect(event.usage).toMatchObject({
      intervalMs: 15_000,
      devices: [{ kind: 'simulator', id: 'UDID-1', workspace: '/work/app' }],
    });
    const [app] = event.usage!.environments;
    expect(app).toMatchObject({ workspace: '/work/app' });
    expect(app!.cpuPercent).toHaveLength(40);
    expect(app!.cpuPercent.filter((value) => value !== null)).toEqual([12.5]);
    expect(app!.memoryMb.filter((value) => value !== null)).toEqual([1500]);
  });

  it('ends the subscription with an error event when the status child exits', async () => {
    const port = await start({ exit: true });
    const { token } = await pair(port);
    const client = await connect(port);
    await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    await client.request('status.subscribe');
    await client.next();
    await client.next();
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'status-failed', message: 'stim status --watch exited (code 3): status failed on purpose' },
    });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });
});

describe('push.register', () => {
  const PUSH = {
    token: 'ExponentPushToken[abc123]',
    events: ['stuck', 'machine'],
    levels: { stuck: 'silent', machine: 'alert' },
    ref: 'mac-1',
    stuckMinutes: 20,
    quietHours: { start: 22 * 60, end: 7 * 60, timeZone: 'America/Toronto' },
  };

  it('stores the registration with the pairing and keeps a status child until it is removed', async () => {
    const port = await start();
    const { token } = await pair(port);
    const client = await connect(port);
    await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    expect(await client.request('push.register', PUSH)).toEqual({ id: 2, result: {} });
    expect(readDevices()[0]!.push).toMatchObject(PUSH);
    await until(() => childPids().length === 1);
    const [pid] = childPids();
    expect(readFileSync(join(pids, String(pid)), 'utf8')).toBe('status --watch --json');

    client.socket.close();
    await client.closed;
    expect(alive(pid!)).toBe(true);

    const again = await connect(port);
    await again.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    expect(await again.request('push.unregister')).toEqual({ id: 2, result: {} });
    expect(readDevices().every((device) => !device.push)).toBe(true);
    await until(() => !alive(pid!));
  });

  it('moves a token registered from a new pairing of the same phone off the old pairing', async () => {
    const port = await start();
    const first = await authed(port);
    await first.request('push.register', PUSH);
    const second = await authed(port);
    await second.request('push.register', PUSH);
    expect(readDevices().map((device) => device.push?.token)).toEqual([undefined, PUSH.token]);
  });

  it.each([false, true])('drops a revoked push registration with watch events dropped: %s', async (dropEvents) => {
    registryWatch.dropEvents = dropEvents;
    const port = await start();
    const client = await authed(port);
    await client.request('push.register', PUSH);
    await until(() => childPids().length === 1);
    const [pid] = childPids();
    revokeDevice(readDevices()[0]!.id);
    expect(readDevices()).toEqual([]);
    await until(() => !alive(pid!));
  });

  it('reads the events an older phone registers: disk as machine, the rest as nothing', async () => {
    const port = await start();
    const client = await authed(port);
    const legacy = { token: PUSH.token, events: ['build-failed', 'disk'], agentOnly: true, ref: 'mac-1' };
    expect(await client.request('push.register', legacy)).toEqual({ id: 2, result: {} });
    expect(readDevices()[0]!.push).toMatchObject({ events: ['machine'], stuckMinutes: 15, quietHours: null });
    expect(readDevices()[0]!.push!.levels).toBeUndefined();
  });

  it('refuses a token that is not an Expo push token and unknown events', async () => {
    const port = await start();
    const client = await authed(port);
    for (const params of [
      { ...PUSH, token: 'https://example.com/hook' },
      { ...PUSH, events: ['offline'] },
      { ...PUSH, events: [] },
      { ...PUSH, ref: '' },
      { ...PUSH, agentOnly: 'yes' },
      { ...PUSH, stuckMinutes: 0 },
      { ...PUSH, stuckMinutes: 2.5 },
      { ...PUSH, quietHours: { start: 1440, end: 0, timeZone: 'UTC' } },
      { ...PUSH, quietHours: { start: 0, end: 60, timeZone: 'Mars/Olympus' } },
      { ...PUSH, levels: { stuck: 'loud' } },
      { ...PUSH, levels: { offline: 'alert' } },
      { ...PUSH, levels: ['silent'] },
    ]) {
      expect(await client.request('push.register', params)).toMatchObject({ error: { code: 'bad-request' } });
    }
    expect(readDevices()[0]!.push).toBeUndefined();
  });
});

describe('logs.query', () => {
  it('runs stim logs --json in the workspace with the Desktop viewer filters and returns the records', async () => {
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('logs.query', {
      workspace,
      sources: ['client', 'metro'],
      level: 'warn',
      slot: 'tablet',
      grep: '-render',
      errors: true,
      tail: 50,
    });
    expect(reply).toEqual({ id: 2, result: { records: RECORDS } });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([
      {
        args: 'logs --json --tail=50 --source metro client --slot=tablet --level=warn --grep=-render --errors',
        cwd: workspace,
      },
    ]);
  });

  it('refuses an unregistered workspace and invalid filters without running stim', async () => {
    const port = await start();
    const client = await authed(port);
    const other = join(root, 'other');
    mkdirSync(other);
    expect(await client.request('logs.query', { workspace: other })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    for (const filter of [
      { tail: 5001 },
      { sources: ['nope'] },
      { sources: [] },
      { grep: '(' },
      { grep: 'a\0b' },
      { slot: 'tab\0let' },
      { slot: '--errors' },
      { level: 'loud' },
    ]) {
      for (const method of ['logs.query', 'logs.subscribe']) {
        expect(await client.request(method, { workspace, ...filter })).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
    }
    expect(await client.request('logs.query', { workspace })).toMatchObject({ result: { records: RECORDS } });
    expect(await client.request('logs.subscribe', { workspace: other })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([
      { args: 'logs --json --tail=5000', cwd: workspace },
    ]);
  });
});

describe('logs.subscribe', () => {
  it('shares one follow child per filter, replays the tail to a late subscriber, and stops with the last', async () => {
    const port = await start();
    const first = await authed(port);
    expect(await first.request('logs.subscribe', { workspace, tail: 2 })).toEqual({
      id: 2,
      result: { subscription: 's1' },
    });
    expect(await records(first, 3)).toEqual(RECORDS);
    const [pid] = childPids();
    expect(stimCalls().at(-1)).toEqual({ args: 'logs --json --follow --tail=2', cwd: workspace });

    const second = await authed(port);
    await second.request('logs.subscribe', { workspace, tail: 2 });
    expect(await records(second, 2)).toEqual(RECORDS.slice(1));
    expect(childPids()).toEqual([pid]);

    const errors = await authed(port);
    await errors.request('logs.subscribe', { workspace, tail: 2, errors: true });
    await records(errors, 3);
    expect(childPids()).toHaveLength(2);
    errors.socket.close();
    await until(() => childPids().length === 1);

    expect(await first.request('unsubscribe', { subscription: 's1' })).toEqual({ id: 3, result: {} });
    expect(alive(pid!)).toBe(true);
    second.socket.close();
    await until(() => !alive(pid!));
  });

  it('delivers the records it has, then an error event, when the follow child exits', async () => {
    const port = await start({ exit: true });
    const client = await authed(port);
    await client.request('logs.subscribe', { workspace });
    expect(await records(client, 3)).toEqual(RECORDS);
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'logs-failed', message: 'stim logs --follow exited (code 3): logs failed on purpose' },
    });
  });

  // Windows has no catchable SIGTERM: kill() always terminates the process.
  test.skipIf(process.platform === 'win32')(
    'kills a follow child that ignores SIGTERM when its last subscriber leaves or the server closes',
    async () => {
      const port = await start({ env: { FAKE_STIM_STUBBORN: '1' } });
      const client = await authed(port);
      await client.request('logs.subscribe', { workspace });
      await records(client, 3);
      const [pid] = childPids();
      client.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(pid!)).toBe(true);
      await until(() => !alive(pid!));

      const again = await authed(port);
      await again.request('logs.subscribe', { workspace });
      await records(again, 3);
      const next = childPids().find((other) => other !== pid);
      again.socket.send(JSON.stringify({ id: 9, method: 'settings.get' }));
      await until(() => childPids().length === 2);
      const command = childPids().find((other) => other !== pid && other !== next);
      await server!.close();
      server = null;
      expect([alive(next!), alive(command!)]).toEqual([false, false]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'waits on close for a follow child it is still stopping after its last subscriber left',
    async () => {
      const port = await start({ env: { FAKE_STIM_STUBBORN: '1' } });
      const client = await authed(port);
      await client.request('logs.subscribe', { workspace });
      await records(client, 3);
      const [pid] = childPids();
      expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
      await server!.close();
      server = null;
      expect(alive(pid!)).toBe(false);
    },
  );

  it('drops a client that stops reading and stops the child it no longer needs', async () => {
    const port = await start({
      env: { FAKE_STIM_FLOOD: '1' },
      logLimits: { maxBufferedBytes: 64 * 1024, maxPendingRecords: 200 },
    });
    const client = await authed(port);
    await client.request('logs.subscribe', { workspace });
    await until(() => childPids().length === 1);
    const [pid] = childPids();
    client.socket.pause();
    await until(() => !alive(pid!));

    client.socket.resume();
    let message = await client.next();
    while ('event' in message && message.event === 'logs') message = await client.next();
    expect(message).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'slow-client', message: expect.stringContaining('fell behind') },
    });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });
});

describe('machine.get', () => {
  it('reports the volumes holding Stim state, merged per volume, without running stim', async () => {
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('machine.get');
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const usage = reply.result as MachineUsage;
    const shared = usage.volumes.find((v) => v.holds.includes('Stim home'));
    expect(shared?.holds).toContain('Workspaces');
    expect(usage.volumes.filter((v) => v.holds.includes('Workspaces'))).toHaveLength(1);
    expect(shared!.freeBytes).toBeGreaterThan(0);
    expect(shared!.freeBytes).toBeLessThanOrEqual(shared!.totalBytes);
    expect(usage.memory.totalBytes).toBe(totalmem());
    expect(usage.load.cpus).toBeGreaterThan(0);
    expect(stimCalls()).toEqual([]);
  });
});

describe('machine.history', () => {
  it('refuses a non-numeric sinceMs', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('machine.history', { sinceMs: 'soon' })).toMatchObject({
      error: { code: 'bad-request' },
    });
  });
});

describe('machine.details', () => {
  it('shares the home stats read and gc dry run between read-only phones within a minute', async () => {
    const port = await start();
    const first = await authed(port);
    const second = await authed(port);
    const home = realpathSync(homedir());
    const expected = {
      gc: { command: 'gc', cwd: home },
      stats: readStatsReport(null, Date.now()).report,
      buildMachines: [],
      buildClients: [],
      measuredAt: expect.any(String),
    };
    const reply = await first.request('machine.details');
    expect(reply).toEqual({ id: 2, result: expected });
    expect(await second.request('machine.details')).toEqual(reply);
    expect(
      stimCalls()
        .map((call) => call.args)
        .toSorted(),
    ).toEqual(['gc --json']);
  });

  it('answers immediately with pending build machines, then reads them from doctor in the background', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    const ran = (at: string) => ({ doctorRuns: { ios: { at, version: '1.0.0' } } });
    writeFileSync(
      join(process.env.STIM_HOME!, 'config.json'),
      JSON.stringify({
        offload: { machines: ['mini'] },
        projects: {
          [workspace]: ran('2026-09-28T10:00:00.000Z'),
          [other]: ran('2026-09-28T11:00:00.000Z'),
          [join(root, 'gone')]: ran('2026-09-28T12:00:00.000Z'),
        },
      }),
    );
    const port = await start();
    const client = await authed(port);
    const first = await client.request('machine.details');
    expect(first).toMatchObject({ result: { buildMachines: null, buildMachinesPending: true } });

    let reply: unknown;
    for (let i = 0; i < 50; i++) {
      reply = await client.request('machine.details');
      if (!(reply as { result: { buildMachinesPending?: boolean } }).result.buildMachinesPending) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reply).toMatchObject({
      result: {
        buildMachines: [{ machine: 'mini', state: 'approved', args: 'doctor --json --platform ios' }],
        buildMachinesAt: expect.any(String),
      },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('doctor'))).toHaveLength(1);
    expect(stimCalls().find((call) => call.args.startsWith('doctor'))).toMatchObject({ cwd: other });

    expect(await client.request('machine.details')).toMatchObject({
      result: { buildMachines: [{ machine: 'mini', state: 'approved' }] },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('doctor'))).toHaveLength(1);
  });

  it('keeps the stats when gc fails, and says why gc is missing', async () => {
    const port = await start({ env: { FAKE_STIM_FAIL_COMMAND: 'gc' } });
    const client = await authed(port);
    expect(await client.request('machine.details')).toMatchObject({
      result: {
        gc: null,
        gcError: 'stim gc exited (code 1): gc failed on purpose',
        stats: { version: 1, machine: { ios: null, android: null } },
      },
    });
  });
});

describe.skipIf(process.platform !== 'darwin')('machine.get on macOS', () => {
  it("reports the Mac's memory used below its total", async () => {
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('machine.get');
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const { memory } = reply.result as MachineUsage;
    expect(memory.usedBytes).toBeGreaterThan(0);
    expect(memory.usedBytes).toBeLessThan(memory.totalBytes);
  });
});

describe('stats.get and settings.get', () => {
  it('read stats directly and run settings in the home directory', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('stats.get', { workspace })).toEqual({
      id: 2,
      result: readStatsReport(null, Date.now()).report,
    });
    expect(await client.request('settings.get')).toEqual({
      id: 3,
      result: { command: 'settings', cwd: realpathSync(homedir()) },
    });
    expect(stimCalls().map((call) => call.args)).toEqual(['settings --json']);
  });

  it('preserves seeded stats, rejects unregistered paths, and never repairs unreadable versions', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const file = join(process.env.STIM_HOME!, 'stats.json');
    const projectKey = realpathSync.native(workspace);
    const content = JSON.stringify({
      version: 1,
      machine: { ios: { runs: '3', hits: 2 } },
      projects: {
        [projectKey]: { android: { runs: 1, lastColdBuildMs: 1234 } },
      },
    });
    writeFileSync(file, content);
    const port = await start();
    const client = await authed(port);
    expect(await client.request('stats.get', { workspace })).toMatchObject({
      result: {
        version: 1,
        project: { key: projectKey, ios: null, android: { runs: 1, lastColdBuildMs: 1234 } },
        machine: { ios: { runs: 3, hits: 2 }, android: null },
      },
    });
    expect(readFileSync(file, 'utf8')).toBe(content);
    for (const invalid of [null, [], 'workspace']) {
      expect(await client.request('stats.get', invalid)).toMatchObject({ error: { code: 'bad-request' } });
    }
    expect(await client.request('stats.get', { workspace: root })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    for (const text of ['{broken', '{"version":999}']) {
      writeFileSync(file, text);
      expect(await client.request('stats.get', { workspace })).toMatchObject({
        result: {
          project: { key: projectKey, ios: null, android: null },
          machine: { ios: null, android: null },
        },
      });
      expect(readFileSync(file, 'utf8')).toBe(text);
      expect(readdirSync(process.env.STIM_HOME!).filter((name) => name.startsWith('stats'))).toEqual(['stats.json']);
    }
    expect(stimCalls()).toEqual([]);
  });

  it('bounds stats output and releases the request slot after refusal', async () => {
    const file = join(process.env.STIM_HOME!, 'stats.json');
    writeFileSync(file, JSON.stringify({ version: 1, buildMachines: { ['x'.repeat(2048)]: {} } }));
    const port = await start({ commandLimits: { maxOutputBytes: 1024 } });
    const client = await authed(port);
    expect(await client.request('stats.get')).toMatchObject({
      error: { code: 'stim-failed', message: 'stim stats printed more than 1024 bytes.' },
    });
    rmSync(file);
    expect(await client.request('stats.get')).toMatchObject({ result: { version: 1 } });
  });

  it('serves both stats consumers when the CLI entry is unavailable', async () => {
    const port = await start();
    rmSync(join(root, 'fake-stim.mjs'));
    const client = await authed(port);
    expect(await client.request('stats.get')).toMatchObject({ result: { version: 1 } });
    expect(await client.request('machine.details')).toMatchObject({
      result: {
        gc: null,
        gcError: expect.any(String),
        stats: { version: 1 },
      },
    });
  });

  it('force-kills an unresponsive read child and settles cancellation', async () => {
    const entry = join(root, 'blocked-read.mjs');
    const ready = join(root, 'blocked-read.pid');
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.READ_PID, String(process.pid));
while (true) {}
`,
    );
    const run = runNodeCommand(
      entry,
      { ...process.env, READ_PID: ready },
      [],
      root,
      { timeoutMs: 10_000, maxOutputBytes: 1024 },
      'stats fixture',
      true,
    );
    try {
      await until(() => existsSync(ready));
      const pid = Number(readFileSync(ready, 'utf8'));
      await run.cancel();
      expect(alive(pid)).toBe(false);
    } finally {
      await run.cancel();
    }
  });

  function slowGit(): { env: Record<string, string>; processes: () => number[] } {
    const bin = join(root, 'bin');
    const jobs = join(root, 'git-jobs');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    const script = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(require('node:path').join(process.env.STATS_GIT_JOBS, String(process.pid)), String(process.ppid));
require('node:net').createServer().listen(0, '127.0.0.1');
`;
    writeFileSync(join(bin, 'git'), script);
    chmodSync(join(bin, 'git'), 0o755);
    return {
      env: { PATH: bin + ':' + process.env.PATH, STATS_GIT_JOBS: jobs },
      processes: () => readdirSync(jobs).flatMap((pid) => [Number(pid), Number(readFileSync(join(jobs, pid), 'utf8'))]),
    };
  }

  test.skipIf(process.platform === 'win32')(
    'keeps another socket responsive, shares the command cap, and cancels stats plus its Git child on disconnect',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env });
      const first = await authed(port);
      const second = await authed(port);
      for (let id = 10; id < 14; id++)
        first.socket.send(JSON.stringify({ id, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length === 8);
      expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(await first.request('settings.get')).toMatchObject({ error: { code: 'limit-exceeded' } });
      const owned = slow.processes();
      first.socket.terminate();
      await until(() => owned.every((pid) => !alive(pid)));
      expect(await second.request('stats.get')).toMatchObject({ result: { version: 1 } });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'cancels a slow stats read and its Git child at timeout and server shutdown',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env, commandLimits: { timeoutMs: 1000 } });
      const client = await authed(port);
      const reply = client.request('stats.get', { workspace });
      await until(() => slow.processes().length === 2);
      expect(await reply).toMatchObject({
        error: { code: 'stim-failed', message: 'stim stats did not finish within 1 s.' },
      });
      expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
      client.socket.send(JSON.stringify({ id: 10, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length === 4);
      await server!.close();
      server = null;
      expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'keeps the shared details stats job after a socket closes and cancels it on server close',
    async () => {
      const slow = slowGit();
      const previous = process.env.HOME;
      process.env.HOME = root;
      writeFileSync(join(root, 'package.json'), '{}');
      try {
        const port = await start({ env: slow.env });
        const first = await authed(port);
        const second = await authed(port);
        first.socket.send(JSON.stringify({ id: 2, method: 'machine.details' }));
        await until(() => slow.processes().length === 2);
        first.socket.close();
        await first.closed;
        expect(slow.processes().every(alive)).toBe(true);
        second.socket.send(JSON.stringify({ id: 2, method: 'machine.details' }));
        await server!.close();
        server = null;
        expect(slow.processes().length).toBe(2);
        expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
      }
    },
  );

  it('report a failing command with its stderr', async () => {
    const port = await start({ env: { FAKE_STIM_FAIL: '1' } });
    const client = await authed(port);
    expect(await client.request('settings.get', { workspace })).toMatchObject({
      error: { code: 'stim-failed', message: 'stim settings exited (code 1): settings failed on purpose' },
    });
  });

  it('kill a running command when the client disconnects', async () => {
    const port = await start({ env: { FAKE_STIM_HANG: '1' } });
    const client = await authed(port);
    client.socket.send(JSON.stringify({ id: 2, method: 'settings.get', params: { workspace } }));
    await until(() => childPids().length === 1);
    const [pid] = childPids();
    expect(alive(pid!)).toBe(true);
    client.socket.terminate();
    await until(() => !alive(pid!));
  });

  it('kill a command that runs past its timeout', async () => {
    const port = await start({ env: { FAKE_STIM_HANG: '1' }, commandLimits: { timeoutMs: 300 } });
    const client = await authed(port);
    expect(await client.request('settings.get')).toMatchObject({
      error: { code: 'stim-failed', message: expect.stringContaining('did not finish') },
    });
    expect(childPids()).toEqual([]);
  });

  it('ends a command at its timeout while a grandchild still holds its output', async () => {
    const grandchild = join(root, 'grandchild.pid');
    const port = await start({ env: { FAKE_STIM_GRANDCHILD: grandchild }, commandLimits: { timeoutMs: 2000 } });
    const client = await authed(port);
    try {
      expect(await client.request('settings.get')).toMatchObject({
        error: { code: 'stim-failed', message: 'stim settings did not finish within 2 s.' },
      });
      expect(alive(Number(readFileSync(grandchild, 'utf8')))).toBe(true);
    } finally {
      if (existsSync(grandchild)) process.kill(Number(readFileSync(grandchild, 'utf8')), 'SIGKILL');
    }
  });
});

describe('build.plan', () => {
  it('runs the platform plan in the workspace, passing the slot as one argument', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('build.plan', { workspace, platform: 'android', slot: 'tablet' })).toEqual({
      id: 2,
      result: { platform: 'android', args: 'android --plan --json --slot=tablet', cwd: workspace, cacheHit: 'local' },
    });
    expect(stimCalls()).toEqual([{ args: 'android --plan --json --slot=tablet', cwd: workspace }]);
  });

  it('refuses a platform, slot or workspace it cannot plan, running nothing', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('build.plan', { workspace, platform: 'web' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    for (const slot of ['', '--device', 'a\u0000b']) {
      expect(await client.request('build.plan', { workspace, platform: 'ios', slot })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
    expect(await client.request('build.plan', { workspace: '/nowhere', platform: 'ios' })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('runs one plan at a time per workspace, across connections', async () => {
    const gate = join(root, 'plan-gate');
    const port = await start({ env: { FAKE_STIM_PLAN_GATE: gate } });
    const first = await authed(port);
    const second = await authed(port);
    const ios = first.request('build.plan', { workspace, platform: 'ios' });
    await until(() => childPids().length === 1);
    const android = second.request('build.plan', { workspace, platform: 'android' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stimCalls().map((call) => call.args)).toEqual(['ios --plan --json']);
    writeFileSync(gate, '');
    expect(await ios).toMatchObject({ result: { platform: 'ios' } });
    expect(await android).toMatchObject({ result: { platform: 'android' } });
    expect(stimCalls().map((call) => call.args)).toEqual(['ios --plan --json', 'android --plan --json']);
  });

  it('drops the queued plans of a closed connection and lets the next one run', async () => {
    const gate = join(root, 'plan-gate');
    const port = await start({ env: { FAKE_STIM_PLAN_GATE: gate } });
    const closing = await authed(port);
    const staying = await authed(port);
    void closing.request('build.plan', { workspace, platform: 'ios' });
    void closing.request('build.plan', { workspace, platform: 'android' });
    await until(() => childPids().length === 1);
    const plan = staying.request('build.plan', { workspace, platform: 'ios', slot: 'tablet' });
    closing.socket.close();
    await until(() => stimCalls().length === 2);
    writeFileSync(gate, '');
    expect(await plan).toMatchObject({ result: { platform: 'ios' } });
    expect(stimCalls().map((call) => call.args)).toEqual(['ios --plan --json', 'ios --plan --json --slot=tablet']);
    await until(() => childPids().length === 0);
  });

  it('keeps later plans waiting when a queued plan ahead of them is dropped', async () => {
    const gate = join(root, 'plan-gate');
    const port = await start({ env: { FAKE_STIM_PLAN_GATE: gate } });
    const staying = await authed(port);
    const closing = await authed(port);
    const ios = staying.request('build.plan', { workspace, platform: 'ios' });
    await until(() => childPids().length === 1);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    void closing.request('build.plan', { workspace, platform: 'ios', slot: 'tablet' });
    await settle();
    const android = staying.request('build.plan', { workspace, platform: 'android' });
    await settle();
    closing.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stimCalls().map((call) => call.args)).toEqual(['ios --plan --json']);
    writeFileSync(gate, '');
    expect(await ios).toMatchObject({ result: { platform: 'ios' } });
    expect(await android).toMatchObject({ result: { platform: 'android' } });
    expect(stimCalls().map((call) => call.args)).toEqual(['ios --plan --json', 'android --plan --json']);
  });

  it("reports the CLI's refusal code, message and remedy instead of its exit status", async () => {
    const port = await start({ env: { FAKE_STIM_REFUSE: '1' } });
    const client = await authed(port);
    expect(await client.request('build.plan', { workspace, platform: 'android' })).toMatchObject({
      error: { code: 'stim-failed', message: 'STIM_NO_DEVICE: No system image is installed. Install one.' },
    });
  });
});

describe('action', () => {
  it('refuses a read-only device, runs nothing, and audits the refusal', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
      error: { code: 'forbidden', message: expect.stringContaining('--control') },
    });
    expect(stimCalls()).toEqual([]);
    expect(readAudit()).toEqual([
      expect.objectContaining({
        device: { id: readDevices()[0]!.id, name: 'Test phone' },
        action: 'stop',
        workspace,
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' }),
      }),
    ]);
  });

  it('advertises the actions to a control device and stops honoring them once the Mac takes control back', async () => {
    const port = await start();
    const { id, token } = await pair(port, undefined, true);
    const client = await connect(port);
    expect(await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } })).toMatchObject({
      result: { capabilities: ['read', 'control'], actions: ['reload', 'stop'] },
    });
    expect(grantDevice(id, capabilitiesFor(false))).toBe('granted');
    expect(await client.request('action', { action: 'reload', workspace })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('refuses unknown actions, invalid params and workspaces the server does not list, running nothing', async () => {
    const port = await start();
    const client = await authed(port, true);
    const refusals = [
      [{ action: 'gc', workspace }, 'unknown-action'],
      [{ action: 'reload --delete', workspace }, 'unknown-action'],
      ['stop', 'bad-request'],
      [{ action: 'stop' }, 'bad-request'],
      [{ action: 'stop', workspace, platform: 'ios' }, 'bad-request'],
      [{ action: 'stop', workspace, args: ['--delete'] }, 'bad-request'],
      [{ action: 'reload', workspace, platform: '--help' }, 'bad-request'],
      [{ action: 'stop', workspace: join(root, 'other') }, 'unknown-workspace'],
      [{ action: 'stop', workspace: `${workspace}/` }, 'unknown-workspace'],
      [{ action: 'stop', workspace: `${workspace}/../app` }, 'unknown-workspace'],
    ] as const;
    for (const [params, code] of refusals) {
      expect(await client.request('action', params)).toMatchObject({ error: { code } });
    }
    expect(stimCalls()).toEqual([]);
    expect(readAudit().map((record) => record.error?.code)).toEqual(refusals.map(([, code]) => code));

    await client.request('action', { action: 'x'.repeat(10_000), workspace: 'y'.repeat(10_000) });
    const long = readAudit().at(-1)!;
    expect([long.action!.length, long.workspace!.length, long.error!.message.length]).toEqual([256, 256, 256]);
  });

  it('frees the workspace when the command cannot start', async () => {
    const file = join(root, 'not-a-dir');
    writeFileSync(file, '');
    writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ projects: { [file]: {} } }));
    const port = await start();
    const client = await authed(port, true);
    for (let i = 0; i < 2; i++) {
      expect(await client.request('action', { action: 'stop', workspace: file })).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('could not start') },
      });
    }
  });

  it('runs one fixed stim command in the workspace and audits the result', async () => {
    const port = await start();
    const client = await authed(port, true);
    expect(await client.request('action', { action: 'reload', workspace, platform: 'ios' })).toEqual({
      id: 2,
      result: { action: 'reload', workspace, output: { command: 'reload', cwd: workspace } },
    });
    await client.request('action', { action: 'reload', workspace });
    await client.request('action', { action: 'reload', workspace, platform: 'web' });
    await client.request('action', { action: 'stop', workspace });
    expect(stimCalls()).toEqual([
      { args: 'reload ios --json', cwd: workspace },
      { args: 'reload --json', cwd: workspace },
      { args: 'reload web --json', cwd: workspace },
      { args: 'stop --json', cwd: workspace },
    ]);
    const [first] = readAudit();
    expect(first).toEqual({
      at: expect.any(String),
      device: { id: readDevices()[0]!.id, name: 'Test phone' },
      action: 'reload',
      workspace,
      platform: 'ios',
      ok: true,
      durationMs: expect.any(Number),
    });
    expect(readAudit().map((record) => [record.action, record.ok])).toEqual([
      ['reload', true],
      ['reload', true],
      ['reload', true],
      ['stop', true],
    ]);
  });

  it('reports the error the command printed', async () => {
    const port = await start({ env: { FAKE_STIM_JSON_FAIL: '1' } });
    const client = await authed(port, true);
    expect(await client.request('action', { action: 'reload', workspace })).toMatchObject({
      error: { code: 'action-failed', message: 'STIM_NO_LIVE_APP: No live app in this workspace. Run stim ios.' },
    });
    expect(readAudit()).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'action-failed' }) }),
    ]);
  });

  it('runs one action per workspace at a time and ends one that runs past its timeout', async () => {
    const port = await start({ env: { FAKE_STIM_HANG: '1' }, actionLimits: { timeoutMs: 500 } });
    const client = await authed(port, true);
    const other = await authed(port, true);
    client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'stop', workspace } }));
    await until(() => childPids().length === 1);
    expect(await other.request('action', { action: 'reload', workspace })).toMatchObject({
      error: { code: 'action-busy' },
    });
    expect(await client.next()).toMatchObject({
      id: 10,
      error: { code: 'action-failed', message: expect.stringContaining('did not finish') },
    });
    expect(childPids()).toEqual([]);
    expect(readAudit().map((record) => record.error?.code)).toEqual(['action-busy', 'action-failed']);
  });

  it('keeps running an action when the client disconnects', async () => {
    const port = await start({ env: { FAKE_STIM_HANG: '1' }, actionLimits: { timeoutMs: 400 } });
    const client = await authed(port, true);
    client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'stop', workspace } }));
    await until(() => childPids().length === 1);
    const [pid] = childPids();
    client.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid!)).toBe(true);
    await until(() => readAudit().length === 1);
  });
});

function jpeg(width: number, height: number, tag: string): Buffer {
  const comment = Buffer.from(tag);
  const commentLength = Buffer.alloc(2);
  commentLength.writeUInt16BE(comment.length + 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), commentLength, comment, sof, Buffer.from([0xff, 0xd9])]);
}

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.FAKE_TOOL_CALLS, JSON.stringify({ tool: basename(process.argv[1]), args }) + '\\n');
if (env.FAKE_XCRUN_DELAYS && basename(process.argv[1]) === 'xcrun') {
  const delays = JSON.parse(env.FAKE_XCRUN_DELAYS);
  const counterFile = env.FAKE_XCRUN_DELAY_COUNTER;
  const seen = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
  writeFileSync(counterFile, String(seen + 1));
  const ms = delays[Math.min(seen, delays.length - 1)];
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
if (basename(process.argv[1]) === 'sips' && args.includes('bmp')) {
  const bmp = Buffer.alloc(58);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt16LE(24, 28);
  bmp.fill(readFileSync(args[args.indexOf('--out') - 1]).includes('BLACK') ? 0 : 255, 54, 57);
  writeFileSync(args[args.indexOf('--out') + 1], bmp);
  process.exit(0);
}
if (basename(process.argv[1]) === 'adb') process.exit(0);
if (args[0] === 'simctl' && args[1] === 'spawn' && env.FAKE_FOLD_GRANDCHILD) {
  const grandchild = require('node:child_process').spawn('sleep', ['30'], { stdio: 'inherit' });
  writeFileSync(env.FAKE_FOLD_GRANDCHILD, String(grandchild.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
}
if (args[0] === 'simctl' && args[1] === 'spawn') process.exit(0);
if (basename(process.argv[1]) === 'sips') {
  writeFileSync(args[args.indexOf('--out') + 1], Buffer.from(env.FAKE_SIPS_JPEG, 'base64'));
  process.exit(0);
}
if (env.FAKE_XCRUN_NO_PRIMARY && args.includes('--display=primary')) {
  process.stderr.write("Device does not have a 'primary' display port");
  process.exit(22);
}
if (env.FAKE_XCRUN_FAIL) {
  process.stderr.write('simctl failed on purpose');
  process.exit(2);
}
const frames = JSON.parse(env.FAKE_FRAMES);
const count = existsSync(env.FAKE_FRAME_COUNTER) ? Number(readFileSync(env.FAKE_FRAME_COUNTER, 'utf8')) : 0;
writeFileSync(env.FAKE_FRAME_COUNTER, String(count + 1));
writeFileSync(args.at(-1), Buffer.from(frames[Math.min(count, frames.length - 1)], 'base64'));
`;

const FAKE_HELPER = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const env = process.env;
const run = { tool: 'stim-frames', args: process.argv.slice(2), pid: process.pid, configs: [] };
const record = () => appendFileSync(env.FAKE_TOOL_CALLS, JSON.stringify(run) + '\\n');
process.on('exit', record);
process.on('SIGTERM', () => process.exit(0));
const message = (kind, body) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = kind;
  process.stdout.write(Buffer.concat([header, body]));
};
if (env.FAKE_HELPER_KEYBOARD) message(2, Buffer.from(JSON.stringify({ keyboard: env.FAKE_HELPER_KEYBOARD })));
if (env.FAKE_HELPER_STALLED) message(2, Buffer.from(JSON.stringify({ stalled: env.FAKE_HELPER_STALLED })));
if (env.FAKE_HELPER_STALL_CLEAR_MS) {
  setTimeout(() => message(2, Buffer.from(JSON.stringify({ stalled: null }))), Number(env.FAKE_HELPER_STALL_CLEAR_MS));
}
appendFileSync(env.FAKE_TOOL_CALLS + '.started', process.pid + '\\n');
if (env.FAKE_HELPER_FAIL && !env.FAKE_HELPER_FAIL_AFTER) {
  message(2, Buffer.from(JSON.stringify({ error: env.FAKE_HELPER_FAIL })));
  process.exit(1);
}
let lines = '';
let config = {};
let keyframe = true;
let recordKeyframe = true;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lines += chunk;
  for (let at = lines.indexOf('\\n'); at >= 0; at = lines.indexOf('\\n')) {
    const line = JSON.parse(lines.slice(0, at));
    run.configs.push(line);
    if (line.keyframe) keyframe = true;
    else if (line.recordKeyframe) recordKeyframe = true;
    else config = line;
    lines = lines.slice(at + 1);
  }
});
process.stdin.on('end', () => process.exit(0));
let sent = 0;
const displays = JSON.parse(env.FAKE_HELPER_DISPLAYS ?? '[]');
setInterval(() => {
  if (typeof displays[sent] === 'number') message(2, Buffer.from(JSON.stringify({ display: displays[sent] })));
  if (config.video) {
    const header = Buffer.alloc(13);
    header[0] = keyframe ? 1 : 0;
    header.writeDoubleBE(1759000000000 + sent, 1);
    header.writeUInt16BE(588, 9);
    header.writeUInt16BE(1280, 11);
    message(3, Buffer.concat([header, Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41, sent % 256])]));
    keyframe = false;
  }
  if (config.record && !(env.FAKE_HELPER_STATIC && !recordKeyframe)) {
    const header = Buffer.alloc(13);
    header[0] = recordKeyframe || sent % 5 === 0 ? 1 : 0;
    header.writeDoubleBE(Date.now() + 0.25, 1);
    header.writeUInt16BE(332, 9);
    header.writeUInt16BE(720, 11);
    message(4, Buffer.concat([header, Buffer.from([0, 0, 0, 1, sent % 5 === 0 ? 0x65 : 0x41, sent % 256])]));
    recordKeyframe = false;
  }
  if (config.jpeg === false) return sent++;
  const size = Buffer.alloc(4);
  size.writeUInt16BE(390, 0);
  size.writeUInt16BE(844, 2);
  message(1, Buffer.concat([size, Buffer.from('frame ' + sent++)]));
  if (env.FAKE_HELPER_FAIL_AFTER && sent >= Number(env.FAKE_HELPER_FAIL_AFTER)) {
    message(2, Buffer.from(JSON.stringify({ error: env.FAKE_HELPER_FAIL })));
    process.exit(1);
  }
}, Number(env.FAKE_HELPER_INTERVAL_MS ?? 50));
`;

function statusPayload(devices: Record<string, unknown>): unknown {
  return {
    environments: [{ path: workspace, live: true, memoryMb: 0, warnings: [], ...devices }],
    capacity: { liveCount: 1, committedMb: 0, totalMemoryMb: 1, overCapacity: false },
    deviceLeases: [],
    unprovisionedWorktrees: [],
    simctlAvailable: true,
  };
}

function statusWith(devices: Record<string, unknown>): string {
  return JSON.stringify([statusPayload(devices)]);
}

const OWNED_SIM = { name: 'stim-app (iPhone 17 27.0)', udid: 'SIM-1', owned: true, state: 'Booted' };

const OWNED_WEB = {
  browser: 'chrome',
  version: 'Chrome/153.0.8010.49',
  running: true,
  pid: 4242,
  supervisorPid: 4241,
  url: 'http://localhost:8081/',
  headless: true,
  viewport: 'desktop',
  profile: '/stim/web/profile',
  cdpEndpoint: 'http://127.0.0.1:8900',
  targetId: 'PAGE-1',
};

describe('frames.subscribe', () => {
  let toolCalls: string;

  async function startWithTools(
    env: Record<string, string>,
    frameLimits?: ServerOptions['frameLimits'],
    frameHelper?: string,
    recording?: Pick<ServerOptions, 'record' | 'recordLimits'>,
  ): Promise<number> {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const tool of ['xcrun', 'sips']) {
      writeFileSync(join(bin, tool), FAKE_TOOL);
      chmodSync(join(bin, tool), 0o755);
    }
    toolCalls = join(root, 'tools.ndjson');
    return start({
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_TOOL_CALLS: toolCalls,
        FAKE_FRAME_COUNTER: join(root, 'frame-counter'),
        ...env,
      },
      frameLimits,
      frameHelper,
      ...recording,
    });
  }

  function toolRuns(): { tool: string; args: string[] }[] {
    if (!existsSync(toolCalls)) return [];
    return readFileSync(toolCalls, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
  }

  test.skipIf(!fakeTailscale)(
    'sends a simulator screenshot when the screen changes and stops capturing with the last subscriber',
    async () => {
      const a = jpeg(390, 844, 'A');
      const b = jpeg(390, 844, 'B');
      const port = await startWithTools({
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: JSON.stringify([a, a, b].map((bytes) => bytes.toString('base64'))),
      });
      const first = await authed(port);
      expect(await first.request('frames.subscribe', { workspace, platform: 'ios', slot: 'default' })).toEqual({
        id: 2,
        result: { subscription: 's1' },
      });
      expect(await first.next()).toEqual({
        event: 'frame',
        subscription: 's1',
        platform: 'ios',
        slot: 'default',
        mime: 'image/jpeg',
        width: 390,
        height: 844,
        capturedAt: expect.any(String),
        data: a.toString('base64'),
      });
      const second = await authed(port);
      await second.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await second.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
      expect(readViewedDevices()).toEqual([{ platform: 'ios', id: 'SIM-1' }]);
      expect(await first.next()).toMatchObject({ event: 'frame', data: b.toString('base64') });
      expect(await second.next()).toMatchObject({ event: 'frame', data: b.toString('base64') });
      expect(toolRuns()[0]).toEqual({
        tool: 'xcrun',
        args: [
          'simctl',
          'io',
          'SIM-1',
          'screenshot',
          '--type=jpeg',
          '--display=primary',
          expect.stringMatching(/frame\.jpg$/),
        ],
      });

      first.socket.close();
      second.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(readViewedDevices()).toEqual([]);
      const settled = toolRuns().length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(toolRuns()).toHaveLength(settled);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('refuses devices Stim does not own or that are not running', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({
        ios: { ...OWNED_SIM, state: 'Shutdown' },
        android: { name: 'Pixel', owned: false, physical: false, serial: 'emulator-5556', state: 'detected' },
        slots: [{ slot: 'tablet', ios: { ...OWNED_SIM, owned: false }, android: null }],
      }),
      FAKE_FRAMES: '[]',
    });
    const client = await authed(port);
    const refusals = [
      [{ platform: 'ios' }, 'is Shutdown, not booted'],
      [{ platform: 'ios', slot: 'tablet' }, 'No simulator Stim owns'],
      [{ platform: 'android' }, 'No emulator Stim owns'],
    ] as const;
    for (const [target, message] of refusals) {
      const reply = await client.request('frames.subscribe', { workspace, ...target });
      if (!('result' in reply)) throw new Error(JSON.stringify(reply));
      const { subscription } = reply.result as { subscription: string };
      expect(await client.next()).toEqual({
        event: 'error',
        subscription,
        error: { code: 'frames-failed', message: expect.stringContaining(message) },
      });
    }
    for (const [target, message] of [
      [{ platform: 'web' }, 'No Stim-owned Chrome runs'],
      [{ platform: 'web', slot: 'tablet' }, 'in the default slot'],
    ] as const) {
      const reply = await client.request('frames.subscribe', { workspace, ...target });
      if (!('result' in reply)) throw new Error(JSON.stringify(reply));
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { message: expect.stringContaining(message) },
      });
    }
    expect(await client.request('frames.subscribe', { workspace, platform: 'tv' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(await client.request('frames.subscribe', { workspace: join(root, 'other'), platform: 'ios' })).toMatchObject(
      { error: { code: 'unknown-workspace' } },
    );
    expect(toolRuns()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)('ends the subscription when the simulator stops, and stops capturing', async () => {
    const booted = statusPayload({ ios: OWNED_SIM });
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: JSON.stringify([
        ...Array.from({ length: 25 }, () => booted),
        statusPayload({ ios: { ...OWNED_SIM, state: 'Shutdown' } }),
      ]),
      FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'frames-failed', message: expect.stringContaining('is Shutdown, not booted') },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = toolRuns().length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(toolRuns()).toHaveLength(settled);
  });

  test.skipIf(!fakeTailscale)('follows the lit iPhone Duo panel and reports its posture', async () => {
    const cover = jpeg(1398, 2034, 'cover');
    const inner = jpeg(2853, 2007, 'inner');
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
      FAKE_FRAMES: JSON.stringify(
        [cover, jpeg(2034, 1398, 'BLACK'), inner, jpeg(2853, 2007, 'inner 2')].map((bytes) => bytes.toString('base64')),
      ),
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 1398, height: 2034, posture: 'folded' });
    expect(await client.next()).toMatchObject({
      event: 'frame',
      width: 2853,
      height: 2007,
      data: inner.toString('base64'),
      posture: 'unfolded',
    });
    expect(await client.next()).toMatchObject({ event: 'frame', posture: 'unfolded' });
    const displays = toolRuns()
      .filter((run) => run.tool === 'xcrun')
      .map((run) => run.args.find((arg) => arg.startsWith('--display=')));
    expect(displays.slice(0, 4)).toEqual([
      '--display=primary',
      '--display=primary',
      '--display=primary-1',
      '--display=primary-1',
    ]);
    client.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = toolRuns().length;
    const again = await authed(port);
    await again.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await again.next()).toMatchObject({ event: 'frame', posture: 'unfolded' });
    expect(toolRuns()[before]?.args).toContain('--display=primary-1');
  });

  test.skipIf(!fakeTailscale)('captures the default display when simctl rejects primary', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
      FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
      FAKE_XCRUN_NO_PRIMARY: '1',
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(toolRuns()[1]?.args).not.toContain('--display=primary');
  });

  test.skipIf(!fakeTailscale)('ends the subscription when a capture fails', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
      FAKE_FRAMES: '[]',
      FAKE_XCRUN_FAIL: '1',
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'frames-failed', message: expect.stringContaining('simctl failed on purpose') },
    });
  });

  test.skipIf(!fakeTailscale)(
    'treats a slow or timed-out capture as delayed, keeps the last frame, and recovers',
    async () => {
      const a = jpeg(10, 20, 'A');
      const b = jpeg(10, 20, 'B');
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: JSON.stringify([a, b].map((bytes) => bytes.toString('base64'))),
          FAKE_XCRUN_DELAYS: JSON.stringify([200, 600, 20]),
          FAKE_XCRUN_DELAY_COUNTER: join(root, 'xcrun-delay-counter'),
        },
        { toolTimeoutMs: 400, slowCaptureMs: 150, failureBackoffMs: 100, maxConsecutiveFailures: 3 },
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios' });
      // The first capture is slow (200 ms, over slowCaptureMs) but succeeds.
      expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
      expect(await client.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
      // The second capture times out (600 ms, over toolTimeoutMs) and is retried instead of failing.
      // The third capture is fast (20 ms) and recovers.
      expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
      expect(await client.next()).toMatchObject({ event: 'frame', data: b.toString('base64') });
      expect(toolRuns().filter((run) => run.tool === 'xcrun')).toHaveLength(3);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'ends the subscription after captures keep timing out for a sustained period',
    async () => {
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: '[]',
          FAKE_XCRUN_DELAYS: JSON.stringify([300, 300]),
          FAKE_XCRUN_DELAY_COUNTER: join(root, 'xcrun-delay-counter'),
        },
        { toolTimeoutMs: 100, slowCaptureMs: 50, failureBackoffMs: 20, maxConsecutiveFailures: 2 },
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
      expect(await client.next()).toEqual({
        event: 'error',
        subscription: 's1',
        error: { code: 'frames-failed', message: expect.stringContaining('did not finish within') },
      });
    },
    10_000,
  );

  function fakeHelper(): string {
    const helper = join(root, 'stim-frames');
    writeFileSync(helper, FAKE_HELPER);
    chmodSync(helper, 0o755);
    return helper;
  }

  type HelperRun = { args: string[]; pid: number; configs: Record<string, unknown>[] };

  function helperRuns(): HelperRun[] {
    return toolRuns()
      .filter((run) => run.tool === 'stim-frames')
      .map((run) => run as unknown as HelperRun);
  }

  test.skipIf(!fakeTailscale)(
    'streams helper frames at the rate each subscriber asks for and stops the helper with the last one',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        undefined,
        fakeHelper(),
      );
      const slow = await authed(port);
      const fast = await authed(port);
      await slow.request('frames.subscribe', { workspace, platform: 'ios', fps: 2, maxEdge: 480 });
      await fast.request('frames.subscribe', { workspace, platform: 'ios', fps: 20, maxEdge: 960 });
      expect(await fast.next()).toMatchObject({ event: 'frame', platform: 'ios', mime: 'image/jpeg', width: 390 });
      const counted = { slow: 0, fast: 0 };
      slow.socket.on('message', () => counted.slow++);
      fast.socket.on('message', () => counted.fast++);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(counted.slow).toBeLessThanOrEqual(3);
      expect(counted.fast).toBeGreaterThanOrEqual(10);
      expect(counted.fast).toBeLessThanOrEqual(22);
      expect(helperRuns()).toEqual([]);
      fast.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      slow.socket.close();
      await until(() => helperRuns().length === 1);
      const [run] = helperRuns();
      expect(run!.args).toEqual(['ios', 'SIM-1']);
      const jpegOnly = { jpeg: true, video: false, bitrate: 3_000_000 };
      expect(run!.configs).toEqual([
        { fps: 2, maxEdge: 480, jpegFps: 2, ...jpegOnly },
        { fps: 20, maxEdge: 960, jpegFps: 20, ...jpegOnly },
        { fps: 2, maxEdge: 480, jpegFps: 2, ...jpegOnly },
      ]);
      await until(() => !alive(run!.pid));
      expect(toolRuns().filter((entry) => entry.tool === 'xcrun')).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams the owned Chrome page through the helper with its verified DevTools target',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ web: OWNED_WEB }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      expect(
        await client.request('frames.subscribe', { workspace, platform: 'web', fps: 60, video: ['h264'] }),
      ).toMatchObject({
        result: { video: 'h264' },
      });
      await new Promise((resolve) => client.socket.once('message', resolve));
      client.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['web', 'http://127.0.0.1:8900', '4242', 'PAGE-1']);
    },
    10_000,
  );

  function leasedPhonePayload(deviceName: string | null = 'Old iPhone'): string {
    const lease = { platform: 'ios', deviceName: null, grantedAt: null, expiresAt: null, mine: false, parsed: true };
    return JSON.stringify([
      {
        ...(statusPayload({ ios: OWNED_SIM }) as object),
        deviceLeases: [
          { ...lease, path: '/locks/other', id: 'PHONE-OTHER', holder: '/elsewhere', expired: false },
          { ...lease, path: '/locks/old', id: 'PHONE-OLD', holder: workspace, expired: true },
          { ...lease, path: '/locks/sim', id: 'SIM-1', holder: workspace, expired: false },
          { ...lease, path: '/locks/slot', id: 'PHONE-SLOT', slot: 'tablet', holder: workspace, expired: false },
          {
            ...lease,
            path: '/locks/phone',
            id: 'PHONE-1',
            deviceName,
            holder: workspace,
            expired: false,
          },
        ],
      },
    ]);
  }

  test.skipIf(!fakeTailscale)(
    "streams the physical iPhone the workspace leases in the slot, with the helper's stall reason until it clears",
    async () => {
      const locked = 'The iPhone is locked. Unlock it to see its screen.';
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: leasedPhonePayload(),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_STALLED: locked,
          FAKE_HELPER_STALL_CLEAR_MS: '600',
          FAKE_HELPER_INTERVAL_MS: '100000',
        },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      const stalled = { event: 'frame-delayed', subscription: 's1', delayed: true, reason: locked };
      expect(await client.next()).toEqual(stalled);
      const late = await authed(port);
      await late.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      expect(await late.next()).toEqual(stalled);
      expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
      expect(await late.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
      expect(readViewedDevices()).toEqual([]);
      client.socket.close();
      late.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['iphone', 'PHONE-1', 'Old iPhone']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'ends a physical iPhone subscription when the helper fails, without falling back to simctl',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: leasedPhonePayload(null), FAKE_FRAMES: '[]', FAKE_HELPER_FAIL: 'not cabled on purpose' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('not cabled on purpose') },
      });
      expect(toolRuns().filter((entry) => entry.tool === 'xcrun')).toEqual([]);
      expect(helperRuns()[0]!.args).toEqual(['iphone', 'PHONE-1']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    "never replays a slot's simulator footage for a physical iPhone",
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: leasedPhonePayload(), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '100000' },
        undefined,
        fakeHelper(),
      );
      const recordings = join(workspaceStateDir(workspace), 'recordings', 'ios-default');
      mkdirSync(recordings, { recursive: true });
      const at = Date.now() - 1000;
      const unit = Buffer.alloc(17);
      unit.writeUInt32BE(18, 0);
      unit.writeUInt8(1, 4);
      unit.writeDoubleBE(at, 5);
      unit.writeUInt16BE(330, 13);
      unit.writeUInt16BE(720, 15);
      writeFileSync(join(recordings, `${at}-${at}.seg`), Buffer.concat([unit, Buffer.from([0, 0, 0, 1, 0])]));
      const sim = await authed(port);
      expect(await sim.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], at })).toMatchObject({
        result: { subscription: 's1' },
      });
      sim.socket.close();
      const client = await authed(port);
      const target = { workspace, platform: 'ios', physical: true, video: ['h264'] };
      expect(await client.request('frames.subscribe', { ...target, at })).toMatchObject({
        error: { code: 'no-recording' },
      });
      await client.request('frames.subscribe', target);
      expect(await client.request('frames.seek', { subscription: 's1', at, rate: 0 })).toMatchObject({
        error: { code: 'no-recording' },
      });
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('refuses a physical iPhone the workspace holds no lease on', async () => {
    const port = await startWithTools(
      { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]' },
      undefined,
      fakeHelper(),
    );
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
    expect(await client.next()).toMatchObject({
      event: 'error',
      error: { code: 'frames-failed', message: expect.stringContaining('leases no physical iPhone') },
    });
    expect(helperRuns()).toEqual([]);
  });

  async function fakeChrome(browserPid: number): Promise<{ endpoint: string; close: () => Promise<void> }> {
    const http = createHttpServer((_, response) => {
      const { port } = http.address() as { port: number };
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/B` }));
    });
    const sockets = new WebSocketServer({ server: http });
    let shot = 0;
    sockets.on('connection', (socket) =>
      socket.on('message', (data) => {
        const { id, method, sessionId } = JSON.parse(String(data)) as {
          id: number;
          method: string;
          sessionId?: string;
        };
        const result =
          method === 'SystemInfo.getProcessInfo'
            ? { processInfo: [{ type: 'browser', id: browserPid }] }
            : method === 'Target.attachToTarget'
              ? { sessionId: 'S1' }
              : method === 'Page.captureScreenshot' && sessionId === 'S1'
                ? { data: jpeg(1280, 800, `page ${shot++}`).toString('base64') }
                : {};
        socket.send(JSON.stringify({ id, result }));
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };
    return {
      endpoint: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise((resolve) => {
          sockets.close();
          http.close(() => resolve());
          http.closeAllConnections();
        }),
    };
  }

  async function subscribeToFakeChrome(browserPid: number): Promise<ServerMessage> {
    const chrome = await fakeChrome(browserPid);
    try {
      const port = await startWithTools({
        FAKE_STIM_PAYLOADS: JSON.stringify([statusPayload({ web: { ...OWNED_WEB, cdpEndpoint: chrome.endpoint } })]),
        FAKE_FRAMES: '[]',
      });
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'web' });
      const message = await client.next();
      client.socket.close();
      return message;
    } finally {
      await chrome.close();
    }
  }

  test.skipIf(!fakeTailscale)('captures the owned Chrome page with screenshots without the helper', async () => {
    expect(await subscribeToFakeChrome(4242)).toMatchObject({
      event: 'frame',
      platform: 'web',
      width: 1280,
      height: 800,
    });
  });

  test.skipIf(!fakeTailscale)('refuses a DevTools port that another Chrome serves', async () => {
    expect(await subscribeToFakeChrome(999)).toMatchObject({
      event: 'error',
      error: { code: 'frames-failed', message: expect.stringContaining('not the owned Chrome 4242') },
    });
  });

  test.skipIf(!fakeTailscale)(
    'keeps the helper for a client that comes back within the linger time, and stops it after',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        { lingerMs: 600 },
        fakeHelper(),
      );
      const client = await authed(port);
      const oneFrame = async () => {
        const reply = await client.request('frames.subscribe', { workspace, platform: 'ios', maxEdge: 640 });
        const { subscription } = (reply as { result: { subscription: string } }).result;
        const frame = await client.next();
        expect(frame).toMatchObject({ event: 'frame', subscription });
        let done = await client.request('unsubscribe', { subscription });
        while (!('id' in done)) done = await client.next();
      };
      const started = () => readFileSync(`${toolCalls}.started`, 'utf8').split('\n').filter(Boolean);
      await oneFrame();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await oneFrame();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await oneFrame();
      expect(started()).toHaveLength(1);
      const pid = Number(started()[0]);
      expect(alive(pid)).toBe(true);
      await until(() => !alive(pid));
      expect(helperRuns()[0]!.configs).toHaveLength(1);
      await oneFrame();
      expect(started()).toHaveLength(2);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams H.264 as binary messages to a client that decodes it, and a keyframe on request',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      expect(
        await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 60, video: ['vp9', 'h264'] }),
      ).toMatchObject({ result: { subscription: 's1', video: 'h264' } });
      const packet = (await client.next()) as unknown as { binary: Buffer };
      expect(packet.binary.readUInt8(1)).toBe(1);
      expect(packet.binary.readUInt32BE(4)).toBe(0);
      expect(packet.binary.toString('ascii', 21, 23)).toBe('s1');
      expect([packet.binary.readUInt16BE(16), packet.binary.readUInt16BE(18)]).toEqual([588, 1280]);
      expect([...packet.binary.subarray(23, 28)]).toEqual([0, 0, 0, 1, 0x65]);
      expect(await client.request('frames.keyframe', { subscription: 's1' })).toMatchObject({ result: {} });
      let message = await client.next();
      while ('binary' in message && !((message as unknown as { binary: Buffer }).binary.readUInt8(1) & 1)) {
        message = await client.next();
      }
      expect(message).toHaveProperty('binary');
      expect(await client.request('frames.keyframe', { subscription: 's9' })).toMatchObject({
        error: { code: 'unknown-subscription' },
      });
      client.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs.slice(0, 2)).toEqual([
        { fps: 60, maxEdge: 1280, jpeg: false, video: true, bitrate: 3_000_000 },
        { keyframe: true },
      ]);
      expect(helperRuns()[0]!.configs.filter((line) => 'keyframe' in line)).toHaveLength(2);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams the lit iPhone Duo panel through the helper and reports its posture',
    async () => {
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_INTERVAL_MS: '10',
          FAKE_HELPER_DISPLAYS: JSON.stringify([0, ...Array(29).fill(null), 1]),
        },
        undefined,
        fakeHelper(),
      );
      const viewer = await authed(port);
      const tile = await authed(port);
      expect(
        await viewer.request('frames.subscribe', { workspace, platform: 'ios', fps: 60, video: ['h264'] }),
      ).toMatchObject({ result: { video: 'h264' } });
      await tile.request('frames.subscribe', { workspace, platform: 'ios', fps: 30 });
      const flags: number[] = [];
      while (!((flags.at(-1) ?? 0) & 4))
        flags.push(((await viewer.next()) as unknown as { binary: Buffer }).binary[1]!);
      expect(flags[0]).toBe(1 | 2);
      expect(flags.slice(1, -1).every((flag) => flag === 2)).toBe(true);
      const postures = new Set<unknown>();
      while (!postures.has('unfolded')) postures.add(((await tile.next()) as { posture?: string }).posture);
      expect([...postures]).toEqual(['folded', 'unfolded']);
      expect(helperRuns()).toEqual([]);
      expect(toolRuns().filter((run) => run.tool === 'xcrun')).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('sends JPEG frame events when no helper can encode video', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
      FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
    });
    const client = await authed(port);
    expect(
      await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 61, video: ['h264'] }),
    ).toMatchObject({ error: { code: 'bad-request' } });
    const reply = await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 60, video: ['h264'] });
    expect(reply).toMatchObject({ result: { subscription: 's1' } });
    expect(reply).not.toHaveProperty('result.video');
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(await client.request('frames.keyframe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(await client.request('frames.subscribe', { workspace, platform: 'ios', video: 'h264' })).toMatchObject({
      error: { code: 'bad-request' },
    });
  });

  test.skipIf(!fakeTailscale)('falls back to screenshots when the helper fails before its first frame', async () => {
    const port = await startWithTools(
      {
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
        FAKE_HELPER_FAIL: 'CoreSimulator could not be loaded.',
      },
      undefined,
      fakeHelper(),
    );
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(helperRuns()).toHaveLength(1);
    expect(toolRuns().some((run) => run.tool === 'xcrun')).toBe(true);
  });

  test.skipIf(!fakeTailscale)('ends the subscription when the helper fails after streaming', async () => {
    const port = await startWithTools(
      {
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: '[]',
        FAKE_HELPER_INTERVAL_MS: '10',
        FAKE_HELPER_FAIL_AFTER: '3',
        FAKE_HELPER_FAIL: 'The simulator went away.',
      },
      undefined,
      fakeHelper(),
    );
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 30 });
    let message = await client.next();
    while ('event' in message && message.event === 'frame') message = await client.next();
    expect(message).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'frames-failed', message: expect.stringContaining('The simulator went away.') },
    });
    expect(toolRuns().some((run) => run.tool === 'xcrun')).toBe(false);
  });

  const OWNED_EMULATOR = { name: 'stim-app', owned: true, physical: false, serial: 'emulator-5554', state: 'detected' };

  async function startControl(
    env: Record<string, string> = {},
    controlLimits?: ServerOptions['controlLimits'],
    pushEndpoint?: string,
  ) {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const tool of ['xcrun', 'sips', 'adb']) {
      writeFileSync(join(bin, tool), FAKE_TOOL);
      chmodSync(join(bin, tool), 0o755);
    }
    toolCalls = join(root, 'tools.ndjson');
    const home = join(root, 'fake-home');
    mkdirSync(home);
    return start({
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        ANDROID_HOME: '',
        ANDROID_SDK_ROOT: '',
        FAKE_TOOL_CALLS: toolCalls,
        FAKE_FRAME_COUNTER: join(root, 'frame-counter'),
        FAKE_FRAMES: '[]',
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, android: OWNED_EMULATOR }),
        ...env,
      },
      frameHelper: fakeHelper(),
      foldHelper: join(root, 'sim-fold'),
      controlLimits,
      pushEndpoint,
    });
  }

  function lockCalls(): string[] {
    return stimCalls()
      .map((call) => call.args)
      .filter((args) => args.startsWith('device '));
  }

  test.skipIf(!fakeTailscale)('refuses control to a device paired read-only, and logs it', async () => {
    const port = await startControl();
    const client = await authed(port);
    expect(await client.request('control.begin', { workspace, platform: 'ios' })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(await client.request('input.touch', { session: 'c1', phase: 'down', x: 0.5, y: 0.5 })).toMatchObject({
      error: { code: 'unknown-session' },
    });
    expect(readAudit()).toEqual([expect.objectContaining({ action: 'control.begin', ok: false })]);
    expect(lockCalls()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)('refuses control of a physical iPhone, which is view only', async () => {
    const port = await startControl();
    const client = await authed(port, true);
    expect(await client.request('control.begin', { workspace, platform: 'ios', physical: true })).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('view only') },
    });
    expect(lockCalls()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)(
    'sends input to the helper under a device lease and releases the lease when the session ends',
    async () => {
      const port = await startControl({}, { shapeChangesPerSecond: 1 });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, lease, postures } = begun.result as {
        session: string;
        lease: { expiresAt: string };
        postures: string[];
      };
      expect(lease.expiresAt).toEqual(expect.any(String));
      expect(postures).toEqual([]);
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.25, y: 0.75 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'Hi!\n' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'home' })).toMatchObject({ result: {} });
      expect(await client.request('input.rotate', { session, direction: 'left' })).toMatchObject({ result: {} });
      expect(await client.request('input.rotate', { session, direction: 'right' })).toMatchObject({
        error: { code: 'limit-exceeded', message: expect.stringContaining('rotate or fold') },
      });
      expect(await client.request('input.button', { session, button: 'back' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('input.posture', { session, posture: 'folded' })).toMatchObject({
        error: { code: 'bad-request', message: 'This device has no hinge.' },
      });
      expect(await client.request('input.text', { session, text: `caf${String.fromCharCode(233)}` })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs).toEqual([
        { fps: 0, maxEdge: 240, jpeg: false, video: false, bitrate: expect.any(Number) },
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, display: 0 },
        { input: 'text', text: 'Hi!\n' },
        { input: 'button', button: 'home' },
        { input: 'rotate', direction: 'left' },
      ]);
      await until(() => lockCalls().length === 2);
      expect(lockCalls()).toEqual(['device lock ios SIM-1 --for 2m --wait 0 --json', 'device unlock ios --json']);
      expect(readAudit().map((record) => record.action)).toEqual(['control.begin', 'control.end']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('tells status subscribers which device leases it holds for phones', async () => {
    const port = await startControl();
    const client = await authed(port, true);
    const watcher = await authed(port, true);
    await watcher.request('status.subscribe');
    expect(((await watcher.next()) as StatusEvent).ownLeases).toBeUndefined();
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    if (!('result' in begun)) throw new Error(JSON.stringify(begun));
    await until(() => lockCalls().length === 1);
    await watcher.request('status.subscribe');
    const event = (await watcher.next()) as StatusEvent;
    expect(event.ownLeases).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\dT/)]);
    await client.request('control.end', { session: (begun.result as { session: string }).session });
  });

  test.skipIf(!fakeTailscale)('types and presses buttons on an emulator with adb', async () => {
    const port = await startControl();
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'android' });
    const { session } = (begun as { result: { session: string } }).result;
    expect(await client.request('input.text', { session, text: "it's ok\b" })).toMatchObject({ result: {} });
    expect(await client.request('input.button', { session, button: 'app-switch' })).toMatchObject({ result: {} });
    expect(
      toolRuns()
        .filter((run) => run.tool === 'adb')
        .map((run) => run.args),
    ).toEqual([
      ['-s', 'emulator-5554', 'shell', 'input', 'text', "'it'\\''s%sok'"],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_DEL'],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH'],
    ]);
  });

  test.skipIf(!fakeTailscale)(
    'types and presses buttons through the helper on an emulator with a hardware keyboard',
    async () => {
      const port = await startControl({ FAKE_HELPER_KEYBOARD: 'yes' });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'android' });
      const { session } = (begun as { result: { session: string } }).result;
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.text', { session, text: "it's ok\b" })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'app-switch' })).toMatchObject({ result: {} });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs.slice(1)).toEqual([
        { input: 'text', text: "it's ok\b" },
        { input: 'button', button: 'app-switch' },
      ]);
      expect(toolRuns().filter((run) => run.tool === 'adb')).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'drives the owned Chrome page through the helper without a device lease',
    async () => {
      const port = await startControl({ FAKE_STIM_PAYLOADS: statusWith({ web: OWNED_WEB }) });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'web' });
      expect(begun).toMatchObject({ result: { platform: 'web', lease: null, postures: [] } });
      const { session } = (begun as { result: { session: string } }).result;
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'hi\n' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'back' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'home' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('input.rotate', { session, direction: 'left' })).toMatchObject({
        error: { code: 'bad-request', message: 'A web page does not rotate or fold.' },
      });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['web', 'http://127.0.0.1:8900', '4242', 'PAGE-1']);
      expect(helperRuns()[0]!.configs.slice(1)).toEqual([
        { input: 'touch', phase: 'down', x: 0.5, y: 0.5, display: 0 },
        { input: 'text', text: 'hi\n' },
        { input: 'button', button: 'back' },
      ]);
      expect(lockCalls()).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('refuses a page that another DevTools client drives, unless taken over', async () => {
    const driven = {
      ...OWNED_WEB,
      activity: { state: 'driven', driver: { tool: 'playwright', pid: 77, since: null }, basis: ['cdp-client'] },
    };
    const port = await startControl({ FAKE_STIM_PAYLOADS: statusWith({ web: driven }) });
    const client = await authed(port, true);
    expect(await client.request('control.begin', { workspace, platform: 'web' })).toMatchObject({
      error: { code: 'device-busy', message: expect.stringContaining('playwright') },
    });
    expect(await client.request('control.begin', { workspace, platform: 'web', takeOver: true })).toMatchObject({
      result: { platform: 'web' },
    });
  });

  test.skipIf(!fakeTailscale)(
    'folds an iPhone Duo with sim-fold only when its frames show the other posture',
    async () => {
      const port = await startControl(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
          FAKE_HELPER_DISPLAYS: '[0]',
        },
        { shapeChangesPerSecond: 100 },
      );
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session, postures } = (begun as { result: { session: string; postures: string[] } }).result;
      expect(postures).toEqual(['folded', 'unfolded']);
      expect(await client.request('input.rotate', { session, direction: 'left' })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({
        error: { code: 'action-failed' },
      });
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await viewer.next()).toMatchObject({ event: 'frame', posture: 'folded' });
      expect(await client.request('input.posture', { session, posture: 'folded' })).toMatchObject({ result: {} });
      expect(await client.request('input.posture', { session, posture: 'half-open' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      const spawns = () => toolRuns().filter((run) => run.args[1] === 'spawn');
      expect(spawns()).toEqual([]);
      expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({ result: {} });
      expect(spawns()).toEqual([{ tool: 'xcrun', args: ['simctl', 'spawn', 'SIM-1', join(root, 'sim-fold')] }]);
      expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({ result: {} });
      expect(spawns()).toHaveLength(1);
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.25, y: 0.75 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.touch', { session, phase: 'up', x: 0.25, y: 0.75, display: 0 })).toMatchObject(
        { result: {} },
      );
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      viewer.socket.close();
      await until(() => helperRuns().length > 0);
      expect(helperRuns().flatMap((run) => run.configs.filter((line) => 'input' in line))).toEqual([
        { input: 'rotate', direction: 'left' },
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, display: 1 },
        { input: 'touch', phase: 'up', x: 0.25, y: 0.75, display: 0 },
      ]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'ends a hung fold at its timeout while a grandchild still holds its output',
    async () => {
      const grandchild = join(root, 'grandchild.pid');
      const port = await startControl(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
          FAKE_HELPER_DISPLAYS: '[0]',
          FAKE_FOLD_GRANDCHILD: grandchild,
        },
        { shapeChangesPerSecond: 100, foldTimeoutMs: 500 },
      );
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session } = (begun as { result: { session: string } }).result;
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await viewer.next()).toMatchObject({ event: 'frame', posture: 'folded' });
      try {
        expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({
          error: { code: 'action-failed', message: 'sim-fold did not finish within 0.5 s.' },
        });
        await until(() => existsSync(grandchild));
        expect(() => process.kill(Number(readFileSync(grandchild, 'utf8')), 0)).not.toThrow();
      } finally {
        if (existsSync(grandchild)) process.kill(Number(readFileSync(grandchild, 'utf8')), 'SIGKILL');
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'moves the hinge of a foldable emulator and rotates it through the helper',
    async () => {
      const grpc = createHttp2Server();
      grpc.on('stream', (stream: ServerHttp2Stream) => {
        stream.resume();
        stream.on('end', () => {
          const value = Buffer.alloc(4);
          value.writeFloatLE(3);
          const message = Buffer.from([0x08, 0x10, 0x1a, 0x06, 0x0a, 0x04, ...value]);
          const header = Buffer.alloc(5);
          header.writeUInt32BE(message.length, 1);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end(Buffer.concat([header, message]));
        });
      });
      await new Promise<void>((resolve) => grpc.listen(0, '127.0.0.1', resolve));
      try {
        const port = await startControl();
        const running = join(root, 'fake-home/Library/Caches/TemporaryItems/avd/running');
        mkdirSync(running, { recursive: true });
        writeFileSync(
          join(running, `pid_${process.pid}.ini`),
          `port.serial=5554\ngrpc.port=${(grpc.address() as { port: number }).port}\n`,
        );
        const client = await authed(port, true);
        const begun = await client.request('control.begin', { workspace, platform: 'android' });
        const { session, postures } = (begun as { result: { session: string; postures: string[] } }).result;
        expect(postures).toEqual(['folded', 'half-open', 'unfolded']);
        await until(() => existsSync(`${toolCalls}.started`));
        expect(await client.request('input.posture', { session, posture: 'half-open' })).toMatchObject({ result: {} });
        expect(await client.request('input.rotate', { session, direction: 'right' })).toMatchObject({ result: {} });
        expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
        await until(() => helperRuns().length === 1);
        expect(helperRuns()[0]!.configs.slice(1)).toEqual([
          { input: 'posture', posture: 'half-open' },
          { input: 'rotate', direction: 'right' },
        ]);
        expect(toolRuns().filter((run) => run.tool === 'adb')).toEqual([]);
      } finally {
        await server?.close();
        server = null;
        await new Promise((resolve) => grpc.close(resolve));
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'refuses a device an agent drives, and takes it over only when asked, keeping the agent lease',
    async () => {
      const since = '2026-09-25T12:00:00.000Z';
      const port = await startControl({
        FAKE_STIM_PAYLOADS: statusWith({
          ios: {
            ...OWNED_SIM,
            activity: { state: 'driven', driver: { tool: 'agent-device', pid: 42, since }, basis: [] },
          },
        }),
        FAKE_STIM_LOCK_GRANTED: since,
      });
      const client = await authed(port, true);
      expect(await client.request('control.begin', { workspace, platform: 'ios' })).toMatchObject({
        error: { code: 'device-busy', message: expect.stringContaining('agent-device') },
      });
      const taken = await client.request('control.begin', { workspace, platform: 'ios', takeOver: true });
      const { session } = (taken as { result: { session: string } }).result;
      await client.request('control.end', { session });
      await until(() => readAudit().length === 3);
      expect(readAudit().map((record) => [record.action, record.ok])).toEqual([
        ['control.begin', false],
        ['control.take-over', true],
        ['control.end', true],
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lockCalls()).toEqual(['device lock ios SIM-1 --for 2m --wait 0 --json']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'lets one client control a device at a time, and ends the session another takes over',
    async () => {
      const port = await startControl();
      const first = await authed(port, true);
      const second = await authed(port, true);
      const begun = await first.request('control.begin', { workspace, platform: 'ios' });
      const { session } = (begun as { result: { session: string } }).result;
      expect(await second.request('control.begin', { workspace, platform: 'ios' })).toMatchObject({
        error: { code: 'device-busy', message: expect.stringContaining('Test phone') },
      });
      expect(await second.request('control.begin', { workspace, platform: 'ios', takeOver: true })).toMatchObject({
        result: { session: expect.any(String) },
      });
      expect(await first.next()).toMatchObject({ event: 'control-ended', session, reason: 'taken-over' });
      expect(await first.request('input.touch', { session, phase: 'down', x: 0, y: 0 })).toMatchObject({
        error: { code: 'unknown-session' },
      });
      second.socket.close();
      await until(() => lockCalls().includes('device unlock ios --json'));
      expect(lockCalls().filter((args) => args.startsWith('device unlock'))).toHaveLength(1);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'pushes a take-over to the phone that lost the device when it registered for control',
    async () => {
      const bodies: { to: string; body: string; data: unknown }[] = [];
      const expo = createHttpServer((request, response) => {
        let text = '';
        request.on('data', (chunk) => (text += chunk));
        request.on('end', () => {
          const messages = request.url?.endsWith('/send') ? (JSON.parse(text) as typeof bodies) : [];
          bodies.push(...messages);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 't' })) }));
        });
      });
      await new Promise<void>((resolve) => expo.listen(0, '127.0.0.1', resolve));
      try {
        const address = expo.address() as { port: number };
        const port = await startControl({}, undefined, `http://127.0.0.1:${address.port}/push`);
        const first = await authed(port, true);
        const second = await authed(port, true);
        const token = 'ExponentPushToken[first]';
        await first.request('push.register', { token, events: ['control'], ref: 'mac-1' });
        const listed = await first.request('notifications.list');
        expect(listed).toMatchObject({ result: { cursor: 0, notifications: [] } });
        const { log } = (listed as { result: { log: string } }).result;
        await second.request('notifications.list', { since: 0 });
        await first.request('control.begin', { workspace, platform: 'ios' });
        await second.request('control.begin', { workspace, platform: 'ios', takeOver: true });
        await until(() => bodies.length > 0);
        expect(bodies).toEqual([
          expect.objectContaining({
            to: token,
            body: 'Test phone took over the iOS device you were controlling',
            data: {
              ref: 'mac-1',
              notification: 1,
              target: 'device',
              path: workspace,
              platform: 'ios',
              slot: 'default',
            },
          }),
        ]);
        const entry = {
          seq: 1,
          id: `control:${workspace}:ios:default`,
          category: 'control',
          body: 'Test phone took over the iOS device you were controlling',
          target: { kind: 'device', path: workspace, platform: 'ios', slot: 'default' },
        };
        const events = [await first.next(), await first.next()];
        expect(events).toContainEqual({ event: 'notification', log, notification: expect.objectContaining(entry) });
        expect(await first.request('notifications.list', { since: 0 })).toMatchObject({
          result: { log, cursor: 1, notifications: [expect.objectContaining(entry)] },
        });
        expect(await second.request('notifications.list', { since: 0 })).toMatchObject({
          result: { log, cursor: 1, notifications: [] },
        });
        expect(await second.request('notifications.list', { since: -1 })).toMatchObject({
          error: { code: 'bad-request' },
        });
      } finally {
        await new Promise((resolve) => expo.close(resolve));
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('ends an idle session, and caps the input and typing rates', async () => {
    const port = await startControl({}, { idleMs: 700, inputPerSecond: 3, textCharsPerSecond: 1 });
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    const { session } = (begun as { result: { session: string } }).result;
    const replies = [];
    for (let i = 0; i < 5; i++)
      replies.push(await client.request('input.touch', { session, phase: 'move', x: 0, y: 0 }));
    expect(replies.filter((reply) => 'error' in reply)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'limit-exceeded' }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'limit-exceeded' }) }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await client.request('input.text', { session, text: 'x'.repeat(200) })).toMatchObject({ result: {} });
    expect(await client.request('input.text', { session, text: 'x'.repeat(100) })).toMatchObject({
      error: { code: 'limit-exceeded' },
    });
    expect(await client.next()).toMatchObject({ event: 'control-ended', session, reason: 'idle' });
    await until(() => lockCalls().includes('device unlock ios --json'));
  });

  test.each([false, true])(
    'ends a control session with watch events dropped: %s',
    { skip: !fakeTailscale },
    async (dropEvents) => {
      registryWatch.dropEvents = dropEvents;
      const port = await startControl();
      const { id, token } = await pair(port, undefined, true);
      const client = await connect(port);
      await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session } = (begun as { result: { session: string } }).result;
      grantDevice(id, capabilitiesFor(false));
      expect(await client.next()).toMatchObject({ event: 'control-ended', session, reason: 'forbidden' });
      await server!.close();
      server = null;
      expect(lockCalls()).toContain('device unlock ios --json');
    },
  );

  function leasedPhone(leases: Record<string, unknown>[]): string {
    const lease = {
      path: '/stim/device-locks/android.json',
      platform: 'android',
      deviceName: 'Pixel 8',
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      mine: false,
      expired: false,
      parsed: true,
    };
    const payload = statusPayload({ android: OWNED_EMULATOR }) as Record<string, unknown>;
    return JSON.stringify([
      { ...payload, deviceLeases: leases.map((entry) => ({ ...lease, holder: workspace, ...entry })) },
    ]);
  }

  test.skipIf(!fakeTailscale)(
    'streams the phone its workspace leases through the adb helper, and never another workspace or an emulator',
    async () => {
      const port = await startControl({
        FAKE_STIM_PAYLOADS: leasedPhone([
          { id: 'R58M1234ABC' },
          { id: 'OTHERPHONE', holder: '/work/other', slot: 'tablet' },
          { id: 'emulator-5556', slot: 'tablet', holder: workspace },
          { id: 'EXPIREDPHONE', slot: 'old', expired: true },
        ]),
      });
      const client = await authed(port);
      const subscribed = await client.request('frames.subscribe', { workspace, platform: 'android', physical: true });
      expect(subscribed).toMatchObject({ result: { subscription: expect.any(String) } });
      await until(() => existsSync(`${toolCalls}.started`));
      for (const slot of ['tablet', 'old']) {
        await client.request('frames.subscribe', { workspace, platform: 'android', physical: true, slot });
        expect(await client.next()).toMatchObject({
          event: 'error',
          error: { code: 'frames-failed', message: expect.stringContaining('leases no physical Android device') },
        });
      }
      await server!.close();
      server = null;
      await until(() => helperRuns().length === 1);
      const [run] = helperRuns();
      expect(run!.args.slice(0, 2)).toEqual(['android-device', 'R58M1234ABC']);
      expect(run!.args[2]).toBe('adb');
      expect(run!.args[3]).toMatch(/scrcpy\/scrcpy-server$/);
    },
  );

  test.skipIf(!fakeTailscale)(
    'the adb test switch resolves a leased emulator as a phone, and never an iPhone lease on the own simulator',
    async () => {
      const lease = {
        grantedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        mine: false,
        expired: false,
        parsed: true,
        deviceName: null,
        holder: workspace,
      };
      const payload = statusPayload({ ios: OWNED_SIM, android: OWNED_EMULATOR }) as Record<string, unknown>;
      const port = await startControl({
        STIM_SERVER_TEST_ADB_EMULATORS: '1',
        FAKE_STIM_PAYLOADS: JSON.stringify([
          {
            ...payload,
            deviceLeases: [
              { ...lease, path: '/locks/emu', platform: 'android', id: 'emulator-5554' },
              { ...lease, path: '/locks/sim', platform: 'ios', id: 'SIM-1' },
            ],
          },
        ]),
      });
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('leases no physical iPhone') },
      });
      await client.request('frames.subscribe', { workspace, platform: 'android', physical: true });
      await until(() => existsSync(`${toolCalls}.started`));
      await server!.close();
      server = null;
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args.slice(0, 2)).toEqual(['android-device', 'emulator-5554']);
    },
  );

  test.skipIf(!fakeTailscale)(
    'controls a phone only under the lease its workspace holds, and never takes or releases that lease',
    async () => {
      const port = await startControl({
        FAKE_STIM_PAYLOADS: leasedPhone([{ id: 'R58M1234ABC' }, { id: 'OTHERPHONE', slot: 'tablet', holder: '/w/b' }]),
      });
      const client = await authed(port, true);
      for (const takeOver of [false, true]) {
        expect(
          await client.request('control.begin', {
            workspace,
            platform: 'android',
            physical: true,
            slot: 'tablet',
            takeOver,
          }),
        ).toMatchObject({
          error: { code: 'action-failed', message: expect.stringContaining('leases no physical Android device') },
        });
      }
      const begun = await client.request('control.begin', { workspace, platform: 'android', physical: true });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, lease, postures } = begun.result as {
        session: string;
        lease: { expiresAt: string };
        postures: [];
      };
      expect(lease.expiresAt).toEqual(expect.any(String));
      expect(postures).toEqual([]);
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'hi\n' })).toMatchObject({ result: {} });
      for (const [method, params] of [
        ['input.rotate', { direction: 'left' }],
        ['input.posture', { posture: 'folded' }],
      ] as const) {
        expect(await client.request(method, { session, ...params })).toMatchObject({
          error: { code: 'bad-request', message: 'A physical device rotates and folds only in hand.' },
        });
      }
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await server!.close();
      server = null;
      expect(lockCalls()).toEqual([]);
      await until(() => helperRuns().length === 1);
      const run = helperRuns().find((entry) => entry.args[0] === 'android-device');
      expect(run?.configs.slice(1)).toEqual([
        { input: 'touch', phase: 'down', x: 0.5, y: 0.5, display: 0 },
        { input: 'text', text: 'hi\n' },
      ]);
    },
  );

  test.skipIf(!fakeTailscale)(
    'ends control of a phone once its lease expires, without another status update',
    async () => {
      const port = await startControl({
        FAKE_STIM_PAYLOADS: leasedPhone([{ id: 'R58M1234ABC', expiresAt: new Date(Date.now() + 4000).toISOString() }]),
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'android', physical: true });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session } = begun.result as { session: string };
      await new Promise((resolve) => setTimeout(resolve, 4100));
      const replies = [
        await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 }),
        await client.next(),
      ];
      expect(replies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'control-ended', session, reason: 'device-gone' }),
          expect.objectContaining({ error: expect.objectContaining({ code: 'unknown-session' }) }),
        ]),
      );
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('refuses frame rates and sizes outside the protocol range', async () => {
    const port = await startWithTools({ FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]' });
    const client = await authed(port);
    for (const params of [{ fps: 0 }, { fps: 31 }, { fps: 2.5 }, { maxEdge: 100 }, { maxEdge: 4096 }]) {
      expect(await client.request('frames.subscribe', { workspace, platform: 'ios', ...params })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
  });

  describe.skipIf(!fakeTailscale)('emulator screenshots over gRPC', () => {
    test.each([
      { device: 'a phone', posture: 0, folded: false, refused: false, reported: undefined },
      { device: 'a folded foldable', posture: 1, folded: true, refused: false, reported: 'folded' },
      { device: 'an unfolded foldable', posture: 3, folded: false, refused: false, reported: 'unfolded' },
      { device: 'an emulator that refuses POSTURE', posture: 3, folded: false, refused: true, reported: undefined },
    ])(
      'reads an emulator screenshot over gRPC with the discovery token and converts it to JPEG: $device',
      async ({ posture, folded, refused, reported }) => {
        const png = Buffer.from('not really a png');
        const requests: { path: string; authorization: string | undefined; body: Buffer }[] = [];
        const grpc = createHttp2Server();
        grpc.on('stream', (stream: ServerHttp2Stream, headers) => {
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            requests.push({
              path: String(headers[':path']),
              authorization: headers.authorization,
              body: Buffer.concat(chunks),
            });
            const value = Buffer.alloc(4);
            value.writeFloatLE(posture);
            const format = Buffer.from([
              0x18,
              0xa0,
              0x02,
              0x20,
              0xc0,
              0x04,
              ...(folded ? [0x3a, 0x06, 0x08, 0xb8, 0x08, 0x10, 0xac, 0x10] : []),
            ]);
            const physical = String(headers[':path']).endsWith('/getPhysicalModel');
            const message = physical
              ? Buffer.from([0x08, 0x10, 0x1a, 0x06, 0x0a, 0x04, ...value])
              : Buffer.concat([Buffer.from([0x0a, format.length]), format, Buffer.from([0x22, png.length]), png]);
            const frameHeader = Buffer.alloc(5);
            frameHeader.writeUInt32BE(message.length, 1);
            stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': physical && refused ? '12' : '0' }));
            stream.end(Buffer.concat([frameHeader, message]));
          });
        });
        await new Promise<void>((resolve) => grpc.listen(0, '127.0.0.1', resolve));
        const grpcPort = (grpc.address() as { port: number }).port;
        const home = join(root, 'fake-home');
        const running = join(home, 'Library/Caches/TemporaryItems/avd/running');
        mkdirSync(running, { recursive: true });
        writeFileSync(
          join(running, `pid_${process.pid}.ini`),
          `port.serial=5554\ngrpc.port=${grpcPort}\ngrpc.token=secret-token\n`,
        );
        const converted = jpeg(288, 640, 'android');
        try {
          const port = await startWithTools({
            HOME: home,
            FAKE_STIM_PAYLOADS: JSON.stringify([
              statusPayload({
                android: { name: 'stim-app', owned: true, physical: false, serial: 'emulator-5554', state: 'detected' },
              }),
              statusPayload({
                android: { name: 'stim-app', owned: true, physical: false, serial: null, state: 'unknown' },
              }),
            ]),
            FAKE_FRAMES: '[]',
            FAKE_SIPS_JPEG: converted.toString('base64'),
          });
          const client = await authed(port);
          await client.request('frames.subscribe', { workspace, platform: 'android' });
          const frame = await client.next();
          expect(frame).toMatchObject({
            event: 'frame',
            platform: 'android',
            slot: 'default',
            mime: 'image/jpeg',
            width: 288,
            height: 640,
            data: converted.toString('base64'),
          });
          expect((frame as { posture?: string }).posture).toBe(reported);
          expect(requests.slice(0, 2)).toMatchObject([
            {
              path: '/android.emulation.control.EmulatorController/getPhysicalModel',
              authorization: 'Bearer secret-token',
            },
            {
              path: '/android.emulation.control.EmulatorController/getScreenshot',
              authorization: 'Bearer secret-token',
            },
          ]);
          expect([...requests[0]!.body]).toEqual([0, 0, 0, 0, 2, 0x08, 0x10]);
          expect([...requests[1]!.body]).toEqual([0, 0, 0, 0, 6, 0x18, 0x80, 0x0a, 0x20, 0x80, 0x0a]);
          const seen = requests.length;
          await until(() => requests.length > seen + 1);
          expect(requests.filter((request) => request.path.endsWith('/getPhysicalModel'))).toHaveLength(1);
          expect(client.socket.readyState).toBe(WebSocket.OPEN);
          const [sips] = toolRuns();
          expect(sips?.tool).toBe('sips');
          expect(sips?.args.slice(0, 4)).toEqual(['-s', 'format', 'jpeg', '-s']);
          expect(readFileSync(sips!.args.at(-3)!)).toEqual(png);
        } finally {
          await server?.close();
          server = null;
          await new Promise((resolve) => grpc.close(resolve));
        }
      },
    );
  });

  describe('recording', () => {
    const DRIVEN = { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: null }, basis: [] };
    const RECORDING = { record: true, recordLimits: { segmentMs: 100 } };

    function deviceDir(): string {
      return join(workspaceStateDir(workspace), 'recordings', 'ios-default');
    }

    function registerWorkspaceDir(): void {
      mkdirSync(workspaceStateDir(workspace), { recursive: true });
      writeFileSync(join(workspaceStateDir(workspace), 'workspace.json'), JSON.stringify({ projectRoot: workspace }));
    }

    function segments(): { name: string; units: { keyframe: boolean; at: number }[] }[] {
      if (!existsSync(deviceDir())) return [];
      return readdirSync(deviceDir())
        .toSorted()
        .map((name) => {
          const bytes = readFileSync(join(deviceDir(), name));
          const units = [];
          for (let at = 0; at + 4 <= bytes.length; at += 4 + bytes.readUInt32BE(at)) {
            units.push({ keyframe: (bytes[at + 4]! & 1) !== 0, at: bytes.readDoubleBE(at + 5) });
          }
          return { name, units };
        });
    }

    const closed = () => segments().filter(({ name }) => name.endsWith('.seg'));

    test.skipIf(!fakeTailscale)(
      'records a driven simulator nobody watches into segments that start at a keyframe',
      async () => {
        registerWorkspaceDir();
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          RECORDING,
        );
        await until(() => closed().length >= 2);
        for (const { name, units } of closed()) {
          const [first, last] = name.replace('.seg', '').split('-').map(Number);
          expect(units[0]!.keyframe).toBe(true);
          expect(Math.floor(units[0]!.at)).toBe(first);
          expect(units.at(-1)!.at).toBeLessThanOrEqual(last!);
        }
        await server!.close();
        server = null;
        expect(segments().every(({ name }) => name.endsWith('.seg'))).toBe(true);
        const [run] = helperRuns();
        expect(run!.args).toEqual(['ios', 'SIM-1']);
        expect(run!.configs[0]).toEqual({
          fps: 10,
          maxEdge: 720,
          jpeg: false,
          video: false,
          bitrate: 3_000_000,
          record: { maxEdge: 720, fps: 10, bitrate: 1_000_000 },
        });
      },
      10_000,
    );

    test.skipIf(!fakeTailscale)('records an idle device only while a client watches it', async () => {
      registerWorkspaceDir();
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, recording: { enabled: true } }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        fakeHelper(),
        RECORDING,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(deviceDir())).toBe(false);
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], fps: 30 });
      await until(() => closed().length >= 1);
      client.socket.close();
      await until(() => segments().length > 0 && segments().every(({ name }) => name.endsWith('.seg')));
      const count = segments().length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(segments()).toHaveLength(count);
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs).toContainEqual(
        expect.objectContaining({ fps: 30, video: true, record: { maxEdge: 720, fps: 10, bitrate: 1_000_000 } }),
      );
    });

    test.skipIf(!fakeTailscale)(
      'stops capturing and deletes the recordings once status shows recording off',
      async () => {
        registerWorkspaceDir();
        const on = statusPayload({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } });
        const off = statusPayload({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: false } });
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: JSON.stringify([...Array.from({ length: 60 }, () => on), off]),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          RECORDING,
        );
        await until(() => closed().length >= 1);
        await until(() => !existsSync(join(workspaceStateDir(workspace), 'recordings')));
        await until(() => helperRuns().length === 1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(existsSync(join(workspaceStateDir(workspace), 'recordings'))).toBe(false);
      },
      10_000,
    );

    test.skipIf(!fakeTailscale)('keeps only the last footage of each device', async () => {
      registerWorkspaceDir();
      const started = Date.now();
      await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        fakeHelper(),
        { record: true, recordLimits: { segmentMs: 50, footageMs: 300, pruneMs: 100 } },
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const kept = closed().map(({ name }) => name.replace('.seg', '').split('-').map(Number) as [number, number]);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.reduce((sum, [first, last]) => sum + last - first, 0)).toBeLessThanOrEqual(500);
      expect(kept[0]![0]).toBeGreaterThan(started + 500);
    });

    test.skipIf(!fakeTailscale)(
      'asks for a keyframe once a segment is due, so a screen that does not change still gets segments',
      async () => {
        registerWorkspaceDir();
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
            FAKE_HELPER_STATIC: '1',
          },
          undefined,
          fakeHelper(),
          RECORDING,
        );
        await until(() => closed().length >= 1);
      },
      10_000,
    );

    test.skipIf(!fakeTailscale)(
      'records nothing while another stim-server holds the recording claim, and takes over when it frees',
      async () => {
        registerWorkspaceDir();
        const other = tryAcquireClaim({
          root: join(process.env.STIM_HOME!, 'server', 'recorder'),
          mode: 'exclusive',
        }).acquired!;
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          { record: true, recordLimits: { segmentMs: 100, pruneMs: 100 } },
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(existsSync(deviceDir())).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('another stim-server'));
        error.mockRestore();
        releaseClaim(other);
        await until(() => closed().length >= 1);
      },
      10_000,
    );

    describe('replay', () => {
      const BASE = Date.now() - 60_000;
      const STOPPED_SIM = { ...OWNED_SIM, state: 'Shutdown' };

      /** Writes a segment of units every 100 ms from `start`, a keyframe every 5 units. */
      function footage(first: number, count: number): void {
        mkdirSync(deviceDir(), { recursive: true });
        const units = Array.from({ length: count }, (_, i) => {
          const header = Buffer.alloc(17);
          header.writeUInt32BE(13 + 5, 0);
          header.writeUInt8(i % 5 === 0 ? 1 : 0, 4);
          header.writeDoubleBE(first + i * 100, 5);
          header.writeUInt16BE(330, 13);
          header.writeUInt16BE(720, 15);
          return Buffer.concat([header, Buffer.from([0, 0, 0, 1, i])]);
        });
        writeFileSync(join(deviceDir(), `${first}-${first + (count - 1) * 100}.seg`), Buffer.concat(units));
      }

      const packetAt = (message: ServerMessage) => (message as unknown as { binary: Buffer }).binary.readDoubleBE(8);

      async function untilMessage(client: Client, done: (message: ServerMessage) => boolean): Promise<ServerMessage[]> {
        const seen: ServerMessage[] = [];
        for (;;) {
          const message = await client.next();
          seen.push(message);
          if (done(message)) return seen;
        }
      }

      test.skipIf(!fakeTailscale)(
        "replays a stopped device's footage from a time, plays it to the end, and cannot go live",
        async () => {
          registerWorkspaceDir();
          footage(BASE, 20);
          footage(BASE + 30_000, 5);
          const port = await startWithTools(
            { FAKE_STIM_PAYLOADS: statusWith({ ios: STOPPED_SIM, recording: { enabled: true } }) },
            undefined,
            fakeHelper(),
            { record: true },
          );
          const client = await authed(port);
          expect(
            await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], at: BASE + 730 }),
          ).toMatchObject({ result: { subscription: 's1', video: 'h264' } });
          const shown = await untilMessage(
            client,
            (message) => 'binary' in message && packetAt(message) === BASE + 700,
          );
          expect(shown.map(packetAt)).toEqual([BASE + 500, BASE + 600, BASE + 700]);

          client.socket.send(
            JSON.stringify({ id: 50, method: 'frames.seek', params: { subscription: 's1', at: BASE + 1500, rate: 2 } }),
          );
          const played = await untilMessage(
            client,
            (message) => 'event' in message && message.event === 'replay-ended',
          );
          expect(played).toContainEqual({ id: 50, result: { at: BASE + 1500 } });
          expect(played.filter((message) => 'binary' in message).map(packetAt)).toEqual([
            ...[1500, 1600, 1700, 1800, 1900].map((offset) => BASE + offset),
            ...[0, 100, 200, 300, 400].map((offset) => BASE + 30_000 + offset),
          ]);
          expect(played.at(-1)).toEqual({ event: 'replay-ended', subscription: 's1', at: BASE + 30_400 });

          client.socket.send(
            JSON.stringify({
              id: 51,
              method: 'frames.seek',
              params: { subscription: 's1', at: BASE + 30_400, rate: 2 },
            }),
          );
          const atEnd = await untilMessage(client, (message) => 'event' in message && message.event === 'replay-ended');
          expect(atEnd.filter((message) => !('binary' in message))).toEqual([
            { id: 51, result: { at: BASE + 30_400 } },
            { event: 'replay-ended', subscription: 's1', at: BASE + 30_400 },
          ]);

          expect(await client.request('frames.live', { subscription: 's1' })).toMatchObject({
            error: { code: 'frames-failed', message: expect.stringContaining('not booted') },
          });
          client.socket.send(
            JSON.stringify({
              id: 70,
              method: 'frames.seek',
              params: { subscription: 's1', at: BASE + 60_000, rate: 0 },
            }),
          );
          const past = await untilMessage(client, (message) => 'id' in message && message.id === 70);
          expect(past.at(-1)).toEqual({ id: 70, result: { at: BASE + 30_400 } });
          expect(
            await client.request('frames.subscribe', {
              workspace,
              platform: 'ios',
              slot: '../../other',
              video: ['h264'],
              at: BASE,
            }),
          ).toMatchObject({ error: { code: 'bad-request' } });
          expect(helperRuns()).toEqual([]);
        },
        10_000,
      );

      test.skipIf(!fakeTailscale)('seeks a live subscription into the footage and returns to live', async () => {
        registerWorkspaceDir();
        footage(BASE, 10);
        const port = await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          { record: true },
        );
        const client = await authed(port);
        await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], fps: 30 });
        await untilMessage(client, (message) => 'binary' in message);
        client.socket.send(
          JSON.stringify({ id: 60, method: 'frames.seek', params: { subscription: 's1', at: BASE + 200, rate: 0 } }),
        );
        const seeked = await untilMessage(client, (message) => 'id' in message && message.id === 60);
        expect(seeked.at(-1)).toEqual({ id: 60, result: { at: BASE + 200 } });
        expect(
          seeked
            .filter((message) => 'binary' in message)
            .map(packetAt)
            .slice(-3),
        ).toEqual([BASE, BASE + 100, BASE + 200]);
        client.socket.send(JSON.stringify({ id: 61, method: 'frames.live', params: { subscription: 's1' } }));
        expect((await untilMessage(client, (message) => 'id' in message && message.id === 61)).at(-1)).toEqual({
          id: 61,
          result: {},
        });
        const live = await untilMessage(client, (message) => 'binary' in message);
        expect(packetAt(live.at(-1)!)).toBeLessThan(1_800_000_000_000);
        expect(packetAt(live.at(-1)!)).toBeGreaterThan(1_758_000_000_000);
      });

      test.skipIf(!fakeTailscale)('a seek on a device with no recording stays live', async () => {
        registerWorkspaceDir();
        const port = await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          { record: false },
        );
        const client = await authed(port);
        await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], fps: 30 });
        await untilMessage(client, (message) => 'binary' in message);
        client.socket.send(
          JSON.stringify({ id: 80, method: 'frames.seek', params: { subscription: 's1', at: BASE, rate: 0 } }),
        );
        const refused = await untilMessage(client, (message) => 'id' in message && message.id === 80);
        expect(refused.at(-1)).toMatchObject({ id: 80, error: { code: 'no-recording' } });
        const next = await untilMessage(client, (message) => 'binary' in message);
        expect(packetAt(next.at(-1)!)).toBeLessThan(1_760_000_000_000);
      });

      test.skipIf(!fakeTailscale)(
        'serves the keyframe of the segment covering a time, a few reads at a time',
        async () => {
          registerWorkspaceDir();
          footage(BASE, 10);
          footage(BASE + 30_000, 10);
          const port = await startWithTools(
            { FAKE_STIM_PAYLOADS: statusWith({ ios: STOPPED_SIM, recording: { enabled: true } }) },
            undefined,
            fakeHelper(),
            { record: true },
          );
          const client = await authed(port);
          const keyframe = (at: unknown, platform = 'ios') =>
            client.request('replay.keyframe', { workspace, platform, at });

          expect(await keyframe(BASE + 850)).toMatchObject({
            result: {
              start: BASE,
              end: BASE + 900,
              at: BASE,
              width: 330,
              height: 720,
              data: Buffer.from([0, 0, 0, 1, 0]).toString('base64'),
            },
          });
          expect(await keyframe(BASE + 10_000)).toMatchObject({ result: { start: BASE + 30_000, at: BASE + 30_000 } });
          expect(await keyframe(BASE, 'android')).toMatchObject({ error: { code: 'no-recording' } });
          expect(await keyframe('soon')).toMatchObject({ error: { code: 'bad-request' } });

          const burst = Array.from({ length: 20 }, () => keyframe(BASE));
          const answers = await Promise.all(burst);
          const limited = answers.filter((answer) => 'error' in answer);
          expect(limited.length).toBeGreaterThan(0);
          expect(limited).toEqual(
            limited.map(() => expect.objectContaining({ error: expect.objectContaining({ code: 'limit-exceeded' }) })),
          );
          expect(await keyframe(BASE)).toMatchObject({ result: { at: BASE } });
        },
      );

      test.skipIf(!fakeTailscale)('lists the recorded spans and the markers of the device', async () => {
        registerWorkspaceDir();
        footage(BASE, 10);
        footage(BASE + 30_000, 10);
        const logged = [
          { ts: BASE + 300, src: 'agent', event: 'agent_action', platform: 'ios', command: 'press', msg: 'press @e3' },
          { ts: BASE + 400, src: 'agent', event: 'agent_action', platform: 'android', command: 'press', msg: 'other' },
          { ts: BASE + 30_500, src: 'build', level: 'error', msg: 'Compile failed' },
        ];
        const port = await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: STOPPED_SIM, recording: { enabled: true } }),
            FAKE_STIM_RECORDS: JSON.stringify(logged),
            FAKE_STIM_BY_SOURCE: '1',
          },
          undefined,
          fakeHelper(),
          { record: true },
        );
        const client = await authed(port);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await client.request('replay.range', { workspace, platform: 'ios' })).toEqual({
          id: 2,
          result: {
            enabled: true,
            recording: false,
            spans: [
              { start: BASE, end: BASE + 900 },
              { start: BASE + 30_000, end: BASE + 30_900 },
            ],
            markers: [
              { at: BASE + 300, kind: 'action', command: 'press', label: 'press @e3' },
              { at: BASE + 30_500, kind: 'error', label: 'Compile failed' },
            ],
          },
        });
        const logs = readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line.includes('"logs'));
        expect(logs.map((line) => JSON.parse(line).args)).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^logs --json --source agent --since=\d+m --tail=5000$/),
            expect.stringMatching(/^logs --json --source metro client build device --level=error --since=\d+m/),
          ]),
        );
        expect(await client.request('replay.range', { workspace, platform: 'android' })).toMatchObject({
          result: { spans: [], markers: [] },
        });
      });
    });

    test.skipIf(!fakeTailscale)('turns recording off at machine scope for a device with control only', async () => {
      const port = await startWithTools({ FAKE_STIM_PAYLOADS: '[]' }, undefined, fakeHelper(), { record: true });
      const reader = await authed(port);
      expect(await reader.request('recording.set', { enabled: false })).toMatchObject({ error: { code: 'forbidden' } });
      const controller = await authed(port, true);
      expect(await controller.request('recording.set', { enabled: 'no' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await controller.request('recording.set', { enabled: false })).toMatchObject({
        result: { enabled: false, recordingsDeleted: [] },
      });
      const settings = readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"settings'))
        .map((line) => JSON.parse(line));
      expect(settings).toEqual([
        { args: 'settings set recording.enabled false --scope machine --json', cwd: homedir() },
      ]);
      expect(readAudit().map((entry) => [entry.action, entry.ok])).toEqual([
        ['recording.set', false],
        ['recording.set', false],
        ['recording.set', true],
      ]);
    });

    test.skipIf(!fakeTailscale)('runs recording.set requests one at a time, so the last one wins', async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: '[]', FAKE_STIM_SETTINGS_MS: '200' },
        undefined,
        fakeHelper(),
        { record: true },
      );
      const first = await authed(port, true);
      const second = await authed(port, true);
      const settingsLines = () =>
        existsSync(calls)
          ? readFileSync(calls, 'utf8')
              .split('\n')
              .filter((line) => line.includes('settings set'))
              .map((line) => JSON.parse(line) as { args?: string; ended?: string })
          : [];
      const off = first.request('recording.set', { enabled: false });
      await until(() => settingsLines().length === 1);
      const on = second.request('recording.set', { enabled: true });
      expect(await off).toMatchObject({ result: { enabled: false } });
      expect(await on).toMatchObject({ result: { enabled: true } });
      const set = (value: boolean) => `settings set recording.enabled ${value} --scope machine --json`;
      expect(settingsLines().map((line) => line.args ?? `ended ${line.ended}`)).toEqual([
        set(false),
        `ended ${set(false)}`,
        set(true),
        `ended ${set(true)}`,
      ]);
    });

    test.skipIf(!fakeTailscale)('closes while a recording.set runs and starts none queued behind it', async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: '[]', FAKE_STIM_SETTINGS_MS: '30000' },
        undefined,
        fakeHelper(),
        { record: true },
      );
      const first = await authed(port, true);
      const second = await authed(port, true);
      first.socket.send(JSON.stringify({ id: 90, method: 'recording.set', params: { enabled: false } }));
      await until(() => stimCalls().some((call) => call.args?.startsWith('settings set')));
      second.socket.send(JSON.stringify({ id: 91, method: 'recording.set', params: { enabled: true } }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await server!.close();
      server = null;
      expect(stimCalls().filter((call) => call.args?.startsWith('settings set'))).toHaveLength(1);
    });

    test.skipIf(!fakeTailscale)('never fills a workspace directory that has no workspace.json', async () => {
      await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        fakeHelper(),
        RECORDING,
      );
      await until(() => existsSync(`${toolCalls}.started`));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(workspaceStateDir(workspace))).toBe(false);
    });
  });
});
