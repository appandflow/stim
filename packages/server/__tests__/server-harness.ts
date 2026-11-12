import assert from 'node:assert';
import { once } from 'node:events';
import type { PathLike, WatchListener, WatchOptionsWithStringEncoding } from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { DesktopBootstrap } from '../src/desktop-bootstrap.ts';
import { PEER, type HelloResult } from '../src/protocol.ts';
import { capabilitiesFor, createPairingToken } from '../src/registry.ts';
import { generateNoiseKeyPair, type NoiseKeyPair } from '@stim-cli/core/noise';
import {
  localConnect,
  noiseConnect,
  openRaw,
  terminateClients,
  wrap,
  type Client,
  type ConnectOptions,
} from './noise-client.ts';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.ts';
import { workspaceName, workspaceStateDir } from '@stim-cli/core';
import { captureProcessToken, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { readClaimSet } from '@stim-cli/core/ownership-claim';

const registryWatch: { dropEvents: boolean } = vi.hoisted(() => ({ dropEvents: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (
      ...args: [PathLike, WatchListener<string>] | [PathLike, WatchOptionsWithStringEncoding, WatchListener<string>]
    ) => (args.length === 2 ? fs.watch(args[0], registryWatch.dropEvents ? () => {} : args[1]) : fs.watch(...args)),
  };
});

const FAKE_STATUS_WORKER = `
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';
const env = process.env;
mkdirSync(env.FAKE_STIM_PIDS, { recursive: true });
const lifecycle = (event) => appendFileSync(join(env.FAKE_STIM_PIDS, 'status-workers'), event + ' ' + threadId + '\\n');
lifecycle('start');
appendFileSync(env.FAKE_STIM_CALLS, JSON.stringify({ args: 'status-worker', cwd: workerData.cwd }) + '\\n');
const payloads = JSON.parse(env.FAKE_STIM_PAYLOADS);
let index = 0;
let lastStatus;
parentPort.on('message', (message) => {
  if (message !== 'stop') return;
  appendFileSync(env.FAKE_STIM_CALLS, JSON.stringify({ args: 'status-worker stop', cwd: workerData.cwd }) + '\\n');
  lifecycle('stop');
  process.exit(0);
});
setInterval(() => {
  if (env.FAKE_STIM_STATUS_FILE) {
    const line = readFileSync(env.FAKE_STIM_STATUS_FILE, 'utf8');
    if (line !== lastStatus) parentPort.postMessage({ line });
    lastStatus = line;
    return;
  }
  if (index < payloads.length) return void parentPort.postMessage({ line: JSON.stringify(payloads[index++]) });
  if (env.FAKE_STIM_EXIT) {
    lifecycle('stop');
    process.exit(3);
  }
}, 20);
`;

const FAKE_STIM = `
import { appendFileSync, existsSync, mkdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
if (process.argv[2] === '__job') {
  const { serveOffloadJob } = await import(process.env.FAKE_JOB_SERVE);
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  const worker = [join(dirname(process.argv[1]), 'offload-worker.mjs')];
  const code = await serveOffloadJob(process.argv[3], JSON.parse(process.env.STIM_JOB_SPEC), process.stdin, process.stdout, stop.signal, worker);
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
}
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
} else if (command === 'doctor') {
  print({ project: process.cwd(), remoteMachines: [{ machine: 'mini', state: 'approved', args: args.join(' ') }] });
  exit(0);
} else if (env.FAKE_STIM_REFUSE) {
  print({ code: 'STIM_NO_DEVICE', message: 'No system image is installed.', remedy: 'Install one.' });
  exit(1);
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
    cwd: (await import('node:os')).tmpdir(),
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
} else if (args.includes('--plan')) {
  const answer = () => {
    print({ platform: command, args: args.join(' '), cwd: process.cwd(), cacheHit: 'local' });
    exit(0);
  };
  if (!env.FAKE_STIM_PLAN_GATE) answer();
  else setInterval(() => existsSync(env.FAKE_STIM_PLAN_GATE) && answer(), 10);
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
  if (process.env.FAKE_TAILSCALE_CWDS) require('node:fs').appendFileSync(process.env.FAKE_TAILSCALE_CWDS, process.cwd() + '\\n');
  console.log(JSON.stringify({ BackendState: 'Stopped' }));
  process.exit(0);
}
if (command === 'serve') {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  if (process.env.FAKE_SERVE_CALLS) fs.appendFileSync(process.env.FAKE_SERVE_CALLS, JSON.stringify(args) + '\\n');
  if (args[1] !== 'status') {
    if (process.env.FAKE_SERVE_HANG) { setInterval(() => {}, 1000); return; }
    if (process.env.FAKE_SERVE_FAILURE) {
      console.error(process.env.FAKE_SERVE_FAILURE);
      process.exit(1);
    }
    if (!process.env.FAKE_SERVE_NO_CHANGE) {
      const port = args.find((arg) => arg.startsWith('--https=')).split('=')[1];
      const config = JSON.parse(fs.readFileSync(process.env.FAKE_SERVE_STATUS, 'utf8'));
      config.TCP = { ...config.TCP, [port]: { HTTPS: true } };
      config.Web = { ...config.Web, ['test.tail.ts.net:' + port]: { Handlers: { '/': { Proxy: args.at(-1) } } } };
      fs.writeFileSync(process.env.FAKE_SERVE_STATUS, JSON.stringify(config));
    }
    process.exit(0);
  }
  if (process.env.FAKE_SERVE_STATUS_HANG) { setInterval(() => {}, 1000); return; }
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

export const RECORDS: { ts: number; src: string; level: string; msg: string; slot?: string }[] = [
  { ts: 1, src: 'metro', level: 'info', msg: 'Bundled' },
  { ts: 2, src: 'client', level: 'warn', msg: 'Slow render', slot: 'tablet' },
  { ts: 3, src: 'build', level: 'error', msg: 'Compile failed' },
];

const FAKE_WORKER = `
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv[2].startsWith('offer')) {
  print({ stimBuild: 'b1', compat: 3, arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', macosSdk: '27.0', cocoapods: '1.16.2', runtimes: ['iOS-27-0'] });
} else {
  const job = JSON.parse(readFileSync(0, 'utf8'));
  const record = join(process.env.FAKE_STIM_PIDS, '..', 'job.json');
  const pending = record + '.' + process.pid + '.tmp';
  writeFileSync(pending, JSON.stringify({ job, home: process.env.STIM_HOME, gradle: process.env.GRADLE_USER_HOME, pid: process.pid }));
  renameSync(pending, record);
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
    if (process.env.FAKE_WORKER_CRASH) {
      print({ type: 'result', ok: false, code: 'worker-crashed', message: 'The worker crashed.' });
      process.exit(1);
    }
    mkdirSync(join(job.area, 'out', job.job), { recursive: true });
    const archive = Buffer.from('app archive bytes');
    writeFileSync(join(job.area, 'out', job.job, 'app.tgz'), archive);
    if (job.platform === 'macos') {
      const contents = join(job.area, 'out', job.job, 'App.app', 'Contents');
      mkdirSync(join(contents, 'MacOS'), { recursive: true });
      writeFileSync(join(contents, 'Info.plist'), 'plist bytes');
      writeFileSync(join(contents, 'MacOS', 'Sample'), 'binary bytes');
      writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
      writeFileSync(join(contents, 'data'), 'data bytes');
      symlinkSync('MacOS', join(contents, 'Current'));
    }
    if (job.platform === 'android') writeFileSync(join(job.area, 'out', job.job, 'App.apk'), 'APK bytes');
    const sha256 = createHash('sha256').update(archive).digest('hex');
    print({ type: 'result', ok: true, fingerprintSettled: true, artifact: { name: job.platform === 'android' ? 'App.apk' : 'App.app', size: archive.length, sha256 }, fingerprint: job.expectedFingerprint, ...(job.reuseArtifact ? { reused: true } : {}), sourceDigest: job.native?.sourceDigest, compilationCache: { status: 'reported', hits: 3, cacheableTasks: 4, hitRatePercent: 75 }, timings: { buildMs: 5 } });
  }
}
`;

export const PAYLOADS: Record<string, unknown>[] = [
  { environments: [], capacity: { live: 0 }, deviceLeases: [], unprovisionedWorktrees: [], simctlAvailable: true },
  {
    environments: [{ path: '/work/app', live: true }],
    capacity: { live: 1 },
    deviceLeases: [],
    unprovisionedWorktrees: [],
    simctlAvailable: true,
  },
];

// The fake tailscale is a script with a shebang, which Windows cannot execute.
export const fakeTailscale: boolean = process.platform !== 'win32';

export const CLIENT: { name: string; version: string; peer: typeof PEER } = {
  name: 'test client',
  version: '0.0.0',
  peer: PEER,
};

const PEERS = {
  '100.64.0.2': { node: 'nPhoneA', user: 'janic@example.com' },
  '100.64.0.3': { node: 'nPhoneB', user: 'janic@example.com' },
};

export let root: string;
let pids: string;
export let calls: string;
export let workspace: string;
export let server: RunningServer | null;
const reloadBrowsers: (() => Promise<void>)[] = [];

export async function reloadBrowser(
  cwd: string = workspace,
  holdAttach: boolean = false,
): Promise<{
  url: string;
  methods: string[];
  attaching: Promise<void>;
  closed: Promise<void>;
  release: () => void;
}> {
  writeFileSync(join(cwd, 'package.json'), '{}');
  const area = workspaceStateDir(cwd);
  mkdirSync(area, { recursive: true });
  const url = `http://localhost/${workspaceName(cwd)}`;
  const http = createHttpServer((_, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned` }));
  });
  const sockets = new WebSocketServer({ server: http, path: '/devtools/browser/owned' });
  const methods: string[] = [];
  let attached!: () => void;
  const attaching = new Promise<void>((resolve) => {
    attached = resolve;
  });
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  let release = () => {};
  sockets.on('connection', (socket) => {
    socket.once('close', () => disconnected());
    socket.on('message', (raw) => {
      const { id, method }: { id: number; method: string } = JSON.parse(String(raw));
      methods.push(method);
      const result =
        method === 'SystemInfo.getProcessInfo'
          ? { processInfo: [{ type: 'browser', id: process.pid }] }
          : method === 'Target.getTargetInfo'
            ? { targetInfo: { url } }
            : method === 'Target.attachToTarget'
              ? { sessionId: 'page-session' }
              : {};
      const reply = () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, result }));
      };
      if (method === 'Target.attachToTarget') {
        attached();
        if (holdAttach) {
          release = reply;
          return;
        }
      }
      reply();
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  const processToken = captureProcessToken(process.pid);
  assert(processToken);
  writeFileSync(
    join(area, 'state.json'),
    JSON.stringify({
      web: {
        pid: process.pid,
        processToken,
        chromeProcess: { pid: process.pid, processToken },
        cdpPort: port,
        targetId: 'PAGE',
        profile: join(area, 'web', 'profile'),
        chrome: '/fixture/Chrome',
        url,
        startedAt: '',
        headless: true,
        viewport: 'desktop',
        ignoreCertificateErrors: false,
      },
    }),
  );
  reloadBrowsers.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url, methods, attaching, closed, release: () => release() };
}

export async function start(
  overrides: {
    host?: ServerOptions['host'];
    loopbackOnly?: boolean;
    keepAwake?: ServerOptions['keepAwake'];
    hostsDevices?: boolean;
    attached?: boolean;
    exit?: boolean;
    whoisDelayMs?: number;
    authTimeoutMs?: number;
    maxAuthFailures?: number;
    pendingConnections?: ServerOptions['pendingConnections'];
    maxUnknownSecrets?: number;
    headersTimeoutMs?: number;
    env?: Record<string, string>;
    logLimits?: ServerOptions['logLimits'];
    commandLimits?: ServerOptions['commandLimits'];
    actionLimits?: ServerOptions['actionLimits'];
    requestLimits?: ServerOptions['requestLimits'];
    tailscaleState?: ServerOptions['tailscaleState'];
    tailscaleMonitor?: ServerOptions['tailscaleMonitor'];
    transports?: ServerOptions['transports'];
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
    clientHeartbeat?: ServerOptions['clientHeartbeat'];
    hostedIdleSweepMs?: number;
    hostedRelay?: ServerOptions['hostedRelay'];
    startupProbeMs?: number;
    startupRetryMs?: number;
    settle?: boolean;
    statusAtBoot?: boolean;
    service?: ServerOptions['service'];
    shareServer?: ServerOptions['shareServer'];
    requestLog?: ServerOptions['requestLog'];
    /** The bundled Desktop's private key; the test key by default, null for a server Desktop did not start. */
    desktopBootstrap?: ServerOptions['desktopBootstrap'] | null;
    setupDeps?: ServerOptions['setupDeps'];
  } = {},
): Promise<number> {
  const stimCli = join(root, 'fake-stim.mjs');
  writeFileSync(stimCli, FAKE_STIM);
  writeFileSync(join(root, 'offload-worker.mjs'), FAKE_WORKER);
  writeFileSync(join(root, 'status-worker.mjs'), FAKE_STATUS_WORKER);
  const tailscale = join(root, 'tailscale');
  writeFileSync(tailscale, FAKE_TAILSCALE);
  chmodSync(tailscale, 0o755);
  server = await startServer({
    host: overrides.host,
    hostsDevices: overrides.hostsDevices ?? true,
    attached: overrides.attached,
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
      FAKE_JOB_SERVE: fileURLToPath(new URL('../../stim-cli/src/job/offload/serve.ts', import.meta.url)),
      FAKE_STIM_CALLS: calls,
      FAKE_STIM_PAYLOADS: JSON.stringify(PAYLOADS),
      FAKE_STIM_RECORDS: JSON.stringify(RECORDS),
      FAKE_TAILSCALE_PEERS: JSON.stringify(PEERS),
      ...(overrides.exit ? { FAKE_STIM_EXIT: '1' } : {}),
      ...(overrides.whoisDelayMs ? { FAKE_TAILSCALE_DELAY_MS: String(overrides.whoisDelayMs) } : {}),
      ...overrides.env,
    },
    tailscaleMonitor: overrides.tailscaleMonitor,
    transports: overrides.transports,
    statusAtBoot: overrides.statusAtBoot ?? false,
    service: overrides.service,
    shareServer: overrides.shareServer,
    listenRetryMs: overrides.listenRetryMs,
    authTimeoutMs: overrides.authTimeoutMs,
    maxAuthFailures: overrides.maxAuthFailures,
    pendingConnections: overrides.pendingConnections,
    maxUnknownSecrets: overrides.maxUnknownSecrets,
    headersTimeoutMs: overrides.headersTimeoutMs,
    logLimits: overrides.logLimits,
    commandLimits: overrides.commandLimits,
    actionLimits: overrides.actionLimits,
    requestLimits: overrides.requestLimits,
    frameLimits: { lingerMs: 50, ...overrides.frameLimits },
    frameHelper: overrides.frameHelper ?? null,
    foldHelper: overrides.foldHelper,
    record: overrides.record ?? false,
    loopbackOnly: overrides.loopbackOnly,
    keepAwake: overrides.keepAwake,
    recordLimits: overrides.recordLimits,
    controlLimits: overrides.controlLimits,
    history: overrides.history ?? false,
    pushEndpoint: overrides.pushEndpoint ?? 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
    buildLimits: overrides.buildLimits,
    clientHeartbeat: overrides.clientHeartbeat,
    hostedIdleSweepMs: overrides.hostedIdleSweepMs,
    hostedRelay: overrides.hostedRelay,
    requestLog: overrides.requestLog,
    desktopBootstrap:
      overrides.desktopBootstrap === null
        ? undefined
        : (overrides.desktopBootstrap ?? new DesktopBootstrap(DESKTOP_KEY)),
    startupProbeMs: overrides.startupProbeMs,
    startupRetryMs: overrides.startupRetryMs,
    setupDeps: overrides.setupDeps,
  });
  if (overrides.settle !== false) await server!.ready;
  return server.addresses[0]!.port;
}

export function connect(port: number, peer?: string, options: ConnectOptions = {}): Promise<Client> {
  return noiseConnect(`ws://127.0.0.1:${port}`, {
    ...options,
    headers: { ...(peer ? { 'x-forwarded-for': peer } : {}), ...options.headers },
  });
}

/** A WebSocket on the TCP port that runs no handshake, as a protocol 1 client or a web page would open. */
export async function openPlain(port: number, peer?: string, headers: Record<string, string> = {}): Promise<Client> {
  const socket = await openRaw(`ws://127.0.0.1:${port}`, { ...(peer ? { 'x-forwarded-for': peer } : {}), ...headers });
  return wrap(socket, socket);
}

export async function pair(
  port: number,
  peer?: string,
  control = false,
): Promise<{ id: string; keyPair: NoiseKeyPair }> {
  const keyPair = generateNoiseKeyPair();
  const { token } = createPairingToken(Date.now(), capabilitiesFor(control));
  const client = await connect(port, peer, { secret: token, keyPair });
  const reply = await client.request('hello', { client: CLIENT });
  if (!('result' in reply)) throw new Error(JSON.stringify(reply));
  client.socket.close();
  return { id: (reply.result as HelloResult).device.id, keyPair };
}

/** A returning client with `keyPair`, after hello. */
export async function returning(
  port: number,
  keyPair: NoiseKeyPair,
  peer?: string,
  access?: 'build' | 'device-host',
): Promise<Client> {
  const client = await connect(port, peer, { keyPair });
  const reply = await client.request('hello', { client: CLIENT, ...(access ? { access } : {}) });
  if (!('result' in reply)) throw new Error(JSON.stringify(reply));
  return client;
}

export const DESKTOP_KEY: string = Buffer.alloc(32, 7).toString('base64url');

export function desktopProof(nonce: string, key: string = DESKTOP_KEY): string {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(`client:${nonce}`).digest('base64url');
}

/** Stim Desktop on this machine: the Unix socket, after hello and the private bootstrap proof. */
export async function desktop(): Promise<Client> {
  const client = await localConnect(server!);
  const reply = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
  const offered = 'result' in reply ? (reply.result as HelloResult).desktopBootstrap : undefined;
  if (!offered) throw new Error(`no Desktop bootstrap challenge: ${JSON.stringify(reply)}`);
  await client.request('desktop.authenticate', { proof: desktopProof(offered.nonce) });
  return client;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

/** The fake status watch workers that started and have not stopped. */
export function statusWorkers(): string[] {
  const file = join(pids, 'status-workers');
  if (!existsSync(file)) return [];
  const running = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const [event, id] = line.split(' ');
    if (event === 'start') running.add(id!);
    else running.delete(id!);
  }
  return [...running];
}

export function childPids(): number[] {
  return existsSync(pids) ? readdirSync(pids).map(Number).filter(alive) : [];
}

export function stimCalls(): { args: string; cwd: string }[] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string; cwd: string });
}

export async function authed(port: number, control = false): Promise<Client> {
  const { keyPair } = await pair(port, undefined, control);
  return returning(port, keyPair);
}

export async function records(client: Client, count: number): Promise<unknown[]> {
  const seen: unknown[] = [];
  while (seen.length < count) {
    const message = await client.next();
    if (!('event' in message) || message.event !== 'logs') throw new Error(JSON.stringify(message));
    seen.push(...message.records);
  }
  return seen;
}

/** STIM_HOME as a link to the home: a test takes the home away by unlinking it, since Windows refuses to rename a directory the server watches. */
export function linkedHome(): { away: () => void; back: () => void } {
  const link = join(root, 'home-link');
  const create = () => symlinkSync(join(root, 'home'), link, process.platform === 'win32' ? 'junction' : 'dir');
  create();
  process.env.STIM_HOME = link;
  return { away: () => unlinkSync(link), back: create };
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
});

afterEach(async () => {
  terminateClients();
  await server?.close();
  for (const close of reloadBrowsers.splice(0)) await close();
  const claims = readClaimSet(join(root, 'home', 'run', 'stimd'));
  assert.deepEqual(claims.unresolved, []);
  for (const { owner } of claims.live) {
    assert.notEqual(owner.pid, process.pid);
    const status = inspectProcessIdentity(owner);
    if (status === 'gone' || status === 'different') continue;
    assert.equal(status, 'same');
    process.kill(owner.pid, 'SIGTERM');
    await vi.waitFor(() => assert.match(inspectProcessIdentity(owner), /^(gone|different)$/), { timeout: 10_000 });
  }
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

export function liveLogFixture(logged: unknown[] = RECORDS): string {
  const dir = join(workspaceStateDir(workspace), 'logs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'client.ndjson');
  writeFileSync(path, logged.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

export function forgetServer(): void {
  server = null;
}

export { registryWatch };
