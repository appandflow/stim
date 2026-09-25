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
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { HelloResult, ServerMessage } from '../src/protocol.ts';
import { createPairingToken, PAIRING_TTL_MS, readDevices, revokeDevice } from '../src/registry.ts';
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
process.on('SIGTERM', () => exit(0));
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
} else if (env.FAKE_STIM_HANG) {
  setInterval(() => {}, 1000);
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
  });
  return server.addresses[0]!.port;
}

function connect(port: number, peer?: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: peer ? { 'x-forwarded-for': peer } : {} });
  clients.push(socket);
  const inbox: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
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

async function pair(port: number, peer?: string): Promise<{ id: string; token: string }> {
  const client = await connect(port, peer);
  const reply = await client.request('hello', {
    protocol: 1,
    client: CLIENT,
    auth: { pairingToken: createPairingToken().token, deviceName: 'Test phone' },
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
  return existsSync(pids) ? readdirSync(pids).map(Number) : [];
}

function stimCalls(): { args: string; cwd: string }[] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string; cwd: string });
}

async function authed(port: number): Promise<Client> {
  const { token } = await pair(port);
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
        server: { name: 'Test Mac', version: '1.2.3', stim: '9.9.9' },
        capabilities: ['read'],
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
