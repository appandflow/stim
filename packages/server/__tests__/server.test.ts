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
import { get } from 'node:http';
import { createServer as createHttp2Server, type ServerHttp2Stream } from 'node:http2';
import { homedir, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { HelloResult, MachineUsage, ServerMessage } from '../src/protocol.ts';
import { readAudit } from '../src/actions.ts';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  PAIRING_TTL_MS,
  readDevices,
  revokeDevice,
} from '../src/registry.ts';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';

const FAKE_STIM = `
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const record of JSON.parse(env.FAKE_STIM_RECORDS)) print(record);
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
} else if (env.FAKE_STIM_REFUSE) {
  print({ code: 'STIM_NO_DEVICE', message: 'No system image is installed.', remedy: 'Install one.' });
  exit(1);
} else if (args.includes('--plan')) {
  print({ platform: command, args: args.join(' '), cwd: process.cwd(), cacheHit: 'local' });
  exit(0);
} else if (env.FAKE_STIM_HANG || env.FAKE_STIM_STUBBORN) {
  setInterval(() => {}, 1000);
} else if (env.FAKE_STIM_JSON_FAIL) {
  print({ code: 'STIM_NO_LIVE_APP', message: 'No live app in this workspace.', remedy: 'Run stim ios.' });
  exit(1);
} else if (env.FAKE_STIM_FAIL) {
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
    frameLimits?: ServerOptions['frameLimits'];
    frameHelper?: string | null;
    controlLimits?: ServerOptions['controlLimits'];
  } = {},
): Promise<number> {
  const stimCli = join(root, 'fake-stim.mjs');
  writeFileSync(stimCli, FAKE_STIM);
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
    authTimeoutMs: overrides.authTimeoutMs,
    maxAuthFailures: overrides.maxAuthFailures,
    logLimits: overrides.logLimits,
    commandLimits: overrides.commandLimits,
    actionLimits: overrides.actionLimits,
    frameLimits: overrides.frameLimits,
    frameHelper: overrides.frameHelper ?? null,
    controlLimits: overrides.controlLimits,
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

  it('closes live sessions of a revoked device and refuses its token afterwards', async () => {
    const port = await start();
    const { id, token } = await pair(port);
    const live = await connect(port);
    await live.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });

    expect(revokeDevice(id)).toBe(true);
    expect(await live.closed).toBe(4401);
    const after = await connect(port);
    expect(await after.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } })).toMatchObject({
      error: { code: 'unauthorized', message: expect.stringContaining('does not recognize') },
    });
    expect(revokeDevice(id)).toBe(false);
  });
});

describe('health', () => {
  it('answers only requests from this Mac', async () => {
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
    expect(forwarded.status).toBe(426);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/health', headers: { host: `attacker.example:${port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(rebound).toBe(426);
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
    for (const filter of [{ tail: 5001 }, { sources: ['nope'] }, { sources: [] }, { grep: '(' }, { level: 'loud' }]) {
      expect(await client.request('logs.query', { workspace, ...filter })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
    expect(await client.request('logs.subscribe', { workspace: other })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
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
      again.socket.send(JSON.stringify({ id: 9, method: 'stats.get' }));
      await until(() => childPids().length === 2);
      const command = childPids().find((other) => other !== pid && other !== next);
      await server!.close();
      server = null;
      expect([alive(next!), alive(command!)]).toEqual([false, false]);
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
  it('return the CLI payload, run in the workspace or in the home directory', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('stats.get', { workspace })).toEqual({
      id: 2,
      result: { command: 'stats', cwd: workspace },
    });
    expect(await client.request('settings.get')).toEqual({
      id: 3,
      result: { command: 'settings', cwd: realpathSync(homedir()) },
    });
    expect(stimCalls().map((call) => call.args)).toEqual(['stats --json', 'settings --json']);
  });

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
    client.socket.send(JSON.stringify({ id: 2, method: 'stats.get', params: { workspace } }));
    await until(() => childPids().length === 1);
    const [pid] = childPids();
    expect(alive(pid!)).toBe(true);
    client.socket.terminate();
    await until(() => !alive(pid!));
  });

  it('kill a command that runs past its timeout', async () => {
    const port = await start({ env: { FAKE_STIM_HANG: '1' }, commandLimits: { timeoutMs: 300 } });
    const client = await authed(port);
    expect(await client.request('stats.get')).toMatchObject({
      error: { code: 'stim-failed', message: expect.stringContaining('did not finish') },
    });
    expect(childPids()).toEqual([]);
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
    expect(grantDevice(id, capabilitiesFor(false))).toBe(true);
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
    await client.request('action', { action: 'stop', workspace });
    expect(stimCalls()).toEqual([
      { args: 'reload ios --json', cwd: workspace },
      { args: 'reload --json', cwd: workspace },
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
appendFileSync(env.FAKE_TOOL_CALLS + '.started', process.pid + '\\n');
const message = (kind, body) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = kind;
  process.stdout.write(Buffer.concat([header, body]));
};
if (env.FAKE_HELPER_FAIL && !env.FAKE_HELPER_FAIL_AFTER) {
  message(2, Buffer.from(JSON.stringify({ error: env.FAKE_HELPER_FAIL })));
  process.exit(1);
}
let lines = '';
let config = {};
let keyframe = true;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lines += chunk;
  for (let at = lines.indexOf('\\n'); at >= 0; at = lines.indexOf('\\n')) {
    const line = JSON.parse(lines.slice(0, at));
    run.configs.push(line);
    if (line.keyframe) keyframe = true;
    else config = line;
    lines = lines.slice(at + 1);
  }
});
process.stdin.on('end', () => process.exit(0));
let sent = 0;
setInterval(() => {
  if (config.video) {
    const header = Buffer.alloc(13);
    header[0] = keyframe ? 1 : 0;
    header.writeDoubleBE(1759000000000 + sent, 1);
    header.writeUInt16BE(588, 9);
    header.writeUInt16BE(1280, 11);
    message(3, Buffer.concat([header, Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41, sent % 256])]));
    keyframe = false;
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

describe('frames.subscribe', () => {
  let toolCalls: string;

  async function startWithTools(
    env: Record<string, string>,
    frameLimits?: ServerOptions['frameLimits'],
    frameHelper?: string,
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
    expect(await client.request('frames.subscribe', { workspace, platform: 'web' })).toMatchObject({
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

  async function startControl(env: Record<string, string> = {}, controlLimits?: ServerOptions['controlLimits']) {
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
      controlLimits,
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

  test.skipIf(!fakeTailscale)(
    'sends input to the helper under a device lease and releases the lease when the session ends',
    async () => {
      const port = await startControl();
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, lease } = begun.result as { session: string; lease: { expiresAt: string } };
      expect(lease.expiresAt).toEqual(expect.any(String));
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.25, y: 0.75 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'Hi!\n' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'home' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'back' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('input.text', { session, text: `caf${String.fromCharCode(233)}` })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs).toEqual([
        { fps: 0, maxEdge: 240 },
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, display: 0 },
        { input: 'text', text: 'Hi!\n' },
        { input: 'button', button: 'home' },
      ]);
      await until(() => lockCalls().length === 2);
      expect(lockCalls()).toEqual(['device lock ios SIM-1 --for 2m --wait 0 --json', 'device unlock ios --json']);
      expect(readAudit().map((record) => record.action)).toEqual(['control.begin', 'control.end']);
    },
    10_000,
  );

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

  test.skipIf(!fakeTailscale)('ends a session when the device loses control', async () => {
    const port = await startControl();
    const { id, token } = await pair(port, undefined, true);
    const client = await connect(port);
    await client.request('hello', { protocol: 1, client: CLIENT, auth: { deviceToken: token } });
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    const { session } = (begun as { result: { session: string } }).result;
    grantDevice(id, capabilitiesFor(false));
    expect(await client.next()).toMatchObject({ event: 'control-ended', session, reason: 'forbidden' });
  });

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
});
