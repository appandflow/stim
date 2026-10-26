import assert from 'node:assert';
import { once } from 'node:events';
import type { PathLike, WatchListener, WatchOptionsWithStringEncoding } from 'node:fs';
import {
  cpSync,
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, get } from 'node:http';
import { createServer as createHttp2Server, type ServerHttp2Stream } from 'node:http2';
import { createHash, createHmac } from 'node:crypto';
import { connect as connectNet, createServer as createNetServer, type Socket } from 'node:net';
import { homedir, networkInterfaces, tmpdir, totalmem } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  archiveDir,
  closedSegmentName,
  recordingDeviceName,
  type ArchivedWorkspace,
  type StatusPayload,
  type BuildPlanPayload,
  readStatsReport,
  readWorkspaceState,
  readHostedSessions,
  deviceHostArea,
  deviceHostRoot,
  buildSlotPath,
  machineCapacity,
  readViewedDevices,
  tryAcquireBuildSlotClaim,
  isJsonObject,
  loadConfig,
  settingsJsonSchema,
  serverLocalSocket,
} from '@stim-cli/core/state';
import { createStim } from 'stim';
import * as stim from 'stim';
import { BuildHost } from '../src/build.ts';
import { DesktopBootstrap } from '../src/desktop-bootstrap.ts';
import { HostedAgentHost } from '../src/agent-driver.ts';
import { DeviceHost } from '../src/device-host.ts';
import { FeedPool } from '../src/feed.ts';
import { FramePool, ownedDevice } from '../src/frames.ts';
import {
  protocolJsonSchema,
  type ArchiveDetailResult,
  type HelloResult,
  type MachineUsage,
  type ServerMessage,
  type StatusEvent,
  type WorkspacesEvent,
  type ArchivedListResult,
} from '../src/protocol.ts';
import Ajv2020 from 'ajv/dist/2020.js';
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
  serverIdentity,
  storeSetupSecret,
} from '../src/registry.ts';
import { generateNoiseKeyPair, type NoiseKeyPair } from '@stim-cli/core/noise';
import { acceptNoise, newSecret, secretValues } from '@stim-cli/core/noise-session';
import {
  localConnect,
  noiseConnect,
  openRaw,
  setupClient,
  terminateClients,
  wrap,
  type Client,
  type ConnectOptions,
} from './noise-client.ts';
import { watchTailscale, type TailscaleState } from '@stim-cli/transport-tailscale';
import { localTransport } from '@stim-cli/transport-local';
import { createRequestLog } from '../src/request-log.ts';
import { startServer, upgradeFromWebPage, type RunningServer, type ServerOptions } from '../src/server.ts';
import { workspaceName, workspaceStateDir } from '@stim-cli/core';
import { captureProcessToken, inspectProcessIdentity, processStartMicros } from '@stim-cli/core/process-identity';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { serviceRoot } from '../src/service-manager.ts';
import { readPid } from './pid-file.ts';

const registryWatch = vi.hoisted(() => ({ dropEvents: false }));

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
import { appendFileSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';
const env = process.env;
mkdirSync(env.FAKE_STIM_PIDS, { recursive: true });
const lifecycle = (event) => appendFileSync(join(env.FAKE_STIM_PIDS, 'status-workers'), event + ' ' + threadId + '\\n');
lifecycle('start');
appendFileSync(env.FAKE_STIM_CALLS, JSON.stringify({ args: 'status-worker', cwd: workerData.cwd }) + '\\n');
const payloads = JSON.parse(env.FAKE_STIM_PAYLOADS);
let index = 0;
parentPort.on('message', (message) => {
  if (message !== 'stop') return;
  appendFileSync(env.FAKE_STIM_CALLS, JSON.stringify({ args: 'status-worker stop', cwd: workerData.cwd }) + '\\n');
  lifecycle('stop');
  process.exit(0);
});
setInterval(() => {
  if (index < payloads.length) return void parentPort.postMessage({ line: JSON.stringify(payloads[index++]) });
  if (env.FAKE_STIM_EXIT) {
    lifecycle('stop');
    process.exit(3);
  }
}, 20);
`;

const FAKE_STIM = `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
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

const RECORDS = [
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
  print({ stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', macosSdk: '27.0', cocoapods: '1.16.2', runtimes: ['iOS-27-0'] });
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
    print({ type: 'result', ok: true, artifact: { name: job.platform === 'android' ? 'App.apk' : 'App.app', size: archive.length, sha256 }, fingerprint: job.expectedFingerprint, sourceDigest: job.native?.sourceDigest, compilationCache: { status: 'reported', hits: 3, cacheableTasks: 4, hitRatePercent: 75 }, timings: { buildMs: 5 } });
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

let root: string;
let pids: string;
let calls: string;
let workspace: string;
let server: RunningServer | null;
const reloadBrowsers: (() => Promise<void>)[] = [];

async function reloadBrowser(cwd = workspace, holdAttach = false) {
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

async function start(
  overrides: {
    host?: ServerOptions['host'];
    loopbackOnly?: boolean;
    hostsDevices?: boolean;
    exit?: boolean;
    whoisDelayMs?: number;
    authTimeoutMs?: number;
    maxAuthFailures?: number;
    pendingConnections?: ServerOptions['pendingConnections'];
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
    hostedRelay?: ServerOptions['hostedRelay'];
    startupProbeMs?: number;
    startupRetryMs?: number;
    settle?: boolean;
    statusAtBoot?: boolean;
    service?: ServerOptions['service'];
    requestLog?: ServerOptions['requestLog'];
    /** The bundled Desktop's private key; the test key by default, null for a server Desktop did not start. */
    desktopBootstrap?: ServerOptions['desktopBootstrap'] | null;
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
    transports: overrides.transports,
    statusAtBoot: overrides.statusAtBoot ?? false,
    service: overrides.service,
    listenRetryMs: overrides.listenRetryMs,
    authTimeoutMs: overrides.authTimeoutMs,
    maxAuthFailures: overrides.maxAuthFailures,
    pendingConnections: overrides.pendingConnections,
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
    recordLimits: overrides.recordLimits,
    controlLimits: overrides.controlLimits,
    history: overrides.history ?? false,
    pushEndpoint: overrides.pushEndpoint ?? 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
    buildLimits: overrides.buildLimits,
    hostedRelay: overrides.hostedRelay,
    requestLog: overrides.requestLog,
    desktopBootstrap:
      overrides.desktopBootstrap === null
        ? undefined
        : (overrides.desktopBootstrap ?? new DesktopBootstrap(DESKTOP_KEY)),
    startupProbeMs: overrides.startupProbeMs,
    startupRetryMs: overrides.startupRetryMs,
  });
  if (overrides.settle !== false) await server!.ready;
  return server.addresses[0]!.port;
}

function connect(port: number, peer?: string, options: ConnectOptions = {}): Promise<Client> {
  return noiseConnect(`ws://127.0.0.1:${port}`, {
    ...options,
    headers: { ...(peer ? { 'x-forwarded-for': peer } : {}), ...options.headers },
  });
}

/** A WebSocket on the TCP port that runs no handshake, as a protocol 1 client or a web page would open. */
async function openPlain(port: number, peer?: string, headers: Record<string, string> = {}): Promise<Client> {
  const socket = await openRaw(`ws://127.0.0.1:${port}`, { ...(peer ? { 'x-forwarded-for': peer } : {}), ...headers });
  return wrap(socket, socket);
}

async function pair(port: number, peer?: string, control = false): Promise<{ id: string; keyPair: NoiseKeyPair }> {
  const keyPair = generateNoiseKeyPair();
  const { token } = createPairingToken(Date.now(), capabilitiesFor(control));
  const client = await connect(port, peer, { secret: token, keyPair });
  const reply = await client.request('hello', { client: CLIENT });
  if (!('result' in reply)) throw new Error(JSON.stringify(reply));
  client.socket.close();
  return { id: (reply.result as HelloResult).device.id, keyPair };
}

/** A returning client with `keyPair`, after hello. */
async function returning(
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

const DESKTOP_KEY = Buffer.alloc(32, 7).toString('base64url');

function desktopProof(nonce: string, key = DESKTOP_KEY): string {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(`client:${nonce}`).digest('base64url');
}

/** Stim Desktop on this machine: the Unix socket, after hello and the private bootstrap proof. */
async function desktop(): Promise<Client> {
  const client = await localConnect(server!.localSocket!);
  const reply = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
  const offered = 'result' in reply ? (reply.result as HelloResult).desktopBootstrap : undefined;
  if (!offered) throw new Error(`no Desktop bootstrap challenge: ${JSON.stringify(reply)}`);
  await client.request('desktop.authenticate', { proof: desktopProof(offered.nonce) });
  return client;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

/** The fake status watch workers that started and have not stopped. */
function statusWorkers(): string[] {
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
  const { keyPair } = await pair(port, undefined, control);
  return returning(port, keyPair);
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
});

afterEach(async () => {
  terminateClients();
  await server?.close();
  for (const close of reloadBrowsers.splice(0)) await close();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('an agent shutdown failure still closes hosted devices, frames, feeds and listeners', async () => {
  const port = await start();
  const client = await authed(port);
  const agentClose = vi.spyOn(HostedAgentHost.prototype, 'close').mockRejectedValue(new Error('daemon unresolved'));
  const hostedClose = vi.spyOn(DeviceHost.prototype, 'close');
  const frameClose = vi.spyOn(FramePool.prototype, 'close');
  const feedClose = vi.spyOn(FeedPool.prototype, 'close');
  try {
    await expect(server!.close()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'daemon unresolved' })],
    });
    expect(hostedClose).toHaveBeenCalledOnce();
    expect(frameClose).toHaveBeenCalledOnce();
    expect(feedClose).toHaveBeenCalledOnce();
    await client.closed;
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow('fetch failed');
    server = null;
  } finally {
    agentClose.mockRestore();
    hostedClose.mockRestore();
    frameClose.mockRestore();
    feedClose.mockRestore();
  }
});

describe('recorder startup', () => {
  test('serves health when recording claim directories do not exist yet', async () => {
    const port = await start({ record: true, env: { FAKE_STIM_PAYLOADS: '[]' } });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ server: 'stim-server' });
  });

  test.skipIf(process.platform === 'win32')(
    'keeps serving after the recorder refuses an unreadable claim directory',
    async () => {
      const exclusive = join(process.env.STIM_HOME!, 'server', 'recorder', 'exclusive');
      mkdirSync(exclusive, { recursive: true });
      chmodSync(exclusive, 0o000);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const port = await start({ record: true, env: { FAKE_STIM_PAYLOADS: '[]' } });
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('its directory could not be read'));
      } finally {
        chmodSync(exclusive, 0o700);
        error.mockRestore();
      }
    },
  );

  describe('while a Stim home directory read does not return', () => {
    const blockRead = (name: string) => {
      const preload = join(root, `${name}.cjs`);
      const pidFile = join(root, `${name}.pid`);
      const release = join(root, `${name}.release`);
      writeFileSync(
        preload,
        `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
fs.readdirSync = () => {
  if (fs.existsSync(process.env.PROBE_RELEASE_FILE)) return [];
  fs.writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
  process.on('SIGTERM', () => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
syncBuiltinESMExports();
`,
      );
      return {
        pidFile,
        release,
        env: {
          NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
          PROBE_PID_FILE: pidFile,
          PROBE_RELEASE_FILE: release,
        },
      };
    };

    test('listens at once, reports degraded health, serves no clients and starts no recorder', async () => {
      const blocked = blockRead('blocked-read');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const port = await start({
        record: true,
        settle: false,
        startupProbeMs: 400,
        startupRetryMs: 60_000,
        env: blocked.env,
      });
      try {
        const pending = await fetch(`http://127.0.0.1:${port}/health`);
        expect(pending.status).toBe(503);
        expect(await pending.json()).toMatchObject({ server: 'stim-server', startup: { state: 'pending' } });

        const settled = await server!.ready;
        expect(settled).toEqual({
          state: 'degraded',
          reason: expect.stringContaining('did not finish within 0.4 s'),
          cause: 'home-unreadable',
        });
        const degraded = await fetch(`http://127.0.0.1:${port}/health`);
        expect(degraded.status).toBe(503);
        expect(await degraded.json()).toMatchObject({ startup: settled });

        const forwarded = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { 'x-forwarded-for': '100.64.0.2' },
        });
        expect(forwarded.status).toBe(503);
        expect(await forwarded.json()).toEqual({
          version: expect.any(String),
          startup: { state: 'degraded', cause: 'home-unreadable' },
        });

        await expect(
          new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`);
            socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
            socket.once('error', reject);
          }),
        ).resolves.toBe(503);

        expect(existsSync(calls)).toBe(false);
        expect(existsSync(join(process.env.STIM_HOME!, 'server'))).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('not serving clients'));
        const pid = await readPid(blocked.pidFile);
        expect(() => process.kill(pid, 0)).toThrow('ESRCH');
      } finally {
        error.mockRestore();
      }
    });

    test.skipIf(process.platform === 'win32')(
      'does not read Stim home files from timers before the first read returns',
      async () => {
        const blocked = blockRead('sweep-read');
        const config = join(root, 'home', 'config.json');
        const opened = join(root, 'config-opened');
        rmSync(config, { force: true });
        execFileSync('mkfifo', [config]);
        const opener = spawn(process.execPath, [
          '-e',
          `const fs = require('node:fs');
for (;;) { fs.closeSync(fs.openSync(${JSON.stringify(config)}, 'w')); fs.writeFileSync(${JSON.stringify(opened)}, ''); }`,
        ]);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await start({
            settle: false,
            startupProbeMs: 10_000,
            startupRetryMs: 60_000,
            buildLimits: { daemonSweepMs: 30 },
            env: blocked.env,
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          expect(existsSync(opened)).toBe(false);
        } finally {
          await server?.close();
          server = null;
          opener.kill('SIGKILL');
          error.mockRestore();
        }
      },
    );

    test('stops promptly while the first read is still out', async () => {
      const blocked = blockRead('closing-read');
      await start({ settle: false, startupProbeMs: 10_000, env: blocked.env });
      const started = Date.now();
      await server!.close();
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await server!.ready).state).toBe('pending');
    });

    test('becomes ready without a restart once the read returns', async () => {
      const blocked = blockRead('recovering-read');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const port = await start({
        record: true,
        settle: false,
        startupProbeMs: 400,
        startupRetryMs: 50,
        env: { FAKE_STIM_PAYLOADS: '[]', ...blocked.env },
      });
      try {
        expect((await server!.ready).state).toBe('degraded');
        writeFileSync(blocked.release, '');
        await vi.waitFor(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ startup: { state: 'ready' } });
        });
        await expect(pair(port)).resolves.toHaveProperty('id');
      } finally {
        error.mockRestore();
      }
    }, 20_000);
  });
});

describe.skipIf(!fakeTailscale)('Desktop route setup', () => {
  async function routeServer(config: unknown = {}, env: Record<string, string> = {}) {
    const status = join(root, 'serve.json');
    const commandLog = join(root, 'serve-calls.ndjson');
    writeFileSync(status, typeof config === 'string' ? config : JSON.stringify(config));
    const port = await start({
      tailscaleState: { state: 'running', dnsName: 'test.tail.ts.net', ips: [], hostName: 'test' },
      env: { FAKE_SERVE_STATUS: status, FAKE_SERVE_CALLS: commandLog, ...env },
    });
    return {
      port,
      status,
      commands: () =>
        existsSync(commandLog)
          ? readFileSync(commandLog, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as string[])
          : [],
    };
  }

  it('creates and verifies a private free-port proxy without changing other handlers or Funnel', async () => {
    const original = {
      TCP: { '443': { HTTPS: true }, '7443': { HTTPS: true } },
      Web: { 'test.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
      AllowFunnel: { 'test.tail.ts.net:443': true },
    };
    const fixture = await routeServer(original);
    const client = await desktop();
    expect(await client.request('route.setup', {})).toMatchObject({ result: { state: 'routed', port: 7444 } });
    expect(fixture.commands()).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--bg', '--https=7444', `http://127.0.0.1:${fixture.port}`],
      ['serve', 'status', '--json'],
    ]);
    const config = JSON.parse(readFileSync(fixture.status, 'utf8'));
    expect(config.AllowFunnel).toEqual(original.AllowFunnel);
    expect(config.Web['test.tail.ts.net:443']).toEqual(original.Web['test.tail.ts.net:443']);
    expect(await client.request('route.setup')).toMatchObject({ result: { state: 'routed', port: 7444 } });
    expect(fixture.commands().filter((args) => args[1] !== 'status')).toHaveLength(1);
  });

  it.each([
    ['invalid JSON', '{', 'not JSON'],
    ['unrecognized config', { Error: 'service unavailable' }, 'unrecognized'],
    ['malformed config', { TCP: [] }, 'malformed'],
    ['malformed foreground', { Foreground: { session: null } }, 'malformed'],
  ])('refuses %s before changing any route', async (_name, config, reason) => {
    const fixture = await routeServer(config);
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining(reason) },
    });
    expect(fixture.commands()).toEqual([['serve', 'status', '--json']]);
  });

  it('refuses an existing public route rather than adding another or changing Funnel', async () => {
    const fixture = await routeServer();
    writeFileSync(
      fixture.status,
      JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: { 'test.tail.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${fixture.port}` } } } },
        AllowFunnel: { 'test.tail.ts.net:443': true },
      }),
    );
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('Funnel') },
    });
    expect(fixture.commands()).toEqual([['serve', 'status', '--json']]);
  });

  it.each([
    [
      'command refusal',
      { FAKE_SERVE_FAILURE: 'Enable HTTPS at https://login.tailscale.com/admin/dns' },
      'Enable HTTPS',
    ],
    ['unverified command success', { FAKE_SERVE_NO_CHANGE: '1' }, 'could not be verified'],
  ])('keeps %s readable and permits an explicit retry', async (_name, env, reason) => {
    const fixture = await routeServer({}, env);
    const client = await desktop();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await client.request('route.setup')).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining(reason) },
      });
    }
    expect(fixture.commands().filter((args) => args[1] !== 'status')).toHaveLength(2);
  });

  it('refuses a timed-out status probe without inferring that a route is missing', async () => {
    const fixture = await routeServer({}, { FAKE_SERVE_STATUS_HANG: '1' });
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('timed out') },
    });
    expect(fixture.commands()).toEqual([['serve', 'status', '--json']]);
  });

  it('bounds a stalled setup command and keeps the failure retryable', async () => {
    const fixture = await routeServer({}, { FAKE_SERVE_HANG: '1' });
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('setup timed out') },
    });
    expect(JSON.parse(readFileSync(fixture.status, 'utf8'))).toEqual({});
  }, 15_000);

  it('serves Desktop-only methods on the Unix socket and refuses them to a network connection with control', async () => {
    const fixture = await routeServer();
    const { keyPair } = await pair(fixture.port, '100.64.0.2', true);
    const remote = await returning(fixture.port, keyPair, '100.64.0.2');
    for (const [method, params] of [
      ['route.setup', undefined],
      ['machines.update.start', { machine: 'mini' }],
      ['machines.update.status', { machine: 'mini' }],
      ['device-host.sessions', undefined],
      ['device-host.sessions.stop', { session: 'missing' }],
    ] as const) {
      expect(await remote.request(method, params)).toMatchObject({ error: { code: 'forbidden' } });
    }
    const loopback = await authed(fixture.port, true);
    expect(await loopback.request('route.setup')).toMatchObject({ error: { code: 'forbidden' } });
    expect(fixture.commands()).toEqual([]);

    const local = await desktop();
    expect(await local.request('machines.update.start', {})).toMatchObject({ error: { code: 'bad-request' } });
    expect(await local.request('machines.update.start', { machine: 'mini' })).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('has not approved this machine') },
    });
    expect(await local.request('machines.update.status', { machine: 'mini' })).toMatchObject({
      result: { remote: null, unreachable: expect.stringContaining('has not approved this machine'), upload: null },
    });
    expect(await local.request('route.setup')).toMatchObject({ result: { state: 'routed' } });
  });

  it('refuses setup when Tailscale is unavailable and rejects target parameters', async () => {
    await start();
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('Start Tailscale') },
    });
    expect(await client.request('route.setup', { port: 443 })).toMatchObject({ error: { code: 'bad-request' } });
  });
});

describe.skipIf(process.platform === 'win32')('private Desktop bootstrap on the local socket', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const isHello = validator.compile<HelloResult>({ $ref: 'protocol#/$defs/HelloResult' });

  /** A local-socket client that asks for the challenge, as Stim Desktop does, without answering it yet. */
  async function asking(client = CLIENT) {
    const socket = await localConnect(server!.localSocket!);
    const reply = await socket.request('hello', { client, desktopBootstrap: true });
    assert('result' in reply && isHello(reply.result));
    return { client: socket, hello: reply.result };
  }

  function challenge(hello: HelloResult) {
    assert(hello.desktopBootstrap);
    return hello.desktopBootstrap;
  }

  it('admits the parent proof to the Desktop-only methods, which a plain local client such as the CLI never gets', async () => {
    await start();
    const { client, hello } = await asking();
    const offered = challenge(hello);
    expect(JSON.stringify(hello)).not.toContain(DESKTOP_KEY);
    expect(await client.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    expect(await client.request('desktop.authenticate', { proof: desktopProof(offered.nonce) })).toMatchObject({
      result: { authorized: true },
    });
    expect(await client.request('device-host.sessions')).toHaveProperty('result');

    const cli = await localConnect(server!.localSocket!);
    const plain = await cli.request('hello', { client: { name: 'stim', version: '1' } });
    expect(plain).toMatchObject({ result: { capabilities: ['read', 'control'] } });
    expect(plain).not.toHaveProperty('result.desktopBootstrap');
    expect(await cli.request('stats.get')).toHaveProperty('result');
    expect(await cli.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    expect(await cli.request('route.setup')).toHaveProperty('error.code', 'forbidden');
    expect(await cli.request('desktop.authenticate', { proof: desktopProof(offered.nonce) })).toHaveProperty(
      'error.code',
      'forbidden',
    );
  });

  it('does not confuse a Desktop name, the key itself or the public server proof with the client proof', async () => {
    await start();
    for (const params of [undefined, {}, { proof: DESKTOP_KEY }, { proof: 'x'.repeat(43) }, 'server', 'extra']) {
      const { client, hello } = await asking({ name: 'Stim Desktop', version: '1' });
      const offered = challenge(hello);
      const sent =
        params === 'server'
          ? { proof: offered.proof }
          : params === 'extra'
            ? { proof: desktopProof(offered.nonce), desktop: true }
            : params;
      expect(await client.request('desktop.authenticate', sent)).toHaveProperty('error.code', 'forbidden');
      expect(await client.request('route.setup')).toHaveProperty('error.code', 'forbidden');
    }
  });

  it('answers one proof per challenge and refuses an earlier proof after reconnect', async () => {
    await start();
    const first = await asking();
    const accepted = desktopProof(challenge(first.hello).nonce);
    expect(await first.client.request('desktop.authenticate', { proof: 'y'.repeat(43) })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(await first.client.request('desktop.authenticate', { proof: accepted })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    first.client.socket.close();
    const second = await asking();
    expect(challenge(second.hello).nonce).not.toBe(challenge(first.hello).nonce);
    expect(await second.client.request('desktop.authenticate', { proof: accepted })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    const third = await asking();
    expect(
      await third.client.request('desktop.authenticate', { proof: desktopProof(challenge(third.hello).nonce) }),
    ).toHaveProperty('result.authorized', true);
  });

  it('a server Desktop did not start offers no challenge and keeps the local socket permissions it had', async () => {
    await start({ desktopBootstrap: null });
    const client = await localConnect(server!.localSocket!);
    const hello = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
    expect(hello).toMatchObject({ result: { capabilities: ['read', 'control'] } });
    expect(hello).not.toHaveProperty('result.desktopBootstrap');
    expect(await client.request('desktop.authenticate', { proof: DESKTOP_KEY })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(await client.request('device-host.sessions')).toHaveProperty('result');
    const port = server!.addresses[0]!.port;
    const { keyPair } = await pair(port, undefined, true);
    const network = await returning(port, keyPair);
    expect(await network.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
  });

  it('tells a local client the TCP port of the server behind the socket, and network clients nothing', async () => {
    const port = await start();
    const local = await localConnect(server!.localSocket!);
    expect(await local.request('hello', { client: CLIENT })).toHaveProperty('result.server.port', port);
    const { keyPair } = await pair(port, undefined, true);
    const network = await connect(port, undefined, { keyPair });
    expect(await network.request('hello', { client: CLIENT })).not.toHaveProperty('result.server.port');
  });

  it('a replacement server requires its own parent key', async () => {
    await start();
    await server?.close();
    server = null;
    const replacement = Buffer.alloc(32, 8).toString('base64url');
    await start({ desktopBootstrap: new DesktopBootstrap(replacement) });
    const { client, hello } = await asking();
    const offered = challenge(hello);
    expect(await client.request('desktop.authenticate', { proof: desktopProof(offered.nonce) })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    const again = await asking();
    expect(
      await again.client.request('desktop.authenticate', {
        proof: desktopProof(challenge(again.hello).nonce, replacement),
      }),
    ).toHaveProperty('result.authorized', true);
  });

  it.each([
    ['forwarded', { 'x-forwarded-for': '100.64.0.2' }],
    ['rebound host', { host: 'attacker.example' }],
  ])('a %s network client with control gets no challenge, even on loopback', async (_name, headers) => {
    const port = await start();
    const { keyPair } = await pair(port, undefined, true);
    const client = await connect(port, undefined, { keyPair, headers });
    const hello = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
    expect(hello).not.toHaveProperty('result.desktopBootstrap');
    expect(await client.request('desktop.authenticate', { proof: DESKTOP_KEY })).toHaveProperty(
      'error.code',
      'forbidden',
    );
  });

  it('refuses a browser page before any hello, on loopback too', async () => {
    const port = await start();
    const { keyPair } = await pair(port, undefined, true);
    await expect(connect(port, undefined, { keyPair, headers: { origin: 'http://127.0.0.1' } })).rejects.toThrow(
      'HTTP 403',
    );
  });

  test.skipIf(!fakeTailscale)(
    'a tailnet client whose control was revoked has no route to Desktop authority',
    async () => {
      const port = await start();
      const { id, keyPair } = await pair(port, '100.64.0.2', true);
      grantDevice(id, capabilitiesFor(false));
      const client = await connect(port, '100.64.0.2', { keyPair });
      const hello = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
      expect(hello).toMatchObject({ result: { capabilities: ['read'] } });
      expect(hello).not.toHaveProperty('result.desktopBootstrap');
      expect(await client.request('desktop.authenticate', { proof: DESKTOP_KEY })).toHaveProperty(
        'error.code',
        'forbidden',
      );
      expect(await client.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    },
  );
});

describe('pairing', () => {
  it('records the key that spends a pairing token, with the token capabilities, and refuses a second use', async () => {
    const port = await start();
    const keyPair = generateNoiseKeyPair();
    const { token } = createPairingToken();
    const first = await connect(port, undefined, { secret: token, keyPair, name: 'Test phone' });
    expect(first.socket).toHaveProperty('remoteKey', serverIdentity().publicKey);
    const reply = await first.request('hello', { client: CLIENT, access: 'build' });
    expect(reply).toMatchObject({ error: { code: 'forbidden' } });
    expect(await first.closedWith).toEqual({ code: 4401, reason: 'forbidden' });
    expect(readDevices()).toEqual([
      expect.objectContaining({
        name: 'Test phone',
        publicKey: keyPair.publicKey.toString('base64url'),
        capabilities: ['read'],
      }),
    ]);
    expect(readBuildClients()).toEqual([]);
    expect(readFileSync(join(root, 'home', 'server', 'secrets.json'), 'utf8')).not.toContain(token);

    const hello = await (await connect(port, undefined, { keyPair })).request('hello', { client: CLIENT });
    expect(hello).toMatchObject({
      result: {
        protocol: 2,
        server: { name: 'Test Mac', version: '1.2.3', stim: '9.9.9', home: homedir() },
        capabilities: ['read'],
        features: [
          'physical-ios',
          'physical-android',
          'notifications',
          'macos-window',
          'macos-windows',
          'macos-window-select',
          'macos-window-control',
          'macos-keyboard-extended',
          'device-frames',
          'macos-hosted',
          'ios-hosted',
          'android-hosted',
          'hosted-ios-agent',
          'hosted-android-agent',
          'duo-frames',
          'workspace-diff',
          'hosted-congestion',
          'hosted-ios-data',
          'hosted-ios-process',
          'native-xcode-build',
          'native-xcode-toolchain',
          'build-artifact-cache',
          'native-gradle-build',
          'native-gradle-artifact-cache',
          'native-gradle-peer-cache',
          'react-native-peer-cache',
          'fingerprint-sources',
          'fingerprint-ignored',
          'fingerprint-tracked',
          'swiftpm-peer-cache',
          'build-dependency-cache',
          'hosted-android-data',
          'hosted-android-process',
          'hosted-metro-ports',
          'server-update',
          'build-compat',
          'build-jdk',
          'status-views',
        ],
        actions: [],
        device: { name: 'Test phone' },
      },
    });

    const second = await connect(port, undefined, { secret: token });
    expect(await second.closedWith).toEqual({ code: 4401, reason: 'unknown-secret' });
    expect(readDevices()).toHaveLength(1);
  });

  it('refuses an expired pairing token', async () => {
    const port = await start();
    const { token } = createPairingToken(Date.now() - PAIRING_TTL_MS - 1000);
    await expect(connect(port, undefined, { secret: token })).rejects.toMatchObject({ code: 'unknown-secret' });
    expect(readDevices()).toEqual([]);
  });

  it('closes a returning key that has no record as unauthorized', async () => {
    const port = await start();
    const stranger = await connect(port, '100.64.0.2');
    expect(await stranger.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('refuses hello for a record revoked between the handshake and hello', async () => {
    const port = await start();
    const { id, keyPair } = await pair(port);
    const client = await connect(port, undefined, { keyPair });
    expect(revokeDevice(id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reply = client.request('hello', { client: CLIENT });
    expect(await Promise.race([reply, client.closedWith])).not.toHaveProperty('result');
    expect(await client.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('refuses a server that does not hold the key the client pinned', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    await expect(
      connect(port, undefined, { keyPair, serverKey: generateNoiseKeyPair().publicKey }),
    ).rejects.toMatchObject({ code: 'server-key-mismatch' });
  });

  it('answers a protocol 1 hello in the clear with protocol-unsupported', async () => {
    const port = await start();
    const old = await openPlain(port);
    const reply = await old.request('hello', {
      protocol: 1,
      client: CLIENT,
      auth: { pairingToken: createPairingToken().token, deviceName: 'Old phone' },
    });
    expect(reply).toMatchObject({ id: 1, error: { code: 'protocol-unsupported' } });
    expect(await old.closed).toBe(4400);
    expect(readDevices()).toEqual([]);
  });

  it.each([false, true])(
    'closes revoked sessions and refuses the key with watch events dropped: %s',
    async (dropEvents) => {
      registryWatch.dropEvents = dropEvents;
      if (dropEvents) vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const port = await start();
        const { id, keyPair } = await pair(port);
        const live = await returning(port, keyPair);

        expect(revokeDevice(id)).toBe(true);
        if (dropEvents) await vi.runOnlyPendingTimersAsync();
        expect(await live.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
        const after = await connect(port, undefined, { keyPair });
        expect(await after.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
        expect(revokeDevice(id)).toBe(false);
      } finally {
        if (dropEvents) {
          try {
            await server?.close();
            server = null;
          } finally {
            vi.useRealTimers();
          }
        }
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('Desktop reports', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('shares cached reports and pushes refreshes only to the proved Desktop connection', async () => {
    const port = await start({
      env: { HOME: root, USERPROFILE: root, PATH: dirname(process.execPath), STIM_MAINTENANCE: 'off' },
    });
    const { token } = createPairingToken(Date.now(), capabilitiesFor(true));
    const remote = await connect(port, undefined, { secret: token, keyPair: generateNoiseKeyPair() });
    const hello = await remote.request('hello', { client: CLIENT });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-reports']) } });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-report-platform']) } });
    expect(hello).toMatchObject({
      result: { features: expect.not.arrayContaining(['desktop-report-invalidate-target']) },
    });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-settings']) } });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-full-logs']) } });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-doctor-run']) } });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-stop']) } });
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    expect(await plain.request('hello', { client: CLIENT })).toMatchObject({
      result: {
        features: expect.arrayContaining([
          'desktop-reports',
          'desktop-report-platform',
          'desktop-report-invalidate-target',
        ]),
      },
    });
    for (const client of [remote, plain]) {
      for (const method of [
        'desktop.reports.get',
        'desktop.reports.subscribe',
        'desktop.reports.invalidate',
        'desktop.doctor.run',
      ]) {
        expect(
          await client.request(method, method.endsWith('invalidate') ? undefined : { report: 'gc' }),
        ).toHaveProperty('error.code', 'forbidden');
      }
    }
    const client = await desktop();
    const [first, joined] = await Promise.all([
      client.request('desktop.reports.get', { report: 'gc' }),
      client.request('desktop.reports.get', { report: 'gc' }),
    ]);
    assert('result' in first && 'result' in joined);
    expect(first).toMatchObject({
      result: {
        pending: false,
        value: { mode: 'dry-run', sections: expect.any(Object) },
        measuredAt: expect.any(String),
      },
    });
    expect(joined.result).toEqual(first.result);
    const subscribed = await client.request('desktop.reports.subscribe', { report: 'gc' });
    expect(subscribed).toHaveProperty('result.subscription');
    expect(await client.next()).toMatchObject({ event: 'desktop-report', snapshot: first.result });
    expect(await client.request('desktop.reports.invalidate', { report: 'doctor', cwd: root })).toHaveProperty(
      'result',
    );
    expect(await client.request('desktop.reports.invalidate', { report: 'doctor' })).toHaveProperty(
      'error.code',
      'bad-request',
    );
    expect(await client.request('desktop.reports.invalidate', { report: 'gc' })).toHaveProperty('result');
    expect(await client.next()).toMatchObject({ event: 'desktop-report', snapshot: { pending: true } });
    expect(await client.next()).toMatchObject({
      event: 'desktop-report',
      snapshot: { pending: false, value: { mode: 'dry-run' } },
    });
    expect(stimCalls().filter((call) => /^(doctor|gc)\b/.test(call.args))).toEqual([]);
  });

  it('reads an unregistered selected folder without recording a doctor run and rejects ambiguous targets', async () => {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    const config = join(root, 'home', 'config.json');
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_MAINTENANCE: 'off',
      },
    });
    const before = readFileSync(config, 'utf8');
    const client = await desktop();
    for (const params of [
      undefined,
      null,
      { report: 'other' },
      { report: 'doctor', cwd: 'relative' },
      { report: 'gc', cwd: root },
      { report: 'doctor', cwd: root, platform: 'macos' },
      { report: 'doctor', cwd: root, platform: null },
      { report: 'gc', platform: 'ios' },
    ])
      expect(await client.request('desktop.reports.get', params)).toMatchObject({ error: { code: 'bad-request' } });
    expect(await client.request('desktop.reports.get', { report: 'doctor', cwd: root })).toMatchObject({
      result: {
        pending: false,
        value: { project: root, platform: null, findings: expect.any(Array) },
        measuredAt: expect.any(String),
      },
    });
    for (const platform of ['ios', 'android']) {
      const target = { report: 'doctor', cwd: root, platform };
      const result = await client.request('desktop.reports.get', target);
      expect(result).toMatchObject({ result: { pending: false, value: { project: root, platform } } });
      const subscribed = await client.request('desktop.reports.subscribe', target);
      expect(subscribed).toHaveProperty('result.subscription');
      expect(await client.next()).toMatchObject({
        event: 'desktop-report',
        target,
        snapshot: { pending: false, value: { platform } },
      });
      assert('result' in subscribed && subscribed.result !== null && 'subscription' in subscribed.result);
      await client.request('unsubscribe', { subscription: subscribed.result.subscription });
    }
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(stimCalls()).toEqual([]);
  });

  it('records an explicit project check after a read-only report without spawning a CLI', async () => {
    const selected = join(root, 'selected');
    mkdirSync(selected);
    writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    const config = join(root, 'home', 'config.json');
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_MAINTENANCE: 'off',
      },
    });
    const before = readFileSync(config, 'utf8');
    const client = await desktop();
    expect(
      await client.request('desktop.reports.get', { report: 'doctor', cwd: selected, platform: 'ios' }),
    ).toMatchObject({
      result: { value: { project: selected, platform: 'ios' } },
    });
    expect(readFileSync(config, 'utf8')).toBe(before);
    for (const params of [
      undefined,
      {},
      { cwd: 'relative' },
      { cwd: selected, platform: 'web' },
      { cwd: selected, fix: true },
    ]) {
      expect(await client.request('desktop.doctor.run', params)).toHaveProperty('error.code', 'bad-request');
    }
    const started = Date.now();
    expect(await client.request('desktop.doctor.run', { cwd: selected, platform: 'ios' })).toMatchObject({
      result: { project: selected, platform: 'ios', findings: expect.any(Array) },
    });
    const recorded = JSON.parse(readFileSync(config, 'utf8')).projects[selected].doctorRuns;
    expect(Object.keys(recorded)).toEqual(['ios']);
    expect(recorded.ios.version).toBe(
      JSON.parse(readFileSync(new URL('../../stim-cli/package.json', import.meta.url), 'utf8')).version,
    );
    expect(Date.parse(recorded.ios.at)).toBeGreaterThanOrEqual(started);
    expect(stimCalls()).toEqual([]);
  });

  it('applies the report byte quota to both get and pushed errors', async () => {
    await start({
      commandLimits: { maxOutputBytes: 1 },
      env: { HOME: root, USERPROFILE: root, PATH: dirname(process.execPath), STIM_MAINTENANCE: 'off' },
    });
    const client = await desktop();
    expect(await client.request('desktop.reports.get', { report: 'gc' })).toMatchObject({
      error: { code: 'stim-failed', message: 'stim gc printed more than 1 bytes.' },
    });
    await client.request('desktop.reports.subscribe', { report: 'gc' });
    expect(await client.next()).toMatchObject({
      event: 'desktop-report',
      snapshot: { pending: false, value: null, error: 'stim gc printed more than 1 bytes.' },
    });
  });

  it('serves five identical waiting reports from one load', async () => {
    const bin = join(root, 'bin');
    const jobs = join(root, 'report-git-jobs');
    const release = join(root, 'release');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
writeFileSync(require('node:path').join(process.env.REPORT_GIT_JOBS, String(process.pid)), '');
const timer = setInterval(() => {
  if (existsSync(process.env.REPORT_RELEASE)) {
    clearInterval(timer);
    process.exit(1);
  }
}, 20);
`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: bin + ':' + process.env.PATH,
        REPORT_GIT_JOBS: jobs,
        REPORT_RELEASE: release,
        STIM_MAINTENANCE: 'off',
      },
    });
    const client = await desktop();
    const target = { report: 'doctor', cwd: workspace };
    const replies = Promise.all(Array.from({ length: 5 }, () => client.request('desktop.reports.get', target)));
    await until(() => readdirSync(jobs).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readdirSync(jobs)).toHaveLength(2);
    writeFileSync(release, '');
    const results = await replies;
    expect(results.every((reply) => 'result' in reply)).toBe(true);
    expect(new Set(results.map((reply) => ('result' in reply ? JSON.stringify(reply.result) : null))).size).toBe(1);
    expect(results[0]).toMatchObject({ result: { pending: false, value: { project: workspace } } });
  });

  it('answers interactive requests while reports wait, caps report waiters, and drains shared probes at shutdown', async () => {
    const bin = join(root, 'bin');
    const jobs = join(root, 'report-git-jobs');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}
require('node:fs').writeFileSync(require('node:path').join(process.env.REPORT_GIT_JOBS, String(process.pid)), '');
require('node:net').createServer().listen(0, '127.0.0.1');
`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const processes = () => readdirSync(jobs).map(Number);
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: bin + ':' + process.env.PATH,
        REPORT_GIT_JOBS: jobs,
        STIM_MAINTENANCE: 'off',
      },
    });
    const first = await desktop();
    const second = await desktop();
    for (let id = 100; id < 117; id++)
      first.socket.send(
        JSON.stringify({ id, method: 'desktop.reports.get', params: { report: 'doctor', cwd: workspace } }),
      );
    expect(await first.next()).toMatchObject({
      id: 116,
      error: { code: 'limit-exceeded', message: 'A connection can wait for 16 reports at a time.' },
    });
    await until(() => processes().length === 2);
    expect(await first.request('stats.get')).toHaveProperty('result');
    await second.request('desktop.reports.subscribe', { report: 'doctor', cwd: workspace });
    expect(await second.next()).toMatchObject({ event: 'desktop-report', snapshot: { pending: true } });
    first.socket.close();
    await first.closed;
    expect(processes()).toHaveLength(2);
    expect(processes().every(alive)).toBe(true);
    assert(server);
    await server.close();
    server = null;
    expect(processes()).toHaveLength(2);
    expect(processes().every((pid) => !alive(pid))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('local socket', () => {
  const another = (name: string, localSocket?: string) =>
    startServer({
      hosts: ['127.0.0.1'],
      port: 0,
      stimCli: join(root, 'fake-stim.mjs'),
      name,
      localSocket,
      stimVersion: '9.9.9',
      serverVersion: '1.2.3',
      tailscaleState: { state: 'not-running', backendState: 'Stopped' },
      env: process.env,
      frameHelper: null,
      record: false,
      history: false,
      statusAtBoot: false,
      pullRequests: async () => new Map(),
    });

  test('a long hosted home serves a private socket and removes it on close', async () => {
    process.env.STIM_HOME = join(root, 'device-host', 'sessions', 'x'.repeat(80), 'home');
    expect(Buffer.byteLength(join(process.env.STIM_HOME, 'server', 'local.sock'))).toBeGreaterThan(107);
    mkdirSync(process.env.STIM_HOME, { recursive: true });
    await start();
    const socket = serverLocalSocket();
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    expect(server!.localSocket).toBe(socket);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
    const client = await localConnect(socket);
    expect(await client.request('hello', { client: CLIENT })).toHaveProperty('result.device.id', 'local');
    await server!.close();
    server = null;
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(`${socket}.claims`)).toBe(false);
  });

  test('two servers starting on one home over a stale socket leave exactly one serving it', async () => {
    const socketPath = serverLocalSocket();
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(socketPath, 'stale');
    writeFileSync(join(root, 'fake-stim.mjs'), FAKE_STIM);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const servers = await Promise.all([another('A'), another('B')]);
    try {
      await Promise.all(servers.map((each) => each.ready));
      expect(servers.filter((each) => each.localSocket === socketPath)).toHaveLength(1);
      const client = await localConnect(socketPath);
      expect(await client.request('hello', { client: CLIENT })).toHaveProperty('result.device.id', 'local');
    } finally {
      await Promise.all(servers.map((each) => each.close()));
      error.mockRestore();
    }
  });

  test('does not put its socket in a server directory that is a symbolic link', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o755 });
    symlinkSync(elsewhere, join(process.env.STIM_HOME!, 'server'));
    writeFileSync(join(root, 'fake-stim.mjs'), FAKE_STIM);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const linked = await another('Linked', join(process.env.STIM_HOME!, 'server', 'local.sock'));
    try {
      await linked.ready;
      expect(linked.localSocket).toBeNull();
      expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('not a directory this user owns'));
    } finally {
      await linked.close();
      error.mockRestore();
    }
  });

  test('is private to this user, replaces a stale file and refuses a second server', async () => {
    const socketPath = serverLocalSocket();
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o755 });
    writeFileSync(socketPath, 'stale');
    await start();
    expect(server!.localSocket).toBe(socketPath);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(await (await desktop()).request('stats.get')).toHaveProperty('result');

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await startServer({
      hosts: ['127.0.0.1'],
      port: 0,
      stimCli: join(root, 'fake-stim.mjs'),
      name: 'Second',
      stimVersion: '9.9.9',
      serverVersion: '1.2.3',
      tailscaleState: { state: 'not-running', backendState: 'Stopped' },
      env: process.env,
      frameHelper: null,
      record: false,
      history: false,
      statusAtBoot: false,
      pullRequests: async () => new Map(),
    });
    try {
      expect((await second.ready).state).toBe('ready');
      expect(second.localSocket).toBeNull();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('another stim-server answers'));
    } finally {
      await second.close();
      error.mockRestore();
    }
    expect(await (await desktop()).request('stats.get')).toHaveProperty('result');
  });
});

describe('setup approval', () => {
  test('a setup ticket records build and device-host access for one key, once', async () => {
    const port = await start();
    const ticket = newSecret();
    storeSetupSecret(
      Buffer.from(ticket, 'base64url'),
      ['build', 'device-host'],
      new Date(Date.now() + 60_000).toISOString(),
    );
    const keyPair = generateNoiseKeyPair();
    const first = await connect(port, '100.64.0.2', { secret: ticket, keyPair, name: 'Laptop' });
    expect(await first.request('hello', { client: CLIENT, access: 'build' })).toMatchObject({
      result: { capabilities: ['build'], actions: [] },
    });
    const journal = secretValues(Buffer.from(ticket, 'base64url')).journal;
    const key = keyPair.publicKey.toString('base64url');
    expect(readBuildClients()).toEqual([
      expect.objectContaining({ name: 'Laptop', publicKey: key, capabilities: ['build'], setupJournal: journal }),
    ]);
    expect(readDeviceHostClients()).toEqual([
      expect.objectContaining({ publicKey: key, capabilities: ['device-host'], setupJournal: journal }),
    ]);
    expect(readDevices()).toEqual([]);
    const secrets = readFileSync(join(root, 'home', 'server', 'secrets.json'), 'utf8');
    expect(secrets).not.toContain(ticket);
    const other = await connect(port, '100.64.0.2', { secret: ticket });
    expect(await other.closedWith).toEqual({ code: 4401, reason: 'unknown-secret' });

    const unpaired = await connect(port, '100.64.0.2', { keyPair });
    expect(await unpaired.request('hello', { client: CLIENT })).toMatchObject({ error: { code: 'unauthorized' } });
  });

  describe.each(['build', 'device-host'] as const)('%s access', (capability) => {
    test('serves no read method and only its own capability, until revoked', async () => {
      const port = await start();
      const { keyPair, records: made } = setupClient([capability]);
      const approved = await returning(port, keyPair, '100.64.0.2', capability);
      const otherCapability: [string, unknown][] =
        capability === 'build'
          ? [['device-host.offer', { platform: 'ios' }]]
          : [
              ['build.offer', undefined],
              ['control.begin', { workspace: '/unrelated', slot: 'ios' }],
            ];
      const refused: [string, unknown][] = [
        ['status.subscribe', undefined],
        ['machine.get', undefined],
        ['notifications.list', undefined],
        ['stats.get', undefined],
        ['machine.details', undefined],
        ...otherCapability,
      ];
      for (const [method, params] of refused) {
        expect(await approved.request(method, params)).toMatchObject({ error: { code: 'forbidden' } });
      }
      const other = capability === 'build' ? 'device-host' : 'build';
      const wider = await connect(port, '100.64.0.2', { keyPair });
      expect(await wider.request('hello', { client: CLIENT, access: other })).toMatchObject({
        error: { code: 'forbidden' },
      });

      expect(revokeDevice(made[capability]!.id)).toBe(true);
      expect(await approved.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
    });
  });
});

describe('hosted device sessions', () => {
  test.skipIf(!fakeTailscale)(
    'reserves through the socket, reconnects to the same session and stops it on revocation',
    async () => {
      const port = await start();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
      import { writeFileSync, appendFileSync } from 'node:fs';
      import { delimiter, dirname, join } from 'node:path';
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      if(input.mode==='offer') {
        process.stdout.write(JSON.stringify({platform:'ios',choice:{deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'},declined:null,resources:{cpus:4,loadPerCore:0.5,memoryFreeBytes:1000,memoryPressure:'normal',workerDiskFreeBytes:null}}));
        process.exit(0);
      }

      const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
      writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
      writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
      if(input.mode==='install') appendFileSync(join(process.env.STIM_HOME,'installs'),input.attempt+'\\n');
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':input.mode==='install'?'installed':'stopped',device,...(input.mode==='install'?{launched:'unverified'}:{})}));
    `,
      );
      const pending = setupClient(['device-host'], 'Client');
      const first = await connect(port, '100.64.0.2', { keyPair: pending.keyPair });
      const hello = await first.request('hello', { client: CLIENT, access: 'device-host' });
      expect(hello).toHaveProperty('result.capabilities', ['device-host']);
      expect(await first.request('device-host.offer', { platform: 'ios' })).toHaveProperty(
        'result.choice.runtime',
        '27.1',
      );
      expect(readHostedSessions()).toEqual([]);
      const params = { workspace: '/client/app', slot: 'default', platform: 'ios', attempt: 'socket-attempt' };
      const reserved = await first.request('device-host.reserve', params);
      expect(reserved).toHaveProperty('result.state', 'preparing');
      const id = (reserved as { result: { id: string } }).result.id;
      first.socket.close();
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('ready'));
      const next = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      expect(await next.request('device-host.reserve', params)).toHaveProperty('result.id', id);
      expect(await next.request('device-host.attach', { attempt: 'socket-attempt' })).toHaveProperty(
        'result.state',
        'ready',
      );
      expect(await next.request('stats.get')).toHaveProperty('error.code', 'forbidden');
      expect(
        await next.request('device-host.metro.open', { session: id, gatewayPort: 0, secret: 'bad' }),
      ).toHaveProperty('error.code', 'bad-request');
      const metro = { session: id, gatewayPort: 65530, secret: 'a'.repeat(64) };
      const opened = await next.request('device-host.metro.open', metro);
      const metroPort = (opened as { result: { port: number } }).result.port;
      expect(metroPort).toBeGreaterThan(0);
      expect(readHostedSessions()[0]?.metroPort).toBe(metroPort);

      const content = Buffer.alloc(40000, 65);
      const digest = createHash('sha256').update(content).digest('hex');
      const files = ['Info.plist', ...Array.from({ length: 700 }, (_, index) => `Assets/resource-${index}`)].map(
        (path) => ({ path, kind: 'file', size: content.length, sha256: digest }),
      );
      const manifest = Buffer.from(JSON.stringify(files));
      expect(manifest.length).toBeGreaterThan(65536);
      const app = {
        session: id,
        attempt: 'socket-app',
        bundleId: 'dev.stim.fixture',
        mode: 'development',
        manifest: { sha256: createHash('sha256').update(manifest).digest('hex'), size: manifest.length },
      };
      expect(await next.request('device-host.app.offer', app)).toHaveProperty(
        'result.missing.0.sha256',
        app.manifest.sha256,
      );
      for (const [sha256, bytes] of [
        [app.manifest.sha256, manifest],
        [digest, content],
      ] as const) {
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          const data = bytes.subarray(offset, offset + 32768);
          expect(
            await next.request('device-host.app.chunk', {
              session: id,
              attempt: app.attempt,
              sha256,
              offset,
              data: data.toString('base64'),
            }),
          ).toHaveProperty('result.offset', offset + data.length);
        }
      }
      expect(await next.request('device-host.app.launch', { session: id, attempt: app.attempt })).toHaveProperty(
        'result.state',
        'installing',
      );
      next.socket.close();
      const reattached = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      await vi.waitFor(async () =>
        expect(
          await reattached.request('device-host.app.attach', { session: id, attempt: app.attempt }),
        ).toHaveProperty('result.state', 'installed'),
      );
      expect(await reattached.request('device-host.app.launch', { session: id, attempt: app.attempt })).toHaveProperty(
        'result.launched',
        'unverified',
      );
      expect(readFileSync(join(deviceHostArea(id), 'home', 'installs'), 'utf8')).toBe('socket-app\n');
      expect(await reattached.request('device-host.metro.open', metro)).toHaveProperty('result.port', metroPort);
      expect(await reattached.request('device-host.metro.close', { session: id })).toHaveProperty('result.port', null);
      await expect(fetch(`http://127.0.0.1:${metroPort}/status`)).rejects.toThrow('fetch failed');
      expect(await reattached.request('device-host.metro.open', metro)).toHaveProperty('result.port', metroPort);

      expect(revokeDevice(pending.records['device-host']!.id)).toBe(true);
      expect(await reattached.closed).toBe(4401);
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('stopped'));
      await expect(fetch(`http://127.0.0.1:${metroPort}/status`)).rejects.toThrow('fetch failed');
    },
  );

  test.skipIf(!fakeTailscale)(
    "only local Desktop control can list and stop another client's hosted sessions",
    async () => {
      const port = await start();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
      import { writeFileSync } from 'node:fs';
      import { delimiter, dirname, join } from 'node:path';
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
      writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
      writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:input.mode==='prepare'?[device.udid]:[],android:[],web:[]}));
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
    `,
      );
      const pending = setupClient(['device-host'], 'Client');
      const approved = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      const params = { workspace: '/client/app', slot: 'default', platform: 'ios', attempt: 'person-stop' };
      const reserved = await approved.request('device-host.reserve', params);
      if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
      const id = (reserved.result as { id: string }).id;
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('ready'));
      const local = await desktop();
      expect(await local.request('device-host.sessions')).toMatchObject({
        result: {
          sessions: [
            {
              id,
              client: { id: pending.records['device-host']!.id, name: 'Client' },
              platform: 'ios',
              device: 'iPhone (27.1)',
              app: null,
              state: 'ready',
              parked: false,
              workspace: '/client/app',
            },
          ],
        },
      });
      expect(await local.request('device-host.sessions', {})).toHaveProperty('result.sessions.0.id', id);
      expect(await local.request('device-host.sessions', { session: id })).toHaveProperty('error.code', 'bad-request');
      expect(await local.request('device-host.sessions.stop', {})).toHaveProperty('error.code', 'bad-request');
      expect(await local.request('device-host.sessions.stop', { session: id, extra: true })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(await local.request('device-host.sessions.stop', { session: 'missing' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      const { keyPair: phoneKey } = await pair(port, '100.64.0.2', true);
      const phone = await returning(port, phoneKey, '100.64.0.2');
      for (const client of [approved, phone]) {
        for (const [method, requestParams] of [
          ['device-host.sessions', undefined],
          ['device-host.sessions.stop', { session: id }],
        ] as const) {
          expect(await client.request(method, requestParams)).toMatchObject({
            error: { code: 'forbidden', message: expect.stringContaining('the Stim Desktop that started this server') },
          });
        }
      }
      expect(readHostedSessions()[0]?.state).toBe('ready');
      const other = setupClient(['device-host'], 'Other client');
      const foreign = await returning(port, other.keyPair, '100.64.0.3', 'device-host');
      expect(await foreign.request('device-host.stop', { session: id })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(await local.request('device-host.sessions.stop', { session: id })).toMatchObject({
        result: { id, state: 'stopping' },
      });
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('stopped'));
      expect(await local.request('device-host.sessions.stop', { session: id })).toMatchObject({
        result: { id, state: 'stopped' },
      });
      expect(await local.request('device-host.sessions')).toHaveProperty('result.sessions', []);
      const again = await approved.request('device-host.reserve', { ...params, attempt: 'client-stop' });
      if (!('result' in again)) throw new Error(JSON.stringify(again));
      const againId = (again.result as { id: string }).id;
      await vi.waitFor(() => expect(readHostedSessions().find((record) => record.id === againId)?.state).toBe('ready'));
      expect(await approved.request('device-host.stop', { session: againId })).toHaveProperty(
        'result.state',
        'stopping',
      );
      await vi.waitFor(() =>
        expect(readHostedSessions().find((record) => record.id === againId)?.state).toBe('stopped'),
      );
    },
  );
});

test('build.start rejects escaping or oversized macOS resources before probing the toolchain', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const toolchain = vi.spyOn(host, 'toolchain').mockResolvedValue(null);
  const session = host.session('client', {} as WebSocket, () => {});
  const base = { repo: 'app-1', project: '', platform: 'macos', fingerprint: 'digest', stimBuild: 'b1' };
  const macos = { product: 'Sample', infoPlist: 'Support/Info.plist', bundleId: 'dev.sample.stim.test' };
  const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
  try {
    session.sync({ repo: 'app-1', files: [], done: true });
    for (const options of [
      { ...macos, resources: { '../icon': 'icon' } },
      { ...macos, resources: { '/icon': 'icon' } },
      { ...macos, resources: { icon: '../icon' } },
      { ...macos, resources: { icon: '/icon' } },
      { ...macos, resources: { icon: 7 } },
      { ...macos, resources: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`icon${i}`, 'icon'])) },
      { ...macos, assetCatalog: '../Assets.xcassets' },
    ]) {
      expect(await session.start({ ...base, macos: options })).toMatchObject({ error: { code: 'bad-request' } });
    }
    expect(toolchain).not.toHaveBeenCalled();
    const valid = {
      ...base,
      macos: {
        ...macos,
        resources: { 'AppIcon.icns': 'apps/sample/Support/icon.icns' },
        assetCatalog: 'apps/sample/Support/Assets.xcassets',
      },
    };
    expect(validate({ id: 'request', method: 'build.start', params: valid })).toBe(true);
    expect(validate({ id: 'request', method: 'build.start', params: { ...valid, jdk: '17' } })).toBe(true);
    for (const jdk of ['17.0.1', '', '17; id', 17])
      expect(validate({ id: 'request', method: 'build.start', params: { ...valid, jdk } })).toBe(false);
    expect(await session.start(valid)).toMatchObject({
      error: { code: 'build-refused', message: 'This machine runs Stim build unknown.' },
    });
    expect(toolchain).toHaveBeenCalledOnce();
    expect(
      validate({
        id: 'request',
        method: 'build.start',
        params: {
          ...valid,
          macos: {
            ...valid.macos,
            resources: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`icon${i}`, 'icon'])),
          },
        },
      }),
    ).toBe(false);
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

test('build.start compares the build compatibility version when both machines report one, else the Stim build', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const worker = {
    stimBuild: 'b1',
    compat: 3,
    arch: 'arm64',
    xcode: null,
    simulatorSdk: null,
    macosSdk: null,
    cocoapods: null,
    runtimes: [],
    jdk: null,
    androidSdk: null,
  };
  const toolchain = vi.spyOn(host, 'toolchain').mockResolvedValue(worker);
  const launch = vi.spyOn(host, 'launch').mockReturnValue({ error: { code: 'build-refused', message: 'launched' } });
  const socket = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {} };
  const session = host.session('client', socket, () => {});
  const base = { repo: 'app-1', project: '', platform: 'macos', fingerprint: 'digest' };
  const macos = { product: 'Sample', infoPlist: 'Support/Info.plist', bundleId: 'dev.sample.stim.test' };
  const message = async (params: Record<string, unknown>) => {
    const reply = await session.start({ ...base, macos, ...params });
    return 'error' in reply ? reply.error.message : null;
  };
  try {
    session.sync({ repo: 'app-1', files: [], done: true });
    expect(await message({ stimBuild: 'b2', compat: 3 })).toBe('launched');
    expect(launch.mock.calls.at(-1)?.[0].job).toMatchObject({ stimBuild: 'b2', compat: 3 });
    expect(await message({ stimBuild: 'b1', compat: 4 })).toBe(
      'This machine runs Stim build b1 with build compatibility 3, not 4.',
    );
    expect(await message({ stimBuild: 'b2' })).toBe('This machine runs Stim build b1.');
    expect(await message({ stimBuild: 'b1' })).toBe('launched');
    expect(launch.mock.calls.at(-1)?.[0].job).not.toHaveProperty('jdk');
    expect(await message({ stimBuild: 'b2', compat: 3, jdk: '17' })).toBe('launched');
    expect(launch.mock.calls.at(-1)?.[0].job).toMatchObject({ jdk: '17' });
    toolchain.mockResolvedValue({ ...worker, compat: undefined });
    expect(await message({ stimBuild: 'b2', compat: 3 })).toBe('This machine runs Stim build b1.');
    expect(launch).toHaveBeenCalledTimes(3);
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

test('native Gradle requires declared source scope and a null artifact identity before worker admission', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const toolchain = vi.spyOn(host, 'toolchain').mockResolvedValue(null);
  const session = host.session('client', {} as WebSocket, () => {});
  const android = { variant: 'freeRelease', abi: null, gradleBuildCache: true, pch: 'auto', compilerCache: 'none' };
  const inputs = { complete: true, ignored: [], outputs: ['app/build'] };
  const native = { provider: 'gradle', sourceDigest: 'a'.repeat(64), inputs };
  const valid = {
    configuration: null,
    scheme: null,
    runtime: null,
    packageName: null,
    isExpo: false,
    optimizations: null,
    repo: 'app-1',
    project: '',
    platform: 'android',
    fingerprint: null,
    stimBuild: 'b1',
    android,
    native,
  };
  try {
    session.sync({ repo: 'app-1', files: [], done: true });
    for (const invalid of [
      { ...valid, native: undefined },
      { ...valid, fingerprint: 'fake-reusable-identity' },
      { ...valid, native: { ...native, sourceDigest: '' } },
      { ...valid, native: { ...native, inputs: { ...inputs, complete: false } } },
      { ...valid, native: { ...native, inputs: { ...inputs, outputs: ['../outside'] } } },
      ...[null, {}, { read: false, write: true }, { read: 'false', write: true, remote: true }].map((cache) =>
        Object.assign({}, valid, { native: { ...native, cache } }),
      ),
      { ...valid, platform: 'ios', runtime: 'iOS-27-0' },
    ])
      expect(await session.start(invalid)).toMatchObject({ error: { code: 'bad-request' } });
    expect(toolchain).not.toHaveBeenCalled();
    const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
    expect(validate({ id: 'request', method: 'build.start', params: valid })).toBe(true);
    expect(
      validate({
        id: 'request',
        method: 'build.start',
        params: { ...valid, native: { ...native, cache: { read: false, write: true, remote: false } } },
      }),
    ).toBe(true);
    for (const params of [
      { ...valid, native: undefined },
      { ...valid, fingerprint: 'fake-reusable-identity' },
    ])
      expect(validate({ id: 'request', method: 'build.start', params })).toBe(false);
    expect(await session.start(valid)).toMatchObject({
      error: { code: 'build-refused', message: 'This machine runs Stim build unknown.' },
    });
    expect(toolchain).toHaveBeenCalledExactlyOnceWith(null, 'gradle');
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

test('native and general toolchain reports cache independently from each Ruby context', async () => {
  const worker = join(root, 'toolchain-context.mjs');
  const toolchainCalls = join(root, 'toolchain-context.calls');
  writeFileSync(
    worker,
    `
import { appendFileSync } from 'node:fs';
const context = process.argv.slice(2);
appendFileSync(${JSON.stringify(toolchainCalls)}, JSON.stringify(context) + '\\n');
const native = context[0] === 'offer-native-xcode';
console.log(JSON.stringify({ stimBuild: 'b1', xcode: 'Xcode 27.0', simulatorSdk: '27.0', runtimes: ['iOS-27-0'], cocoapods: native ? null : (context[1] ?? 'default'), macosSdk: native ? null : '26.6' }));
`,
  );
  const host = new BuildHost({ worker, env: process.env });
  try {
    for (const context of [undefined, 'ruby-3.3.4']) {
      expect(await host.toolchain(context, 'xcode')).toMatchObject({
        cocoapods: null,
        macosSdk: null,
        runtimes: ['iOS-27-0'],
      });
      expect(await host.toolchain(context)).toMatchObject({ cocoapods: context ?? 'default', macosSdk: '26.6' });
      expect(await host.toolchain(context, 'xcode')).toMatchObject({ cocoapods: null, macosSdk: null });
      expect(await host.toolchain(context)).toMatchObject({ cocoapods: context ?? 'default' });
    }
    expect(
      readFileSync(toolchainCalls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([['offer-native-xcode'], ['offer'], ['offer', 'ruby-3.3.4']]);
  } finally {
    await host.close();
  }
});

test('native build admission rejects invalid provider identity before toolchain or worker work', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const toolchain = vi.spyOn(host, 'toolchain').mockResolvedValue(null);
  const session = host.session('client', {} as WebSocket, () => {});
  const native = {
    provider: 'xcode',
    sourceDigest: 'a'.repeat(64),
    cacheKey: 'artifact-key',
    arch: 'arm64',
    parameters: {},
  };
  const base = {
    repo: 'app-1',
    project: '',
    platform: 'ios',
    runtime: 'iOS-27-0',
    configuration: 'Debug',
    scheme: 'Native',
    packageName: null,
    isExpo: false,
    fingerprint: 'input-key',
    stimBuild: 'b1',
    native,
    optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
  };
  const empty = createHash('sha256').update('').digest('hex');
  const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
  try {
    expect(
      session.sync({
        repo: 'app-1',
        files: [{ path: 'Empty.bundle', kind: 'directory', size: 1, sha256: empty }],
        done: true,
      }),
    ).toHaveProperty('error.code', 'bad-request');
    expect(
      session.sync({
        repo: 'app-1',
        files: [{ path: 'Empty.bundle', kind: 'directory', size: 0, sha256: empty }],
        done: true,
      }),
    ).toHaveProperty('result.missing', [empty]);
    expect(session.blob(Buffer.from(empty, 'hex'))).toBeNull();
    for (const changed of [
      { provider: 'gradle' },
      { sourceDigest: 'unverified' },
      { cacheKey: '' },
      { arch: 'armv7' },
      { parameters: null },
    ]) {
      const params = { ...base, native: { ...native, ...changed } };
      expect(validate({ id: 'request', method: 'build.start', params })).toBe(false);
      expect(await session.start(params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(await session.start({ ...base, native: undefined })).toHaveProperty('error.code', 'bad-request');
    expect(await session.start({ ...base, platform: 'android' })).toHaveProperty('error.code', 'bad-request');
    expect(await session.start({ ...base, optimizations: null })).toHaveProperty('error.code', 'bad-request');
    expect(await host.offer('client', { repo: 'app-1', native: 'unsupported' })).toHaveProperty(
      'error.code',
      'bad-request',
    );
    expect(validate({ id: 'request', method: 'build.offer', params: { repo: 'app-1', native: 'unsupported' } })).toBe(
      false,
    );
    expect(toolchain).not.toHaveBeenCalled();
    expect(validate({ id: 'request', method: 'build.offer', params: { repo: 'app-1', native: 'xcode' } })).toBe(true);
    expect(await host.offer('client', { repo: 'app-1', native: 'xcode' })).toHaveProperty(
      'error.code',
      'build-refused',
    );
    expect(toolchain).toHaveBeenLastCalledWith(null, 'xcode');
    toolchain.mockClear();
    expect(validate({ id: 'request', method: 'build.start', params: base })).toBe(true);
    expect(await session.start(base)).toHaveProperty('error.code', 'build-refused');
    expect(toolchain).toHaveBeenCalledOnce();
    expect(toolchain).toHaveBeenCalledWith(null, 'xcode');
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
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

  beforeEach(() => configure({ server: { maxLoadPerCore: 100_000 } }));

  async function buildClient(
    port: number,
    peer = '100.64.0.2',
    machine = setupClient(['build'], 'Laptop'),
  ): Promise<{ client: Client; id: string; keyPair: NoiseKeyPair }> {
    const client = await returning(port, machine.keyPair, peer, 'build');
    return { client, id: machine.records.build!.id, keyPair: machine.keyPair };
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
    'a machine that cannot host refuses device-host access and still takes builds',
    async () => {
      const port = await start({ hostsDevices: false });
      const machine = setupClient(['build', 'device-host'], 'Host client');
      const asking = await connect(port, '100.64.0.3', { keyPair: machine.keyPair });
      expect(await asking.request('hello', { client: CLIENT, access: 'device-host' })).toMatchObject({
        error: { code: 'forbidden', message: expect.stringContaining('needs a Mac') },
      });
      const { client } = await buildClient(port, '100.64.0.3', machine);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { max: 1 } },
      });
    },
  );

  test.skipIf(!fakeTailscale)(
    'mirrors a content-addressed manifest, builds it and returns the artifact with its digest',
    async () => {
      const port = await start();
      const { client, id } = await buildClient(port);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: {
          toolchain: { stimBuild: 'b1', runtimes: ['iOS-27-0'], macosSdk: '27.0' },
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
      const fingerprintSources = [
        { id: 'ios', hash: 'ab12' },
        { id: 'expoConfig', hash: null },
      ];
      expect(
        await client.request('build.start', { ...START, fingerprintSources: [{ id: 'ios', hash: '../x' }] }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      expect(await client.request('build.start', { ...START, fingerprintIgnored: [3] })).toMatchObject({
        error: { code: 'bad-request' },
      });
      for (const bad of [[3], ['ios/main.jsbundle'], ['..'], ['.'], [''], ['a\0b'], ['*'.repeat(256)]]) {
        expect(await client.request('build.start', { ...START, fingerprintTracked: bad })).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
      const fingerprintIgnored = ['.env.local', 'ios/main.jsbundle'];
      const fingerprintTracked = ['GoogleService-Info.plist'];
      const started = await client.request('build.start', {
        ...START,
        fingerprintSources,
        fingerprintIgnored,
        fingerprintTracked,
      });
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
      expect(ran.job).toMatchObject({
        area,
        project: 'apps/mobile',
        expectedFingerprint: 'f00d',
        expectedSources: fingerprintSources,
        expectedIgnored: fingerprintIgnored,
        expectedTracked: fingerprintTracked,
        runtime: 'iOS-27-0',
      });
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
        result: {
          name: 'App.app',
          size: 17,
          sha256: sha('app archive bytes'),
          handoff: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(existsSync(join(area, 'out', job))).toBe(true);
      expect(readAudit()).toMatchObject([{ action: 'build', workspace: 'app-1', ok: true }]);

      const viewer = await authed(port);
      expect(await viewer.request('build.offer', { repo: 'app-1' })).toMatchObject({ error: { code: 'forbidden' } });
      expect(
        await viewer.request('build.cached-artifact', {
          repo: 'app-1',
          artifact: { fingerprint: 'f00d', cacheKey: 'complete-key' },
        }),
      ).toHaveProperty('error.code', 'forbidden');
      expect(await viewer.request('device-host.offer', { platform: 'ios' })).toHaveProperty('error.code', 'forbidden');
    },
  );

  test.skipIf(!fakeTailscale)(
    'a reconnected approved client fetches an exact completed archive without another build',
    async () => {
      const port = await start();
      const { client, id, keyPair } = await buildClient(port);
      const identity = { fingerprint: 'f00d', cacheKey: 'source-sdk27-arm64-target' };
      expect(await client.request('build.sync', { repo: 'app-1', files: [], done: true })).toHaveProperty(
        'result.missing',
        [],
      );
      const started = await client.request('build.start', {
        ...START,
        project: '',
        native: {
          provider: 'xcode',
          sourceDigest: sha(''),
          cacheKey: identity.cacheKey,
          arch: 'arm64',
          parameters: { sdk: '27.0' },
        },
        optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
      });
      expect(started).toHaveProperty('result.job');
      await progress(client);
      client.socket.close();
      await client.closed;
      const area = join(root, 'home', 'build-worker', id, 'repos', 'app-1');
      rmSync(join(area, 'out'), { recursive: true, force: true });
      const again = await returning(port, keyPair, '100.64.0.2', 'build');
      expect(await again.request('build.offer', { repo: 'app-1', native: 'xcode', artifact: identity })).toHaveProperty(
        'result.artifact',
        {
          ...identity,
          name: 'App.app',
          size: 17,
          sha256: sha('app archive bytes'),
        },
      );
      again.socket.send(
        JSON.stringify({ id: 99, method: 'build.cached-artifact', params: { repo: 'app-1', artifact: identity } }),
      );
      const frame = await again.next();
      if (!('binary' in frame) || !Buffer.isBuffer(frame.binary)) throw new Error('Expected an archive frame');
      expect(frame.binary.subarray(32).toString()).toBe('app archive bytes');
      expect(await again.next()).toMatchObject({
        id: 99,
        result: { ...identity, size: 17, sha256: sha('app archive bytes') },
      });
      expect(readAudit().filter((entry) => entry.action === 'build')).toHaveLength(1);
    },
  );

  test.skipIf(!fakeTailscale)(
    'lets only a machine approved for builds or device hosting ask the server to update itself',
    async () => {
      const port = await start({
        service: {
          label: 'dev.stim.test',
          node: process.execPath,
          script: '/nowhere',
          runsAsService: async () => true,
        },
      });
      const { client } = await buildClient(port);
      expect(await client.request('server.update.status')).toMatchObject({
        result: {
          server: { version: '1.2.3' },
          service: 'dev.stim.test',
          acceptsClientBuilds: false,
          running: null,
        },
      });
      expect(
        await client.request('server.update.start', { packages: [{ name: 'a.tgz', size: 1, sha256: sha('a') }] }),
      ).toMatchObject({ error: { code: 'forbidden', message: expect.stringContaining('server.acceptClientBuilds') } });
      expect(await client.request('server.update.start', { release: 'latest' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      const host = await returning(port, setupClient(['device-host']).keyPair, '100.64.0.3', 'device-host');
      expect(await host.request('server.update.status')).toMatchObject({ result: { service: 'dev.stim.test' } });
      const viewer = await authed(port);
      expect(await viewer.request('server.update.status')).toMatchObject({ error: { code: 'forbidden' } });
      expect(await viewer.request('server.update.start', { release: '1.15.0' })).toMatchObject({
        error: { code: 'forbidden' },
      });
    },
  );

  test.skipIf(!fakeTailscale)('declines offloaded builds while an update of this server runs', async () => {
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      const updater = join(root, 'updater.mjs');
      const release = join(root, 'release-updater');
      writeFileSync(
        updater,
        `const { existsSync } = await import('node:fs'); const wait = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(wait); console.log('Another update is running.'); process.exit(1); } }, 50);`,
      );
      const port = await start({
        service: { label: 'dev.stim.drain', node: process.execPath, script: updater, runsAsService: async () => true },
      });
      const { client } = await buildClient(port);
      expect(await client.request('server.update.start', { release: '1.15.0' })).toMatchObject({
        result: { state: 'installing' },
      });
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { declined: 'stim-server is updating to release 1.15.0' } },
      });
      writeFileSync(release, '');
      await eventually(() => readAudit().some((record) => record.action === 'server.update.ended'));
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { declined: null } },
      });
      expect(await client.request('server.update.status')).toMatchObject({
        result: {
          running: null,
          last: { ok: false, message: expect.stringContaining(': Another update is running.;') },
        },
      });
      const later = {
        at: '2999-01-01T00:00:00.000Z',
        target: 'release 1.15.0',
        ok: true,
        message: 'updated by another run',
      };
      writeFileSync(join(serviceRoot('dev.stim.drain'), 'last-update.json'), JSON.stringify(later));
      expect(await client.request('server.update.status')).toMatchObject({ result: { last: later } });
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

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
      expect(await client.request('build.start', { ...base, android: { ...android, module: 'app' } })).toMatchObject({
        error: { code: 'bad-request' },
      });
      const layout = { gradleRoot: '../..', module: ':packages:rn-tester:android:app' };
      expect(await client.request('build.start', { ...base, android: { ...android, ...layout } })).toMatchObject({
        result: { job: expect.any(String) },
      });
      await progress(client);
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.job).toMatchObject({ platform: 'android', runtime: null, android: { ...android, ...layout } });
      expect(ran.gradle).toBe(join(process.env.STIM_HOME!, 'build-worker', id, 'cache', 'gradle'));
    },
  );

  test.skipIf(!fakeTailscale)(
    'refuses malformed macOS jobs and launches valid jobs with a private SwiftPM cache',
    async () => {
      const port = await start();
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('Package.swift', 'x')], done: true });
      client.socket.send(blob('x'));
      const base = { repo: 'app-1', project: '', platform: 'macos', fingerprint: 'f00d', stimBuild: 'b1' };
      const macos = {
        product: 'Sample',
        infoPlist: 'Support/Info.plist',
        bundleId: 'dev.sample.stim.test',
        resources: { 'AppIcon.icns': 'apps/sample/Support/icon.icns' },
        assetCatalog: 'apps/sample/Support/Assets.xcassets',
      };
      for (const options of [
        undefined,
        { ...macos, product: '../Sample' },
        { ...macos, infoPlist: '../Info.plist' },
        { ...macos, bundleId: '-bad' },
      ]) {
        expect(await client.request('build.start', { ...base, macos: options })).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
      expect(await client.request('build.start', { ...base, macos })).toMatchObject({
        result: { job: expect.any(String) },
      });
      await progress(client);
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.job).toMatchObject({
        platform: 'macos',
        project: '',
        macos,
        swiftpmCache: join(process.env.STIM_HOME!, 'build-worker', id, 'cache', 'swiftpm'),
      });
      const scratch = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1', 'macos', 'root');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'output'), 'built');
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { warm: { build: false } },
      });
    },
  );

  async function nativeBuild(
    port: number,
    peer: string,
    platform: 'android' | 'macos' = 'macos',
    machine = setupClient(['build'], 'Laptop'),
  ) {
    const { client, id } = await buildClient(port, peer, machine);
    await client.request('build.sync', { repo: 'app-1', files: [file('Package.swift', 'x')], done: true });
    client.socket.send(blob('x'));
    const started = await client.request('build.start', {
      repo: 'app-1',
      project: '',
      platform,
      fingerprint: 'f00d',
      stimBuild: 'b1',
      ...(platform === 'android'
        ? {
            android: {
              variant: 'debug',
              abi: 'arm64-v8a',
              gradleBuildCache: true,
              pch: 'auto',
              compilerCache: 'ccache',
            },
          }
        : { macos: { product: 'Sample', infoPlist: 'Support/Info.plist', bundleId: 'dev.sample.stim.test' } }),
    });
    const job = (started as { result: { job: string } }).result.job;
    await progress(client);
    const fetched = await client.request('build.artifact', { job });
    const { handoff, sha256 } = (fetched as { result: { handoff?: string; sha256: string } }).result;
    const out = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1', 'out', job);
    return { id, out, build: { handoff: handoff!, sha256 } };
  }

  test.skipIf(!fakeTailscale)(
    'hands a fetched macOS build once, and only to a hosted session of the same machine key',
    async () => {
      const port = await start();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
        import {writeFileSync} from 'node:fs';import {join} from 'node:path';
        const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks));
        const device={architecture:'arm64',macosVersion:'27.0',appSlot:input.appSlot};
        if(input.mode==='prepare')writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
        process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
      `,
      );
      const machine = setupClient(['build', 'device-host'], 'Hosting client');
      const elsewhere = await nativeBuild(port, '100.64.0.2');
      const revoked = await nativeBuild(port, '100.64.0.2');
      const own = await nativeBuild(port, '100.64.0.2', 'macos', machine);
      expect(own.build.handoff).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(own.out, 'app.tgz'))).toBe(false);
      expect(existsSync(join(own.out, 'App.app'))).toBe(true);

      const hosting = await returning(port, machine.keyPair, '100.64.0.2', 'device-host');
      const reserved = await hosting.request('device-host.reserve', {
        workspace: '/client/app',
        slot: 'default',
        platform: 'macos',
        attempt: 'handoff',
      });
      const session = (reserved as { result: { id: string } }).result.id;
      await vi.waitFor(async () =>
        expect(await hosting.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      const entry = (path: string, kind: string, text: string) => ({ ...file(path, text), kind });
      const files = [
        entry('Contents/Current', 'link', 'MacOS'),
        entry('Contents/Info.plist', 'file', 'plist bytes'),
        entry('Contents/MacOS/Sample', 'exec', 'binary bytes'),
        entry('Contents/PkgInfo', 'file', 'APPL????'),
        entry('Contents/data', 'file', 'data bytes'),
      ];
      const manifest = JSON.stringify(files);
      const app = {
        session,
        attempt: 'app',
        bundleId: 'dev.sample.stim.test',
        mode: 'release',
        manifest: { sha256: sha(manifest), size: manifest.length },
      };
      const handoff = (build: { handoff: string; sha256: string }) =>
        hosting.request('device-host.app.handoff', { session, attempt: 'app', build });
      await hosting.request('device-host.app.offer', app);
      expect(await handoff(own.build)).toHaveProperty('error.message', expect.stringContaining('manifest'));
      await hosting.request('device-host.app.chunk', {
        session,
        attempt: 'app',
        sha256: sha(manifest),
        offset: 0,
        data: Buffer.from(manifest).toString('base64'),
      });
      expect(await hosting.request('device-host.app.offer', app)).toHaveProperty('result.missing.length', 5);

      expect(await handoff(elsewhere.build)).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('different keys') },
      });
      expect(existsSync(join(elsewhere.out, 'App.app'))).toBe(true);
      expect(revokeDevice(revoked.id)).toBe(true);
      await eventually(() => !existsSync(revoked.out));
      expect(await handoff(revoked.build)).toHaveProperty('error.code', 'action-failed');
      expect(await handoff({ ...own.build, sha256: 'c'.repeat(64) })).toHaveProperty('error.code', 'action-failed');
      const contents = join(own.out, 'App.app', 'Contents');
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'Info.plist'), 'plist bytes');
      writeFileSync(join(outside, 'Sample'), 'binary bytes');
      rmSync(join(contents, 'Info.plist'));
      symlinkSync(join(outside, 'Info.plist'), join(contents, 'Info.plist'));
      rmSync(join(contents, 'MacOS'), { recursive: true });
      symlinkSync(outside, join(contents, 'MacOS'));
      writeFileSync(join(contents, 'data'), 'DATA bytes');
      expect(await handoff(own.build)).toHaveProperty('result', {
        files: 2,
        bytes: 'MacOS'.length + 'APPL????'.length,
      });
      expect(existsSync(own.out)).toBe(false);
      expect(await handoff(own.build)).toHaveProperty('error.message', expect.stringContaining('no longer holds'));
      const blobs = join(deviceHostArea(session), 'blobs');
      expect(readFileSync(join(blobs, sha('APPL????')), 'utf8')).toBe('APPL????');
      expect(readFileSync(join(blobs, sha('MacOS')), 'utf8')).toBe('MacOS');
      const offered = await hosting.request('device-host.app.offer', app);
      expect(
        (offered as { result: { missing: { sha256: string }[] } }).result.missing.map((each) => each.sha256).toSorted(),
      ).toEqual([sha('plist bytes'), sha('binary bytes'), sha('data bytes')].toSorted());
    },
  );

  test.skipIf(!fakeTailscale)(
    'Android handoff checks same-node approvals, archive digest and APK-only manifest before copying verified bytes',
    async () => {
      const port = await start();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
      import {writeFileSync} from 'node:fs';import {join} from 'node:path';
      const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      const device={avdName:'stim-hosted-'+input.session,serial:'emulator-'+input.consolePort,consolePort:input.consolePort,
        systemImage:'system-images;android-30;google_apis;arm64-v8a',deviceProfile:'pixel_6',architecture:'arm64-v8a'};
      if(input.mode==='prepare') {
        writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
        writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[],android:[device.avdName],web:[]}));
      }
      if(input.mode==='stop')writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[],android:[],web:[]}));
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
    `,
      );
      const machine = setupClient(['build', 'device-host'], 'Android hosting client');
      const elsewhere = await nativeBuild(port, '100.64.0.2', 'android');
      const own = await nativeBuild(port, '100.64.0.2', 'android', machine);
      expect(existsSync(join(own.out, 'App.apk'))).toBe(true);
      const hosting = await returning(port, machine.keyPair, '100.64.0.2', 'device-host');
      const reserved = await hosting.request('device-host.reserve', {
        workspace: '/client/app',
        slot: 'default',
        platform: 'android',
        attempt: 'handoff',
      });
      const session = (reserved as { result: { id: string } }).result.id;
      await vi.waitFor(async () =>
        expect(await hosting.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      const offer = async (attempt: string, files: object[]) => {
        const manifest = JSON.stringify(files);
        const app = {
          session,
          attempt,
          bundleId: 'dev.fixture',
          mode: 'release',
          manifest: { sha256: sha(manifest), size: manifest.length },
        };
        await hosting.request('device-host.app.offer', app);
        await hosting.request('device-host.app.chunk', {
          session,
          attempt,
          sha256: sha(manifest),
          offset: 0,
          data: Buffer.from(manifest).toString('base64'),
        });
        return app;
      };
      const handoff = (build: { handoff: string; sha256: string }) =>
        hosting.request('device-host.app.handoff', { session, attempt: 'app', build });
      const app = await offer('app', [{ ...file('App.apk', 'APK bytes'), kind: 'file' }]);
      expect(await handoff(elsewhere.build)).toHaveProperty('error.message', expect.stringContaining('different keys'));
      expect(await handoff({ ...own.build, sha256: 'c'.repeat(64) })).toHaveProperty('error.code', 'action-failed');
      expect(await handoff(own.build)).toHaveProperty('result', { files: 1, bytes: 9 });
      expect(await hosting.request('device-host.app.offer', app)).toHaveProperty('result.missing', []);
      expect(readFileSync(join(deviceHostArea(session), 'blobs', sha('APK bytes')), 'utf8')).toBe('APK bytes');
      expect(existsSync(own.out)).toBe(false);
      expect(await handoff(own.build)).toHaveProperty('error.code', 'action-failed');
    },
  );

  test.skipIf(!fakeTailscale)('deletes a fetched macOS build nobody takes once its handoff lapses', async () => {
    const port = await start({ buildLimits: { handoffMs: 50 } });
    const { out } = await nativeBuild(port, '100.64.0.2');
    await eventually(() => !existsSync(out));
  });

  test.skipIf(!fakeTailscale)(
    'declines an offer and a start while its own native builds fill concurrency.maxBuilds',
    async () => {
      configure({ concurrency: { maxBuilds: 1 }, server: { maxLoadPerCore: 100_000 } });
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
        result: {
          capacity: {
            builds: 0,
            maxBuilds: 1,
            declined: null,
            cpus: expect.any(Number),
            memoryTotalBytes: expect.any(Number),
            memoryUsedBytes: expect.toSatisfy((bytes: number) => bytes > 0),
          },
        },
      });

      writeActive('compile');
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 0, builds: 1, maxBuilds: 1, declined: 'all 1 build slots busy' } },
      });
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({
        error: { code: 'build-busy', message: 'This machine declines the build: all 1 build slots busy.' },
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
      configure({ concurrency: { maxBuilds: 1 }, server: { maxLoadPerCore: 100_000 } });
      const local = tryAcquireBuildSlotClaim({ max: 1, details: { projectRoot: root } })!;
      const port = await start({ env: { FAKE_WORKER_HANG: '1' }, buildLimits: { killGraceMs: 100 } });
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({
        error: { code: 'build-busy', message: 'This machine declines the build: all 1 build slots busy.' },
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
      const { client, keyPair } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const job = ((await client.request('build.start', START)) as { result: { job: string } }).result.job;
      expect(await client.next()).toMatchObject({ phase: 'build' });
      client.socket.terminate();
      expect(await client.closed).toBe(1006);

      const other = await buildClient(port, '100.64.0.3');
      expect(await other.client.request('build.attach', { job })).toMatchObject({ error: { code: 'bad-request' } });

      const again = await returning(port, keyPair, '100.64.0.2', 'build');
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
      const { client, keyPair } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const job = ((await client.request('build.start', START)) as { result: { job: string } }).result.job;

      const again = await returning(port, keyPair, '100.64.0.2', 'build');
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
    'stops a revoked build, frees its claim and deletes its area with watch events dropped: %s',
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
      await eventually(() => !existsSync(join(area, '..', '..')));
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
        configure({ server: { maxLoadPerCore: 100_000, gradleDaemonIdleMinutes: 45 } });
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
  test.skipIf(process.platform === 'win32')(
    'shares a permission probe across concurrent health and authenticated hello, then refreshes grants',
    async () => {
      const executable = join(root, 'host-probe');
      const grants = join(root, 'grants.json');
      const probes = join(root, 'probes');
      writeFileSync(grants, JSON.stringify({ screenRecording: false, accessibility: true }));
      writeFileSync(
        executable,
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
setTimeout(() => console.log(fs.readFileSync(${JSON.stringify(grants)}, 'utf8')), 50);
`,
        { mode: 0o755 },
      );
      const port = await start({ host: { executable, name: 'Stim Host Dev' } });
      const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { host: unknown };
      const client = await connect(port, undefined, { secret: createPairingToken().token });
      const [first, second, hello] = await Promise.all([
        health(),
        health(),
        client.request('hello', { client: CLIENT }),
      ]);
      expect(first.host).toEqual({ name: 'Stim Host Dev', screenRecording: false, accessibility: true });
      expect(second.host).toEqual(first.host);
      expect(hello).toMatchObject({ result: { host: first.host } });
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      validator.addSchema(protocolJsonSchema(), 'protocol');
      const acceptsHello = validator.compile({ $ref: 'protocol#/$defs/HelloResult' });
      if (!('result' in hello)) throw new Error(JSON.stringify(hello));
      expect(acceptsHello(hello.result)).toBe(true);
      expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(1);
      writeFileSync(grants, JSON.stringify({ screenRecording: true, accessibility: true }));
      expect((await health()).host).toEqual(first.host);
      const now = Date.now();
      const date = vi.spyOn(Date, 'now').mockReturnValue(now + 5001);
      try {
        expect((await health()).host).toEqual({ name: 'Stim Host Dev', screenRecording: true, accessibility: true });
        expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(2);
      } finally {
        date.mockRestore();
      }
    },
  );

  it('reports unavailable grants when the host probe fails', async () => {
    const port = await start({ host: { executable: join(root, 'missing'), name: 'Stim Host Dev' } });
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toHaveProperty('host', null);
  });

  it('serves only this machine when loopback only, refusing peers a tailscale serve route forwards', async () => {
    const port = await start({ loopbackOnly: true });
    const local = await fetch(`http://127.0.0.1:${port}/health`);
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ loopbackOnly: true });
    const forwarded = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '100.64.0.2' } });
    expect(forwarded.status).toBe(403);
    await expect(connect(port, '100.64.0.2')).rejects.toThrow('HTTP 403');
    await expect(pair(port)).resolves.toHaveProperty('id');
  });

  it('answers requests from this machine in full and tailnet peers with the server version only', async () => {
    const port = await start();
    const local = await fetch(`http://127.0.0.1:${port}/health`);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({
      server: 'stim-server',
      name: 'Test Mac',
      version: '1.2.3',
      stim: '9.9.9',
      stimBuild: expect.stringMatching(/^[0-9a-f]{16}$/),
      protocol: 2,
      stimHome: process.env.STIM_HOME,
      startup: { state: 'ready' },
      busy: { builds: 0, hostedSessions: 0 },
      tailscale: { state: 'not-running', backendState: 'Stopped' },
      nativeViewerOpened: false,
    });
    const forwarded = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '100.64.0.2' } });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual({ version: '1.2.3' });
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

  test.skipIf(!fakeTailscale)(
    'refuses the agent route to web pages and unknown sessions and never answers it as a WebSocket upgrade page',
    async () => {
      const port = await start();
      const session = '11111111-1111-4111-8111-111111111111';
      const agent = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/device-host/agent/${session}/rpc`, { method: 'POST', body: '{}', headers });
      expect((await agent({})).status).toBe(404);
      expect((await agent({ 'x-forwarded-for': '100.64.0.2', origin: 'http://attacker.example' })).status).toBe(403);
      expect((await agent({ 'x-forwarded-for': '100.64.0.2', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await agent({ 'x-forwarded-for': '100.64.0.2', authorization: 'Bearer nothing' })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/device-host/agent/not-a-session/rpc`)).status).toBe(426);
    },
  );

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
    const tailnetClient = await openRaw(`ws://[::1]:${port}`);
    const dropped = new Promise((resolve) => tailnetClient.once('close', resolve));
    next = { state: 'not-running', backendState: 'Stopped' };
    await eventually(() => server!.addresses.length === 1);
    await dropped;
    expect(await health()).toEqual({ state: 'not-running', backendState: 'Stopped' });
    monitor.stop();
  });

  it('listens on the bind addresses of a transport that never reports a change', async () => {
    const port = await start({
      transports: [
        {
          id: 'static',
          traits: { privateNetwork: true, tls: 'none', peerIdentity: false },
          bindAddresses: () => ['::1'],
        },
      ],
    });
    expect(server?.addresses).toEqual([
      { host: '127.0.0.1', port },
      { host: '::1', port },
    ]);
  });

  it('reports Tailscale but never listens on its addresses when loopback only', async () => {
    const running: TailscaleState = { state: 'running', ips: ['::1'], dnsName: 'mac.tail1.ts.net', hostName: 'mac' };
    const monitor = watchTailscale({
      env: {},
      initial: { binary: 'tailscale', state: running },
      find: () => 'tailscale',
      read: async () => running,
      backoffMs: 10,
      maxMs: 20,
    });
    const port = await start({ loopbackOnly: true, tailscaleState: running, tailscaleMonitor: monitor });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server!.addresses).toEqual([{ host: '127.0.0.1', port }]);
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
    const { keyPair } = await pair(port);
    const client = await connect(port, undefined, { keyPair });
    expect(await client.request('status.subscribe')).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await client.closed).toBe(4401);
    expect(readdirSync(root)).not.toContain('pids');
  });

  it('closes a silent connection after the timeout and rate-limits repeated failures by peer', async () => {
    const port = await start({ authTimeoutMs: 100, maxAuthFailures: 2 });
    const silent = await openPlain(port, '100.64.0.2');
    expect(await silent.closed).toBe(4408);
    const stranger = await connect(port, '100.64.0.2');
    expect(await stranger.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });

    await expect(openPlain(port, '100.64.0.2')).rejects.toThrow('HTTP 429');
    const otherPeer = await openPlain(port, '100.64.0.3');
    expect(otherPeer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('lets a requester poll with a setup ticket the server does not hold yet without being rate limited', async () => {
    const port = await start({ maxAuthFailures: 2 });
    const ticket = newSecret();
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(connect(port, '100.64.0.2', { secret: ticket })).rejects.toMatchObject({ code: 'unknown-secret' });
    }
    storeSetupSecret(Buffer.from(ticket, 'base64url'), ['build'], new Date(Date.now() + 60_000).toISOString());
    const client = await connect(port, '100.64.0.2', { secret: ticket });
    expect(await client.request('hello', { client: CLIENT, access: 'build' })).toHaveProperty('result.capabilities', [
      'build',
    ]);
  });

  it('refuses a web page before it can spend the failed-attempt budget of this machine', async () => {
    const port = await start({ authTimeoutMs: 100, maxAuthFailures: 2 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(openPlain(port, undefined, { origin: 'https://attacker.example' })).rejects.toThrow('HTTP 403');
    }
    await expect(pair(port)).resolves.toHaveProperty('id');
  });
});

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find(
    (info) =>
      info?.family === 'IPv4' && !info.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(info.address),
  )?.address;

describe.skipIf(!lanIp)('the local network listener', () => {
  const host = lanIp ?? '';
  const lan = () => [localTransport({ entries: () => [host] })];
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
  });
  const raw = (port: number) =>
    new Promise<{ socket: Socket; closed: Promise<void> }>((resolve, reject) => {
      const socket = connectNet(port, host);
      sockets.push(socket);
      const closed = once(socket, 'close').then(() => undefined);
      socket.once('connect', () => resolve({ socket, closed }));
      socket.once('error', reject);
    });
  const stillOpen = (closed: Promise<void>) =>
    Promise.race([closed.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 300))]);

  it('holds a bounded number of unauthenticated connections per address, and an authenticated one stops counting', async () => {
    const port = await start({ transports: lan(), pendingConnections: { max: 8, perPeer: 2 } });
    expect(server?.addresses.map((address) => address.host)).toContain(host);
    const first = await raw(port);
    const second = await raw(port);
    const refused = await raw(port);
    await refused.closed;
    expect(await stillOpen(second.closed)).toBe(true);

    first.socket.destroy();
    await first.closed;
    const { token } = createPairingToken(Date.now(), capabilitiesFor(false));
    const phone = await noiseConnect(`ws://${host}:${port}`, { secret: token });
    expect(await phone.request('hello', { client: CLIENT })).toHaveProperty('result.device');
    const third = await raw(port);
    expect(await stillOpen(third.closed)).toBe(true);
    const over = await raw(port);
    await over.closed;
    phone.socket.close();
  });

  it('closes a connection that sends no request in time', async () => {
    const port = await start({ transports: lan(), headersTimeoutMs: 200 });
    const silent = await raw(port);
    await expect(silent.closed).resolves.toBeUndefined();
  });

  it('refuses a key it has no record for, and tells a peer only its version', async () => {
    const port = await start({ transports: lan() });
    const stranger = await noiseConnect(`ws://${host}:${port}`);
    expect(await stranger.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
    const peer = await fetch(`http://${host}:${port}/health`);
    expect(await peer.json()).toEqual({ version: '1.2.3' });
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({
      lan: { addresses: [host], port },
    });
  });
});

describe('upgradeFromWebPage', () => {
  it.each<[string, 'local' | 'proxied' | 'direct', Record<string, string>, boolean]>([
    ['Desktop or the CLI on loopback', 'local', { host: '127.0.0.1:7787' }, false],
    ['a simulator app on loopback', 'local', { host: '127.0.0.1:7787', origin: 'http://127.0.0.1:7787' }, false],
    ['an app on localhost', 'local', { host: 'localhost:7787', origin: 'http://localhost:7787' }, false],
    ['an app on IPv6 loopback', 'local', { host: '[::1]:7787', origin: 'http://[::1]:7787' }, false],
    ['a cross-site page on loopback', 'local', { host: '127.0.0.1:7787', origin: 'https://attacker.example' }, true],
    ['a page on another local port', 'local', { host: '127.0.0.1:7787', origin: 'http://127.0.0.1:8081' }, true],
    ['a DNS-rebound page', 'local', { host: 'attacker.example:7787', origin: 'http://attacker.example:7787' }, true],
    ['an https origin on loopback', 'local', { host: '127.0.0.1:7787', origin: 'https://127.0.0.1:7787' }, true],
    ['an opaque origin', 'local', { host: '127.0.0.1:7787', origin: 'null' }, true],
    ['an origin without a host', 'local', { origin: 'http://127.0.0.1:7787' }, true],
    ['a loopback browser fetch', 'local', { host: '127.0.0.1:7787', 'sec-fetch-site': 'same-origin' }, true],
    ['the CLI over the tailnet', 'proxied', { host: 'mac.tail.ts.net:7443' }, false],
    [
      'a phone over the tailnet',
      'proxied',
      { host: 'mac.tail.ts.net:7443', origin: 'https://mac.tail.ts.net:7443' },
      false,
    ],
    ['an iOS phone on port 443', 'proxied', { host: 'mac.tail.ts.net:443', origin: 'https://mac.tail.ts.net' }, false],
    [
      'an Android phone on port 443',
      'proxied',
      { host: 'mac.tail.ts.net', origin: 'https://mac.tail.ts.net:443' },
      false,
    ],
    ['a phone on an IPv6 address', 'proxied', { host: '[fd7a::1]:7443', origin: 'https://[fd7a::1]:7443' }, false],
    [
      'a page on another tailnet host',
      'proxied',
      { host: 'mac.tail.ts.net:7443', origin: 'https://evil.example' },
      true,
    ],
    ['a page on another IPv6 host', 'proxied', { host: '[fd7a::1]:7443', origin: 'https://[fd7a::2]:7443' }, true],
    ['a page on another port', 'proxied', { host: 'mac.tail.ts.net:7443', origin: 'https://mac.tail.ts.net' }, true],
    ['an http origin over the tailnet', 'proxied', { host: '100.64.0.1:7787', origin: 'http://100.64.0.1:7787' }, true],
    [
      'a same-origin browser fetch over the tailnet',
      'proxied',
      { host: 'mac.tail.ts.net:7443', origin: 'https://mac.tail.ts.net:7443', 'sec-fetch-site': 'same-origin' },
      true,
    ],
    ['the CLI on a local network address', 'direct', { host: '10.0.0.92:7787' }, false],
    [
      'a phone on a local network address',
      'direct',
      { host: '10.0.0.92:7787', origin: 'http://10.0.0.92:7787' },
      false,
    ],
    [
      'a DNS-rebound page on a local network address',
      'direct',
      { host: 'attacker.example:7787', origin: 'http://attacker.example:7787' },
      true,
    ],
    [
      'a page on another local network host',
      'direct',
      { host: '10.0.0.92:7787', origin: 'http://10.0.0.5:7787' },
      true,
    ],
    [
      'an https origin on a local network address',
      'direct',
      { host: '10.0.0.92:7787', origin: 'https://10.0.0.92:7787' },
      true,
    ],
  ])('%s', (_name, via, headers, refused) => {
    expect(upgradeFromWebPage(headers, via)).toBe(refused);
  });
});

describe('a client that leaves during the handshake', () => {
  test.skipIf(!fakeTailscale)('keeps the pairing token and starts no status child', async () => {
    const port = await start({ whoisDelayMs: 300 });
    const { token } = createPairingToken();
    const leaving = await connect(port, '100.64.0.2', { secret: token });
    leaving.socket.send(JSON.stringify({ id: 1, method: 'hello', params: { client: CLIENT } }));
    leaving.socket.send(JSON.stringify({ id: 2, method: 'status.subscribe' }));
    leaving.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(readDevices()).toEqual([]);
    expect(readdirSync(root)).not.toContain('pids');
    const retry = await connect(port, '100.64.0.2', { secret: token });
    expect(await retry.request('hello', { client: CLIENT })).toHaveProperty('result.device.id');
  });
});

describe('status.subscribe', () => {
  it('shares one status watch across subscribers and stops it with the last one', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const first = await returning(port, keyPair);
    expect(await first.request('status.subscribe')).toEqual({ id: 2, result: { subscription: 's1' } });
    expect(await first.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[0] });
    expect(await first.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[1] });

    await until(() => statusWorkers().length === 1);

    const second = await returning(port, keyPair);
    await second.request('status.subscribe');
    expect(await second.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[1] });
    expect(await second.request('status.subscribe')).toMatchObject({ result: { subscription: 's2' } });
    expect(await second.next()).toEqual({ event: 'status', subscription: 's2', payload: PAYLOADS[1] });
    expect(statusWorkers()).toHaveLength(1);

    expect(await first.request('unsubscribe', { subscription: 's1' })).toEqual({ id: 3, result: {} });
    expect(await first.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(statusWorkers()).toHaveLength(1);

    second.socket.close();
    await until(() => statusWorkers().length === 0, 1000);
    expect(stimCalls().map((call) => call.args)).toContain('status-worker stop');
  });

  it('starts the status watch when the server becomes ready, before any subscriber, and keeps it', async () => {
    const port = await start({ statusAtBoot: true });
    await until(() => statusWorkers().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const client = await authed(port);
    await client.request('status.subscribe');
    expect(await client.next()).toEqual({ event: 'status', subscription: 's1', payload: PAYLOADS[1] });
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(statusWorkers()).toHaveLength(1);
  });

  it('stops the status watch when the server closes', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    await client.request('status.subscribe');
    await client.next();
    await until(() => statusWorkers().length === 1);

    await server!.close();
    server = null;
    await until(() => statusWorkers().length === 0, 1000);
    expect(statusWorkers()).toEqual([]);
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
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
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

  it('ends the subscription with an error event when the status watch exits', async () => {
    const port = await start({ exit: true });
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    await client.request('status.subscribe');
    await client.next();
    await client.next();
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'status-failed', message: 'the status worker exited (code 3)' },
    });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });
});

describe('status views', () => {
  const machine = { capacity: { live: 0 }, deviceLeases: [], simctlAvailable: true, machine: null };
  const app = (overrides: Record<string, unknown> = {}) => ({
    path: '/work/app',
    live: true,
    warnings: [],
    issues: [],
    memoryMb: 0,
    logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 0 },
    ...overrides,
  });
  const other = { path: '/work/other', live: false, warnings: [], issues: [], memoryMb: 0 };
  const archive = (id: string, removedAt: string) => ({
    id,
    projectRoot: `/work/${id}`,
    project: id,
    workspace: `${id}--0`,
    worktree: {},
    removedAt,
    removedBy: 'gc',
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs: 0, recordings: 0, agentActions: 0, record: 1, total: 1 },
    expires: {},
    version: 1,
  });
  const archived = [
    archive('a', '2026-10-01T00:00:00.000Z'),
    archive('b', '2026-10-03T00:00:00.000Z'),
    archive('c', '2026-10-02T00:00:00.000Z'),
  ];
  const payload = (environments: unknown[], extra: Record<string, unknown> = {}) => ({
    ...machine,
    environments,
    unprovisionedWorktrees: [{ path: '/work/loose', branch: 'loose', repository: '/work', git: null }],
    archived,
    archivedUsage: { count: 3, bytes: 3, byKind: { logs: 0, recordings: 0, agentActions: 0, record: 3 } },
    ...extra,
  });
  const sequence = [
    payload([app(), other]),
    payload([app({ logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 2 } }), other]),
    payload([app({ logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 2 } })]),
    payload([app({ logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 2 } })]),
  ];
  const startViews = () => start({ env: { FAKE_STIM_PAYLOADS: JSON.stringify(sequence) } });

  it('sends the workspace list once, then only the workspaces that changed or went away', async () => {
    const client = await authed(await startViews());
    expect(await client.request('workspaces.subscribe')).toMatchObject({ result: { subscription: 's1' } });
    const first = (await client.next()) as WorkspacesEvent;
    expect(first).toMatchObject({ event: 'workspaces', subscription: 's1', seq: 0 });
    const snapshot = first.snapshot;
    assert(snapshot);
    expect(snapshot.workspaces.map((summary) => summary.path)).toEqual(['/work/app', '/work/other']);
    expect(snapshot.workspaces[0]?.logs).toEqual({ errorsSinceMarker: 0 });
    expect(snapshot.worktrees).toEqual([{ path: '/work/loose', branch: 'loose', repository: '/work', git: null }]);
    expect(snapshot.archived).toEqual({
      count: 3,
      bytes: 3,
      newest: ['b', 'c', 'a'].map((id) => ({
        id,
        projectRoot: `/work/${id}`,
        project: id,
        workspace: `${id}--0`,
        removedAt: archived.find((each) => each.id === id)?.removedAt,
      })),
    });
    expect(await client.next()).toEqual({
      event: 'workspaces',
      subscription: 's1',
      seq: 1,
      workspaces: {
        upsert: [expect.objectContaining({ path: '/work/app', logs: { errorsSinceMarker: 2 } })],
        remove: [],
      },
    });
    expect(await client.next()).toEqual({
      event: 'workspaces',
      subscription: 's1',
      seq: 2,
      workspaces: { upsert: [], remove: ['/work/other'] },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
  });

  it('sends one workspace whole, again only when it changes, and null once it is gone', async () => {
    const client = await authed(await startViews());
    await client.request('workspace.subscribe', { workspace: '/work/other' });
    expect(await client.next()).toEqual({ event: 'workspace', subscription: 's1', seq: 0, environment: other });
    expect(await client.next()).toEqual({ event: 'workspace', subscription: 's1', seq: 1, environment: null });
    expect(await client.request('workspace.subscribe', {})).toMatchObject({ error: { code: 'bad-request' } });
  });

  it('sends the machine view without the workspaces', async () => {
    const client = await authed(await startViews());
    await client.request('machine.subscribe');
    expect(await client.next()).toEqual({
      event: 'machine',
      subscription: 's1',
      seq: 0,
      machine: { ...machine, maintenance: null },
    });
  });

  it('reads build history, archives a page at a time, worktrees and maintenance on request', async () => {
    const builds = { ios: [{ platform: 'ios', status: 'ok', startedAt: '2026-10-01T00:00:00.000Z' }] };
    const port = await start({
      env: { FAKE_STIM_PAYLOADS: JSON.stringify([payload([app({ builds })], { maintenance: { mode: 'off' } })]) },
    });
    const client = await authed(port);
    expect(await client.request('builds.history', { workspace: '/work/app' })).toMatchObject({ result: { builds } });
    expect(await client.request('builds.history', { workspace: '/work/nope' })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    const first = (await client.request('archived.list', { limit: 2 })) as { result: ArchivedListResult };
    expect(first.result.archived.map((each) => each.id)).toEqual(['b', 'c']);
    expect(first.result.usage).toMatchObject({ count: 3 });
    const second = (await client.request('archived.list', { limit: 2, before: first.result.next })) as {
      result: ArchivedListResult;
    };
    expect(second.result.archived.map((each) => each.id)).toEqual(['a']);
    expect(second.result.next).toBeNull();
    expect(await client.request('worktrees.list')).toMatchObject({
      result: { worktrees: [{ path: '/work/loose', git: null }] },
    });
    expect(await client.request('maintenance.get')).toMatchObject({ result: { maintenance: { mode: 'off' } } });
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

  it('stores the registration with the pairing and keeps the status watch until it is removed', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    expect(await client.request('push.register', PUSH)).toEqual({ id: 2, result: {} });
    expect(readDevices()[0]!.push).toMatchObject(PUSH);
    await until(() => statusWorkers().length === 1);

    client.socket.close();
    await client.closed;
    expect(statusWorkers()).toHaveLength(1);

    const again = await returning(port, keyPair);
    expect(await again.request('push.unregister')).toEqual({ id: 2, result: {} });
    expect(readDevices().every((device) => !device.push)).toBe(true);
    await until(() => statusWorkers().length === 0, 1000);
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
    await until(() => statusWorkers().length === 1);
    revokeDevice(readDevices()[0]!.id);
    expect(readDevices()).toEqual([]);
    await until(() => statusWorkers().length === 0, 1000);
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

describe('workspace diff reads', () => {
  it('serves a registered worktree to a read-only paired phone without exposing another directory', async () => {
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, 'new.txt'), 'new text\n');
    const client = await authed(await start());
    expect(await client.request('workspace.files', { workspace, group: 'untracked' })).toMatchObject({
      result: { files: [{ path: 'new.txt', untracked: true }], truncated: false },
    });
    expect(await client.request('workspace.diff', { workspace, path: 'new.txt' })).toMatchObject({
      result: { path: 'new.txt', patches: [{ section: 'untracked', kind: 'text', text: 'new text\n' }] },
    });
    expect(await client.request('workspace.files', { workspace: root, group: 'changed' })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(await client.request('workspace.diff', { workspace, path: '../secret' })).toMatchObject({
      error: { code: 'stim-failed' },
    });
    expect(await client.request('workspace.files', { workspace })).toMatchObject({ error: { code: 'bad-request' } });
    expect(await client.request('workspace.diff', { workspace, path: 'new.txt', command: 'add' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('refuses a connection that has no read grant before any diff read', async () => {
    const client = await connect(await start(), undefined, {
      secret: createPairingToken(Date.now(), ['control']).token,
    });
    await client.request('hello', { client: CLIENT });
    expect(await client.request('workspace.files', { workspace, group: 'changed' })).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});

function liveLogFixture(logged: unknown[] = RECORDS): string {
  const dir = join(workspaceStateDir(workspace), 'logs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'client.ndjson');
  writeFileSync(path, logged.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

describe('logs.query', () => {
  it('reads the workspace in process with the Desktop viewer filters', async () => {
    liveLogFixture([
      { ts: 1, src: 'device', marker: true, platform: 'ios', slot: 'tablet' },
      { ts: 2, src: 'metro', level: 'error', msg: '-render failure' },
      { ts: 3, src: 'client', level: 'warn', msg: '-render warning' },
      { ts: 4, src: 'client', level: 'error', msg: '-render error', slot: 'tablet' },
    ]);
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
    expect(reply).toEqual({
      id: 2,
      result: {
        records: [
          { ts: 2, src: 'metro', level: 'error', msg: '-render failure' },
          { ts: 4, src: 'client', level: 'error', msg: '-render error', slot: 'tablet' },
        ],
      },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
  });

  it('refuses an unregistered workspace and invalid filters without running stim', async () => {
    liveLogFixture();
    const port = await start();
    const client = await authed(port);
    const other = join(root, 'other');
    mkdirSync(other);
    if (process.platform === 'win32')
      writeFileSync(join(root, 'tailscale.cmd'), `@"${process.execPath}" "%~dp0tailscale" %*\r\n`);
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
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
  });
});

function archiveFixture(logged: unknown[] = []): { id: string; dir: string } {
  const removedAt = '2026-10-01T12:00:00Z';
  const id = `${workspaceName(workspace)}--${Date.parse(removedAt)}`;
  const dir = archiveDir(id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const archive: ArchivedWorkspace = {
    id,
    projectRoot: workspace,
    project: 'app',
    workspace: workspaceName(workspace),
    worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
    removedAt,
    removedBy: 'worktree-remove',
    lastUsedAt: null,
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs: 0, recordings: 0, agentActions: 0, record: 0, total: 0 },
    expires: { logs: null, recordings: null, agentActions: null, record: null },
    version: 1,
  };
  writeFileSync(join(dir, 'archive.json'), JSON.stringify(archive));
  writeFileSync(join(dir, 'logs', 'client.ndjson'), logged.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { id, dir };
}

function archivedFootage(dir: string, first: number, count: number, platform: 'ios' | 'android' = 'ios'): void {
  const device = join(dir, 'recordings', recordingDeviceName(platform, 'default'));
  mkdirSync(device, { recursive: true });
  const units = Array.from({ length: count }, (_, i) => {
    const header = Buffer.alloc(17);
    header.writeUInt32BE(18, 0);
    header.writeUInt8(i % 5 === 0 ? 1 : 0, 4);
    header.writeDoubleBE(first + i * 100, 5);
    header.writeUInt16BE(330, 13);
    header.writeUInt16BE(720, 15);
    return Buffer.concat([header, Buffer.from([0, 0, 0, 1, i])]);
  });
  writeFileSync(join(device, closedSegmentName(first, first + (count - 1) * 100)), Buffer.concat(units));
}

describe('archive.detail', () => {
  it('returns the archive build history in live shape and closed spans for every recording slot', async () => {
    const { id, dir } = archiveFixture();
    const startedAt = '2026-10-01T11:00:00Z';
    const common = {
      startedAt,
      cacheSkipped: false,
      fingerprint: 'native-key',
      slot: 'default',
      configuration: 'Debug',
      cacheKey: 'native-key',
    };
    const failed = {
      ...common,
      platform: 'ios',
      status: 'failed',
      result: 'failed',
      cacheHit: false,
      durationMs: 5000,
      phases: { prepare: 1000, compile: 4000 },
      errorCode: 'STIM_BUILD_FAILED',
      diagnostics: [{ file: 'App.swift', line: 12, column: 3, message: 'Missing symbol' }],
    };
    const succeeded = {
      ...common,
      platform: 'android',
      status: 'ok',
      result: 'succeeded',
      cacheHit: 'remote',
      slot: 'fold',
      configuration: 'debug',
      durationMs: 3000,
      phases: { 'cache-lookup': 1000, install: 2000 },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ buildHistory: { ios: [failed], android: [succeeded] } }));
    mkdirSync(workspaceStateDir(workspace), { recursive: true });
    writeFileSync(join(workspaceStateDir(workspace), 'state.json'), JSON.stringify({ buildHistory: {} }));
    const recordings = join(dir, 'recordings');
    for (const [device, segments] of Object.entries({
      'ios-default': ['1000-2000.seg', '2200-3000.seg', '6000-7000.seg', '8000.part'],
      'ios-tablet': ['4000-5000.seg'],
      'android-fold': ['10000-11000.seg'],
      'web-desktop': ['12000-13000.seg'],
      'android-empty': ['14000.part'],
    })) {
      mkdirSync(join(recordings, device), { recursive: true });
      for (const segment of segments) writeFileSync(join(recordings, device, segment), 'listing only');
    }
    symlinkSync(join(recordings, 'ios-default'), join(recordings, 'ios-link'), 'dir');
    symlinkSync(join(recordings, 'ios-default', '1000-2000.seg'), join(recordings, 'ios-default', '15000-16000.seg'));
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    const expected = {
      builds: {
        ios: [{ ...failed, finishedAt: '2026-10-01T11:00:05.000Z' }],
        android: [{ ...succeeded, finishedAt: '2026-10-01T11:00:03.000Z' }],
      },
      recordings: [
        { platform: 'android', slot: 'fold', spans: [{ start: 10000, end: 11000 }] },
        {
          platform: 'ios',
          slot: 'default',
          spans: [
            { start: 1000, end: 3000 },
            { start: 6000, end: 7000 },
          ],
        },
        { platform: 'ios', slot: 'tablet', spans: [{ start: 4000, end: 5000 }] },
        { platform: 'web', slot: 'desktop', spans: [{ start: 12000, end: 13000 }] },
      ],
    };
    const reply = await client.request('archive.detail', { archive: id });
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const detail = reply.result as ArchiveDetailResult;
    expect({
      ...detail,
      recordings: detail.recordings.toSorted((a, b) =>
        `${a.platform}-${a.slot}`.localeCompare(`${b.platform}-${b.slot}`),
      ),
    }).toEqual(expected);
    expect(stimCalls()).toEqual([]);
    rmSync(recordings, { recursive: true });
    symlinkSync(root, recordings, 'dir');
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({ result: { recordings: [] } });
  });

  it('refuses unknown archives and symlinked archive paths with unknown-workspace', async () => {
    const { id, dir } = archiveFixture();
    symlinkSync(dir, archiveDir('linked'), 'dir');
    const client = await authed(await start());
    for (const archive of ['missing', 'linked']) {
      expect(await client.request('archive.detail', { archive })).toMatchObject({
        error: { code: 'unknown-workspace' },
      });
    }
    const record = join(dir, 'archive.json');
    cpSync(record, join(root, 'archive.json'));
    rmSync(record);
    symlinkSync(join(root, 'archive.json'), record);
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    for (const params of [
      {},
      { workspace },
      { workspace, archive: id },
      { archive: '../outside' },
      { archive: '' },
      { archive: 1 },
    ]) {
      expect(await client.request('archive.detail', params)).toMatchObject({ error: { code: 'bad-request' } });
    }
  });

  it('returns empty builds when archived state is missing or unreadable', async () => {
    const { id, dir } = archiveFixture();
    const client = await authed(await start());
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({
      result: { builds: {}, recordings: [] },
    });
    for (const state of [
      'not json',
      JSON.stringify({ lastBuild: { platform: 'ios' } }),
      JSON.stringify({ buildHistory: {} }),
    ]) {
      writeFileSync(join(dir, 'state.json'), state);
      expect(await client.request('archive.detail', { archive: id })).toMatchObject({
        result: { builds: {}, recordings: [] },
      });
    }
    rmSync(join(dir, 'state.json'));
    writeFileSync(
      join(root, 'state.json'),
      JSON.stringify({ buildHistory: { ios: [{ platform: 'ios', status: 'ok', startedAt: '2026-10-01T11:00:00Z' }] } }),
    );
    symlinkSync(join(root, 'state.json'), join(dir, 'state.json'));
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({
      result: { builds: {}, recordings: [] },
    });
  });
});

describe('archived reads', () => {
  it('merges archived agent-device sessions into queries, subscriptions and replay markers', async () => {
    const { id, dir } = archiveFixture();
    cpSync(
      join(import.meta.dirname, '../../stim-cli/src/__tests__/fixtures/agent-device/sessions'),
      join(dir, 'agent-device', 'sessions'),
      { recursive: true },
    );
    const base = Date.parse('2026-09-25T12:12:00Z');
    archivedFootage(dir, base, 10);
    archivedFootage(dir, Date.parse('2026-09-13T01:56:00Z'), 10, 'android');
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    const queried = await client.request('logs.query', { archive: id, sources: ['agent'] });
    expect(queried).toMatchObject({
      result: {
        records: expect.arrayContaining([
          {
            ts: Date.parse('2026-09-25T12:16:03.448Z'),
            startedAt: Date.parse('2026-09-25T12:15:57.453Z'),
            src: 'agent',
            level: 'info',
            event: 'agent_action',
            session: 'cwd:b764dacffe51e890:default',
            platform: 'ios',
            deviceId: 'AD45387C-599D-4EDB-A62B-18176FF3A2A7',
            command: 'press',
            msg: 'Tapped (201, 542)',
            details: {
              command: 'press',
              positionals: ['<arg>'],
              targetLabel: '(201, 542)',
              selectorChainLength: 2,
              x: 201,
              y: 542,
            },
          },
          expect.objectContaining({ platform: 'android', event: 'agent_failed', msg: 'Failed open: DEVICE_NOT_FOUND' }),
        ]),
      },
    });
    expect(await client.request('logs.query', { archive: id })).toMatchObject({
      result: (queried as { result: unknown }).result,
    });
    await client.request('logs.subscribe', { archive: id, sources: ['agent'] });
    expect(await client.next()).toMatchObject({ event: 'logs', ...(queried as { result: object }).result });
    expect(await client.next()).toMatchObject({ event: 'logs-ended' });
    expect(await client.request('replay.range', { archive: id, platform: 'ios' })).toMatchObject({
      result: {
        markers: expect.arrayContaining([
          { at: Date.parse('2026-09-25T12:15:57.453Z'), kind: 'action', command: 'press', label: 'Tapped (201, 542)' },
          {
            at: Date.parse('2026-09-25T12:16:03.541Z'),
            kind: 'action',
            command: 'press',
            label: 'Failed press: COMMAND_FAILED',
          },
        ]),
      },
    });
    expect(await client.request('replay.range', { archive: id, platform: 'android' })).toMatchObject({
      result: {
        markers: expect.arrayContaining([
          {
            at: Date.parse('2026-09-13T01:56:45.575Z'),
            kind: 'action',
            command: 'open',
            label: 'Failed open: DEVICE_NOT_FOUND',
          },
          { at: Date.parse('2026-09-13T01:58:25.718Z'), kind: 'action', command: 'press', label: 'Tapped (541, 2265)' },
        ]),
      },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('bounds pending archive reads and releases their request slots', async () => {
    const { id, dir } = archiveFixture();
    archivedFootage(dir, 1000, 10);
    const client = await authed(await start());
    const params = { archive: id, platform: 'ios', at: 1000, video: ['h264'] };
    const methods = [
      'logs.query',
      'logs.subscribe',
      'replay.range',
      'archive.detail',
      'replay.keyframe',
      'frames.subscribe',
    ];
    const replies = await Promise.all(
      Array.from({ length: 120 }, (_, index) => client.request(methods[index % methods.length]!, params)),
    );
    const refused = replies.filter((reply) => 'error' in reply);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused).toSatisfy((all: unknown[]) =>
      all.every(
        (reply) =>
          (reply as { error: { code: string } }).error.code === 'limit-exceeded' &&
          (reply as { error: { message: string } }).error.message === 'A connection can run 32 requests at a time.',
      ),
    );
    expect(await client.request('frames.subscribe', params)).toMatchObject({ result: { video: 'h264' } });
    expect(await client.request('logs.query', { archive: id })).toMatchObject({ result: { records: [] } });
  });

  it('queries real archived logs with the same JSON filters and context as the CLI', async () => {
    const { id, dir } = archiveFixture([
      { ts: 2, src: 'client', level: 'error', msg: 'previous error' },
      { ts: 5, src: 'build', level: 'info', marker: true, platform: 'ios', slot: 'tablet', msg: 'launched' },
      { ts: 8, src: 'client', level: 'error', msg: 'current error' },
      { ts: 9, src: 'device', level: 'fatal', event: 'native_crash', platform: 'ios', slot: 'tablet', msg: 'crash' },
      { ts: 11, src: 'agent', level: 'info', platform: 'ios', slot: 'tablet', event: 'agent_action', msg: 'press' },
    ]);
    writeFileSync(
      join(dir, 'logs', 'metro.ndjson.1'),
      JSON.stringify({ ts: 1, src: 'metro', level: 'warn', msg: 'rotated' }) + '\n',
    );
    writeFileSync(
      join(dir, 'logs', 'metro.ndjson'),
      [
        { ts: 6, src: 'metro', level: 'info', marker: true, msg: 'iOS Bundled' },
        { ts: 7, src: 'metro', level: 'error', raw: true, event: 'metro_stderr', msg: 'Unable to resolve module' },
        { ts: 10, src: 'metro', level: 'info', raw: true, event: 'metro_stderr', msg: 'Code: app.ts' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    const liveLogs = join(workspaceStateDir(workspace), 'logs');
    cpSync(join(dir, 'logs'), liveLogs, { recursive: true });
    const cli = new URL('../../stim-cli/dist/cli.mjs', import.meta.url);
    const cases = [
      { filter: {}, args: [] },
      {
        filter: { sources: ['metro'], level: 'warn', grep: 'rotated|resolve', tail: 2 },
        args: ['--source=metro', '--level=warn', '--grep=rotated|resolve', '--tail=2'],
      },
      { filter: { errors: true, tail: 3 }, args: ['--errors', '--tail=3'] },
      { filter: { slot: 'tablet', errors: true }, args: ['--slot=tablet', '--errors'] },
      { filter: { sources: ['agent'], slot: 'tablet' }, args: ['--source=agent', '--slot=tablet'] },
    ];
    const client = await authed(await start());
    const queried: unknown[][] = [];
    for (const { filter, args } of cases) {
      const expected = execFileSync(process.execPath, [fileURLToPath(cli), 'logs', '--json', '--tail=5000', ...args], {
        cwd: workspace,
        env: { ...process.env, STIM_MAINTENANCE: 'off' },
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(await client.request('logs.query', { archive: id, ...filter })).toMatchObject({
        result: { records: expected },
      });
      queried.push(expected);
    }
    expect(queried[2]).toContainEqual(expect.objectContaining({ context: ['Code: app.ts'] }));
    expect(queried[3]).toContainEqual(expect.objectContaining({ context: ['Code: app.ts'] }));
    rmSync(workspace, { recursive: true });
    writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ projects: {} }));
    expect(await client.request('logs.query', { archive: id, sources: ['agent'] })).toMatchObject({
      result: { records: [expect.objectContaining({ msg: 'press' })] },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('batches archived records, ends once, and releases even empty subscriptions', async () => {
    const logged = Array.from({ length: 501 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: `record ${ts}` }));
    const { id, dir } = archiveFixture(logged);
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    expect(await client.request('logs.subscribe', { archive: id })).toMatchObject({ result: { subscription: 's1' } });
    expect(await client.next()).toEqual({ event: 'logs', subscription: 's1', records: logged.slice(0, 500) });
    expect(await client.next()).toEqual({ event: 'logs', subscription: 's1', records: logged.slice(500) });
    expect(await client.next()).toEqual({ event: 'logs-ended', subscription: 's1' });
    for (let i = 1; i < 33; i++) {
      const subscription = `s${i + 1}`;
      expect(await client.request('logs.subscribe', { archive: id, grep: 'absent' })).toMatchObject({
        result: { subscription },
      });
      expect(await client.next()).toEqual({ event: 'logs-ended', subscription });
    }
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(readdirSync(join(dir, 'logs'))).toEqual(['client.ndjson']);
    expect(stimCalls()).toEqual([]);
  });

  it('reports overflow instead of successful completion', async () => {
    const { id } = archiveFixture(
      Array.from({ length: 3 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'record' })),
    );
    const client = await authed(await start({ logLimits: { maxPendingRecords: 2 } }));
    await client.request('logs.subscribe', { archive: id });
    expect(await client.next()).toMatchObject({ event: 'error', subscription: 's1', error: { code: 'slow-client' } });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });

  it('rejects ambiguous targets, traversal, unknown archives, symlinks and malformed records', async () => {
    const { id, dir } = archiveFixture();
    const link = `${id}-link`;
    symlinkSync(dir, archiveDir(link), 'dir');
    mkdirSync(archiveDir('broken'));
    writeFileSync(join(archiveDir('broken'), 'archive.json'), '{}');
    const client = await authed(await start());
    for (const method of ['logs.query', 'logs.subscribe', 'replay.range', 'replay.keyframe', 'frames.subscribe']) {
      const rest = { platform: 'ios', at: 1, video: ['h264'] };
      for (const target of [
        {},
        { workspace, archive: id },
        { archive: '../outside' },
        { archive: 'a/b' },
        { archive: 'a\\b' },
        { archive: '..' },
        { archive: '' },
        { archive: 1 },
        { archive: 'a\0b' },
      ]) {
        expect(await client.request(method, { ...rest, ...target })).toMatchObject({ error: { code: 'bad-request' } });
      }
      for (const archive of ['missing', link, 'broken']) {
        expect(await client.request(method, { ...rest, archive })).toMatchObject({
          error: { code: 'unknown-workspace', message: expect.stringContaining(archive) },
        });
      }
    }
    expect(stimCalls()).toEqual([]);
  });

  it('serves spans, markers and keyframes from archives without touching a replacement workspace', async () => {
    const base = Date.now() - 60_000;
    const { id, dir } = archiveFixture([
      {
        ts: base + 300,
        startedAt: base + 200,
        src: 'agent',
        level: 'info',
        event: 'agent_action',
        platform: 'ios',
        command: 'press',
        msg: 'press @e3',
      },
      {
        ts: base + 400,
        src: 'agent',
        level: 'info',
        event: 'agent_action',
        platform: 'android',
        command: 'press',
        msg: 'other',
      },
      { ts: base + 30_500, src: 'build', level: 'error', msg: 'Compile failed' },
    ]);
    archivedFootage(dir, base, 10);
    archivedFootage(dir, base + 30_000, 10);
    const client = await authed(await start());
    expect(await client.request('replay.range', { archive: id, platform: 'ios' })).toMatchObject({
      result: {
        enabled: false,
        recording: false,
        spans: [
          { start: base, end: base + 900 },
          { start: base + 30_000, end: base + 30_900 },
        ],
        markers: [
          { at: base + 200, kind: 'action', command: 'press', label: 'press @e3' },
          { at: base + 30_500, kind: 'error', label: 'Compile failed' },
        ],
      },
    });
    rmSync(workspace, { recursive: true });
    expect(await client.request('replay.keyframe', { archive: id, platform: 'ios', at: base + 850 })).toMatchObject({
      result: {
        start: base,
        end: base + 900,
        at: base,
        width: 330,
        height: 720,
        data: Buffer.from([0, 0, 0, 1, 0]).toString('base64'),
      },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('replays and seeks archived frames locally and refuses live and physical subscriptions', async () => {
    const base = Date.now() - 60_000;
    const { id, dir } = archiveFixture();
    archivedFootage(dir, base, 10);
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    const target = { archive: id, platform: 'ios', video: ['h264'] };
    expect(await client.request('frames.subscribe', target)).toMatchObject({ error: { code: 'bad-request' } });
    expect(await client.request('frames.subscribe', { ...target, at: base, physical: true })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(await client.request('frames.subscribe', { ...target, at: base + 230 })).toMatchObject({
      result: { subscription: 's1', video: 'h264' },
    });
    const capturedAt = async () => {
      const message = await client.next();
      expect(message).toHaveProperty('binary');
      return (message as unknown as { binary: Buffer }).binary.readDoubleBE(8);
    };
    expect(await capturedAt()).toBe(base);
    expect(await capturedAt()).toBe(base + 100);
    expect(await capturedAt()).toBe(base + 200);
    expect(await client.request('frames.seek', { subscription: 's1', at: base + 730, rate: 0 })).toMatchObject({
      result: { at: base + 700 },
    });
    expect(await capturedAt()).toBe(base + 500);
    expect(await capturedAt()).toBe(base + 600);
    expect(await capturedAt()).toBe(base + 700);
    expect(await client.request('frames.live', { subscription: 's1' })).toMatchObject({
      error: { code: 'frames-failed', message: expect.stringContaining(id) },
    });
    expect(await client.request('frames.seek', { subscription: 's1', at: base + 900, rate: 2 })).toMatchObject({
      result: { at: base + 900 },
    });
    for (const offset of [500, 600, 700, 800, 900]) expect(await capturedAt()).toBe(base + offset);
    expect(await client.next()).toEqual({ event: 'replay-ended', subscription: 's1', at: base + 900 });
    expect(stimCalls()).toEqual([]);
  });

  it('returns empty ranges and no-recording for archives without closed footage', async () => {
    const { id, dir } = archiveFixture();
    const device = join(dir, 'recordings', recordingDeviceName('ios', 'default'));
    mkdirSync(device, { recursive: true });
    writeFileSync(join(device, '1000.part'), Buffer.alloc(17));
    const client = await authed(await start());
    expect(await client.request('replay.range', { archive: id, platform: 'ios' })).toMatchObject({
      result: { enabled: false, recording: false, spans: [], markers: [] },
    });
    expect(await client.request('replay.keyframe', { archive: id, platform: 'ios', at: 1000 })).toMatchObject({
      error: { code: 'no-recording' },
    });
    expect(
      await client.request('frames.subscribe', { archive: id, platform: 'ios', video: ['h264'], at: 1000 }),
    ).toMatchObject({ error: { code: 'no-recording' } });
    expect(existsSync(join(device, '1000.part'))).toBe(true);
    expect(stimCalls()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop build logs', () => {
  it('streams complete retained build output only to the proved Desktop without overflowing its pending limit', async () => {
    const retained = Array.from({ length: 6001 }, (_, index) => ({
      ts: Math.floor(index / 3) + 1,
      src: 'build',
      level: 'info',
      msg: `build-${index}`,
      ...(index % 2 ? { slot: 'second', platform: 'ios' } : {}),
    }));
    const path = liveLogFixture(retained);
    const port = await start({ logLimits: { maxBufferedBytes: 64 * 1024, maxPendingRecords: 200 } });
    const remote = await authed(port, true);
    expect(await remote.request('desktop.logs.subscribe', { workspace })).toMatchObject({
      error: { code: 'forbidden' },
    });
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    await plain.request('hello', { client: CLIENT });
    expect(await plain.request('desktop.logs.subscribe', { workspace })).toMatchObject({
      error: { code: 'forbidden' },
    });
    const client = await desktop();
    for (const extra of [{ tail: 1 }, { sources: ['unknown'] }, { slot: 'second' }, { archive: 'archive' }]) {
      expect(await client.request('desktop.logs.subscribe', { workspace, ...extra })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
    expect(await client.request('desktop.logs.subscribe', { workspace: root })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(await client.request('desktop.logs.subscribe', { workspace })).toMatchObject({
      result: { subscription: 's1' },
    });
    expect(await records(client, retained.length)).toEqual(retained);
    const next = { ts: 3000, src: 'build', level: 'info', msg: 'appended' };
    appendFileSync(path, JSON.stringify(next) + '\n');
    expect(await records(client, 1)).toEqual([next]);
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
    expect(childPids()).toEqual([]);
  });
});

describe('logs.subscribe', () => {
  it('backfills the requested tail and follows appends independently for each subscriber', async () => {
    const path = liveLogFixture();
    const port = await start();
    const first = await authed(port);
    expect(await first.request('logs.subscribe', { workspace, tail: 2 })).toEqual({
      id: 2,
      result: { subscription: 's1' },
    });
    expect(await records(first, 2)).toEqual(RECORDS.slice(1));
    const second = await authed(port);
    await second.request('logs.subscribe', { workspace, tail: 1 });
    expect(await records(second, 1)).toEqual(RECORDS.slice(2));
    const appended = { ts: 4, src: 'client', level: 'info', msg: 'new line' };
    appendFileSync(path, JSON.stringify(appended) + '\n');
    expect(await records(first, 1)).toEqual([appended]);
    expect(await records(second, 1)).toEqual([appended]);
    expect(await first.request('unsubscribe', { subscription: 's1' })).toEqual({ id: 3, result: {} });
    const later = { ts: 5, src: 'client', level: 'info', msg: 'after unsubscribe' };
    appendFileSync(path, JSON.stringify(later) + '\n');
    expect(await records(second, 1)).toEqual([later]);
    second.socket.close();
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
    expect(childPids()).toEqual([]);
  });

  it('times out an unfinished backfill and keeps another socket responsive', async () => {
    liveLogFixture(
      Array.from({ length: 100_000 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'x'.repeat(300) })),
    );
    const port = await start({ commandLimits: { timeoutMs: 5 } });
    const slow = await authed(port);
    const other = await authed(port);
    await slow.request('logs.subscribe', { workspace });
    expect(await other.request('hello', { client: CLIENT })).toHaveProperty('error.code', 'already-authenticated');
    expect(await slow.next()).toMatchObject({
      event: 'error',
      subscription: 's1',
      error: { code: 'logs-failed', message: expect.stringContaining('did not finish') },
    });
    expect(await slow.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });

  it('drops a backfill exceeding the pending limit and releases its subscription', async () => {
    liveLogFixture(Array.from({ length: 500 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'line' })));
    const port = await start({ logLimits: { maxBufferedBytes: 64 * 1024, maxPendingRecords: 200 } });
    const client = await authed(port);
    await client.request('logs.subscribe', { workspace });
    expect(await client.next()).toMatchObject({ event: 'error', subscription: 's1', error: { code: 'slow-client' } });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });

  it('stops an in-flight backfill when its last subscriber leaves or the server closes', async () => {
    liveLogFixture(Array.from({ length: 100_000 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'line' })));
    const port = await start();
    const client = await authed(port);
    await client.request('logs.subscribe', { workspace });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
    await client.request('logs.subscribe', { workspace });
    await server!.close();
    server = null;
    expect(childPids()).toEqual([]);
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
  beforeEach(() => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('shares the home stats read and gc dry run between read-only phones within a minute', async () => {
    const port = await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_MAINTENANCE: 'off',
      },
    });
    const first = await authed(port);
    const second = await authed(port);
    const expected = {
      gc: expect.objectContaining({ mode: 'dry-run', sections: expect.any(Object) }),
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
    ).toEqual([]);
  });

  it('answers immediately with pending remote machines, then reads them from doctor in the background', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    for (const project of [workspace, other]) writeFileSync(join(project, 'package.json'), '{"private":true}');
    const ran = (at: string) => ({ doctorRuns: { ios: { at, version: '1.0.0' } } });
    writeFileSync(
      join(process.env.STIM_HOME!, 'config.json'),
      JSON.stringify({
        remote: { machines: ['mini'] },
        projects: {
          [workspace]: ran('2026-09-28T10:00:00.000Z'),
          [other]: ran('2026-09-28T11:00:00.000Z'),
          [join(root, 'gone')]: ran('2026-09-28T12:00:00.000Z'),
        },
      }),
    );
    const port = await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_MAINTENANCE: 'off',
        FAKE_TAILSCALE_CWDS: join(root, 'doctor-cwds'),
      },
    });
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
        buildMachines: [{ machine: 'mini', state: 'tailscale-off' }],
        buildMachinesAt: expect.any(String),
      },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('doctor'))).toEqual([]);
    expect([...new Set(readFileSync(join(root, 'doctor-cwds'), 'utf8').trim().split('\n'))]).toEqual([other]);

    expect(await client.request('machine.details')).toMatchObject({
      result: { buildMachines: [{ machine: 'mini', state: 'tailscale-off' }] },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('doctor'))).toEqual([]);
  });

  it('keeps the stats when gc fails, and says why gc is missing', async () => {
    const port = await start({
      commandLimits: { maxOutputBytes: 1 },
      env: { HOME: root, USERPROFILE: root, STIM_MAINTENANCE: 'off' },
    });
    const client = await authed(port);
    expect(await client.request('machine.details')).toMatchObject({
      result: {
        gc: null,
        gcError: 'stim gc printed more than 1 bytes.',
        stats: { version: 1, machine: { ios: null, android: null } },
      },
    });
  });
});

describe.skipIf(process.platform !== 'darwin')('machine.get on macOS', () => {
  it("reports the machine's memory used below its total", async () => {
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('machine.get');
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const { memory } = reply.result as MachineUsage;
    expect(memory.usedBytes).toBeGreaterThan(0);
    expect(memory.usedBytes).toBeLessThan(memory.totalBytes);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop settings', () => {
  it('serves its settings registry schema only through the authenticated Desktop boundary', async () => {
    const port = await start();
    const remote = await authed(port);
    expect(await remote.request('desktop.settings.schema')).toHaveProperty('error.code', 'forbidden');
    const socket = server?.localSocket;
    assert(socket);
    const plain = await localConnect(socket);
    const hello = await plain.request('hello', { client: CLIENT });
    expect(hello).toMatchObject({ result: { features: expect.arrayContaining(['desktop-settings-schema']) } });
    expect(await plain.request('desktop.settings.schema')).toHaveProperty('error.code', 'forbidden');
    const client = await desktop();
    for (const params of [null, { cwd: workspace }]) {
      expect(await client.request('desktop.settings.schema', params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(await client.request('desktop.settings.schema')).toEqual({
      id: expect.any(Number),
      result: settingsJsonSchema(),
    });
    expect(await client.request('desktop.settings.schema', {})).toEqual({
      id: expect.any(Number),
      result: settingsJsonSchema(),
    });
    expect(stimCalls()).toEqual([]);
  });

  it('reads fresh masked settings for an unregistered selected folder only through the Desktop boundary', async () => {
    const selected = join(root, 'selected');
    mkdirSync(selected);
    writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }));
    const committed = join(selected, '.stim.json');
    writeFileSync(
      committed,
      JSON.stringify({ optimizations: { buildCache: false }, android: { keystorePassword: 'env:STIM_3484_SECRET' } }),
    );
    const config = join(root, 'home', 'config.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), archive: { maxCount: 7 } }));
    const port = await start({ env: { STIM_TMPDIR: join(root, 'fast') } });
    const before = readFileSync(config, 'utf8');
    const remote = await authed(port);
    expect(await remote.request('desktop.settings.get', { cwd: selected })).toHaveProperty('error.code', 'forbidden');
    expect(await remote.request('settings.get', { workspace: selected })).toHaveProperty(
      'error.code',
      'unknown-workspace',
    );
    const socket = server?.localSocket;
    assert(socket);
    const plain = await localConnect(socket);
    const hello = await plain.request('hello', { client: CLIENT });
    expect(hello).toMatchObject({ result: { features: expect.arrayContaining(['desktop-settings']) } });
    expect(await plain.request('desktop.settings.get', { cwd: selected })).toHaveProperty('error.code', 'forbidden');
    const client = await desktop();
    for (const params of [undefined, null, {}, { cwd: 'relative' }, { cwd: selected, workspace: selected }]) {
      expect(await client.request('desktop.settings.get', params)).toHaveProperty('error.code', 'bad-request');
    }
    const result = await client.request('desktop.settings.get', { cwd: selected });
    expect(result).toMatchObject({
      result: {
        project: selected,
        files: { machine: config, committed },
        settings: expect.arrayContaining([
          { key: 'optimizations.buildCache', value: false, origin: 'committed', layers: { committed: false } },
          {
            key: 'android.keystorePassword',
            value: '********',
            origin: 'committed',
            layers: { committed: '********' },
            sensitive: true,
          },
          expect.objectContaining({ key: 'tempDir', value: join(root, 'fast'), origin: 'env' }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain('STIM_3484_SECRET');
    writeFileSync(committed, JSON.stringify({ optimizations: { buildCache: true } }));
    expect(await client.request('desktop.settings.get', { cwd: selected })).toMatchObject({
      result: {
        settings: expect.arrayContaining([
          { key: 'optimizations.buildCache', value: true, origin: 'committed', layers: { committed: true } },
        ]),
      },
    });
    expect(await client.request('desktop.settings.get', { cwd: root })).toMatchObject({
      result: {
        project: null,
        settings: expect.arrayContaining([
          { key: 'archive.maxCount', value: 7, origin: 'machine', layers: { machine: 7 } },
        ]),
      },
    });
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(stimCalls()).toEqual([]);
  });
});

describe('stats.get and settings.get', () => {
  it('read stats and settings without running the CLI, settings in the home directory by default', async () => {
    const config = join(root, 'home', 'config.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), archive: { maxCount: 7 } }));
    const port = await start();
    const client = await authed(port);
    expect(await client.request('stats.get', { workspace })).toEqual({
      id: 2,
      result: readStatsReport(null, Date.now()).report,
    });
    expect(await client.request('settings.get')).toMatchObject({
      id: 3,
      result: {
        project: null,
        files: { machine: config },
        settings: expect.arrayContaining([
          { key: 'archive.maxCount', value: 7, origin: 'machine', layers: { machine: 7 } },
        ]),
      },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('reads settings with the server environment and reports a refusal with its code and remedy', async () => {
    const port = await start({ env: { STIM_BUDGET_MIN_FREE_DISK_GB: 'lots' } });
    const client = await authed(port);
    expect(await client.request('settings.get', { workspace })).toMatchObject({
      error: {
        code: 'stim-failed',
        message: expect.stringMatching(
          /^STIM_BAD_ARG: Invalid STIM_BUDGET_MIN_FREE_DISK_GB value "lots"\. Expected a number, 0 or more\. Fix the environment variable/,
        ),
      },
    });
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
    const port = await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_MAINTENANCE: 'off',
      },
    });
    rmSync(join(root, 'fake-stim.mjs'));
    const client = await authed(port);
    expect(await client.request('stats.get')).toMatchObject({ result: { version: 1 } });
    expect(await client.request('machine.details')).toMatchObject({
      result: {
        gc: expect.objectContaining({ mode: 'dry-run', sections: expect.any(Object) }),
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
      let pid = 0;
      await until(() => {
        if (!existsSync(ready)) return false;
        pid = Number(readFileSync(ready, 'utf8'));
        return Number.isSafeInteger(pid) && pid > 0;
      });
      await run.cancel();
      expect(alive(pid)).toBe(false);
    } finally {
      await run.cancel();
    }
  });

  function slowGit(): { env: Record<string, string>; processes: (command?: string) => number[] } {
    const bin = join(root, 'bin');
    const jobs = join(root, 'git-jobs');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const pending = path.join(process.env.STATS_GIT_JOBS, '..', 'git-' + process.pid);
fs.writeFileSync(pending, JSON.stringify(process.argv.slice(2)));
fs.renameSync(pending, path.join(process.env.STATS_GIT_JOBS, String(process.pid)));
require('node:net').createServer().listen(0, '127.0.0.1');
`;
    writeFileSync(join(bin, 'git'), script);
    chmodSync(join(bin, 'git'), 0o755);
    return {
      env: { PATH: bin + ':' + process.env.PATH, STATS_GIT_JOBS: jobs },
      processes: (command) =>
        readdirSync(jobs)
          .filter((pid) => !command || JSON.parse(readFileSync(join(jobs, pid), 'utf8')).includes(command))
          .map(Number),
    };
  }

  describe.skipIf(process.platform === 'win32')('plan cleanup', () => {
    test.each(['timeout', 'disconnect', 'shutdown'] as const)(
      'reaps real in-process plan Git children on %s while another socket stays responsive',
      async (mode) => {
        const slow = slowGit();
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
        const port = await start({ env: slow.env, commandLimits: { timeoutMs: mode === 'timeout' ? 1000 : 10000 } });
        const client = await authed(port),
          other = await authed(port);
        const reply = client.request('build.plan', { workspace, platform: 'ios' });
        await until(() => slow.processes().length > 0);
        expect(await other.request('machine.history')).toHaveProperty('result');
        if (mode === 'disconnect') client.socket.terminate();
        else if (mode === 'shutdown') {
          assert(server);
          await server.close();
          server = null;
        }
        const response = mode === 'timeout' ? await reply : null;
        const failure = response && 'error' in response ? response.error : null;
        expect(failure).toEqual(
          mode === 'timeout' ? { code: 'stim-failed', message: 'stim ios did not finish within 1 s.' } : null,
        );
        await until(() => slow.processes().every((pid) => !alive(pid)));
        expect(stimCalls()).toEqual([]);
      },
    );
  });

  test.skipIf(process.platform === 'win32')(
    'keeps another socket responsive, shares the command cap, and cancels stats plus its Git child on disconnect',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env, requestLimits: { connection: 4 } });
      const first = await authed(port);
      const second = await authed(port);
      for (let id = 10; id < 14; id++)
        first.socket.send(JSON.stringify({ id, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length >= 4);
      expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(await first.request('settings.get')).toMatchObject({ error: { code: 'limit-exceeded' } });
      const owned = slow.processes();
      first.socket.terminate();
      await until(() => owned.every((pid) => !alive(pid)));
      expect(await second.request('stats.get')).toMatchObject({ result: { version: 1 } });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'bounds a tailnet device across its connections until its cancelled reads drain',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env, requestLimits: { device: 2 } });
      const peer = '100.64.0.2';
      const { keyPair } = await pair(port, peer);
      const first = await returning(port, keyPair, peer);
      const second = await returning(port, keyPair, peer);
      for (let id = 10; id < 12; id++)
        first.socket.send(JSON.stringify({ id, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length >= 2);
      expect(await second.request('stats.get', { workspace })).toMatchObject({
        error: { code: 'limit-exceeded', message: 'A remote device can run 2 requests at a time.' },
      });
      const owned = slow.processes();
      first.socket.terminate();
      await until(() => owned.every((pid) => !alive(pid)));
      second.socket.send(JSON.stringify({ id: 20, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length > owned.length);
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
      await until(() => slow.processes().every((pid) => !alive(pid)));
      client.socket.send(JSON.stringify({ id: 10, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length === 4);
      await server!.close();
      server = null;
      expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'reads settings in-process, keeping another socket responsive and killing its Git children at timeout and on disconnect',
    async () => {
      const slow = slowGit();
      const gits = slow.processes;
      const port = await start({ env: slow.env, commandLimits: { timeoutMs: 1000 } });
      const first = await authed(port);
      const second = await authed(port);
      const reply = first.request('settings.get', { workspace });
      await until(() => gits().length > 0);
      expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(await reply).toMatchObject({
        error: { code: 'stim-failed', message: 'stim settings did not finish within 1 s.' },
      });
      await until(() => gits().every((pid) => !alive(pid)));
      const timedOut = gits().length;
      first.socket.send(JSON.stringify({ id: 20, method: 'settings.get', params: { workspace } }));
      await until(() => gits().length > timedOut);
      first.socket.terminate();
      await until(() => gits().every((pid) => !alive(pid)));
      expect(stimCalls()).toEqual([]);
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
        await until(() => slow.processes('rev-parse').length > 0);
        first.socket.close();
        await first.closed;
        expect(slow.processes().every(alive)).toBe(true);
        second.socket.send(JSON.stringify({ id: 20, method: 'machine.details' }));
        expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
        await server!.close();
        server = null;
        expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
      }
    },
  );
});

describe('build.plan', () => {
  function gatedPlans(cleanup = Promise.resolve()) {
    const planCalls: {
      cwd: string;
      platform: string;
      slot?: string;
      finish: () => void;
      fail: (cause: Error) => void;
    }[] = [];
    let cancelled = 0;
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
      ...original(options),
      plan: async (request) => {
        assert(request.platform !== 'macos');
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            cancelled += 1;
            void cleanup.then(
              () => reject(new stim.StimError({ code: 'STIM_CANCELLED', message: 'Cancelled.' })),
              reject,
            );
          };
          request.signal?.addEventListener('abort', stop, { once: true });
          planCalls.push({
            cwd: options.projectRoot,
            platform: request.platform,
            slot: request.slot,
            fail: reject,
            finish: () => {
              request.signal?.removeEventListener('abort', stop);
              resolve();
            },
          });
        });
        const report: BuildPlanPayload = {
          platform: request.platform,
          ...(request.slot ? { slot: request.slot } : {}),
          fingerprint: 'fixture',
          cacheKey: 'fixture',
          cacheHit: false,
          provider: null,
          cacheSkipped: false,
          prebuild: null,
          outcome: 'cold',
          expectedMs: null,
          basis: 0,
        };
        return report;
      },
    }));
    return {
      calls: planCalls,
      get cancelled() {
        return cancelled;
      },
      close: () => {
        for (const call of planCalls) call.finish();
        api.mockRestore();
      },
    };
  }

  for (const retained of [false, true])
    test.skipIf(process.platform === 'win32')(
      `cancels only its own plan and waits for cleanup with retained=${retained}`,
      async () => {
        const refusal = {
          code: 'STIM_CLAIM_UNAVAILABLE',
          message: 'Retained /scratch/plan.',
          remedy: 'Check ownership.',
        };
        let finishCleanup = () => {};
        let releaseCleanup = () => {};
        const cleanup = new Promise<void>((resolve, reject) => {
          releaseCleanup = resolve;
          finishCleanup = () => (retained ? reject(new stim.StimError(refusal)) : resolve());
        });
        const fixture = gatedPlans(cleanup);
        try {
          await start();
          const client = await desktop(),
            other = await desktop();
          void client.request('desktop.plan.get', { cwd: workspace, platform: 'ios', request: 'own' }).catch(() => {});
          await until(() => fixture.calls.length === 1);
          expect(await other.request('desktop.plan.cancel', { request: 'own' })).toMatchObject({
            result: { cancelled: false },
          });
          const queued = other.request('desktop.plan.get', { cwd: workspace, platform: 'android', request: 'own' });
          let ended = false;
          const cancellation = client.request('desktop.plan.cancel', { request: 'own' }).then((result) => {
            ended = true;
            return result;
          });
          await until(() => fixture.cancelled === 1);
          expect(ended).toBe(false);
          expect(await client.request('machine.history')).toMatchObject({ result: expect.anything() });
          expect(ended).toBe(false);
          expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
          finishCleanup();
          expect(await cancellation).toMatchObject({ result: { cancelled: true, ...(retained ? { refusal } : {}) } });
          await until(() => fixture.calls.length === 2);
          fixture.calls[1]?.finish();
          expect(await queued).toHaveProperty('result.platform', 'android');
          expect(await client.request('desktop.plan.cancel', { request: 'own' })).toMatchObject({
            result: { cancelled: false },
          });
          expect(stimCalls()).toEqual([]);
        } finally {
          releaseCleanup();
          fixture.close();
        }
      },
    );

  test.skipIf(process.platform === 'win32')(
    'retains completed cleanup refusals until connection-scoped acknowledgement without evicting them',
    async () => {
      const fixture = gatedPlans();
      const refusal = {
        code: 'STIM_CLAIM_UNAVAILABLE',
        message: 'Retained /scratch/plan.',
        remedy: 'Check ownership.',
      };
      try {
        await start();
        const client = await desktop(),
          other = await desktop();
        for (let index = 0; index < 4; index += 1) {
          const response = client.request('desktop.plan.get', {
            cwd: workspace,
            platform: 'ios',
            request: `plan-${index}`,
          });
          await until(() => fixture.calls.length === index + 1);
          fixture.calls[index]?.fail(new stim.StimError(refusal));
          expect(await response).toMatchObject({ result: refusal });
        }
        expect(await other.request('desktop.plan.cancel', { request: 'plan-0' })).toMatchObject({
          result: { cancelled: false },
        });
        expect(
          await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios', request: 'next' }),
        ).toHaveProperty('error.code', 'limit-exceeded');
        expect(await client.request('desktop.plan.cancel', { request: 'plan-0' })).toMatchObject({
          result: { cancelled: true, refusal },
        });
        expect(await client.request('desktop.plan.cancel', { request: 'plan-0' })).toMatchObject({
          result: { cancelled: false },
        });
        const next = client.request('desktop.plan.get', { cwd: workspace, platform: 'android', request: 'next' });
        await until(() => fixture.calls.length === 5);
        fixture.calls[4]?.finish();
        expect(await next).toHaveProperty('result.platform', 'android');
        expect(await client.request('desktop.plan.cancel', { request: 'plan-3' })).toMatchObject({
          result: { cancelled: true, refusal },
        });
      } finally {
        fixture.close();
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'preserves cleanup refusal after a server deadline and releases admission after acknowledgement',
    async () => {
      const refusal = {
        code: 'STIM_CLAIM_UNAVAILABLE',
        message: 'Retained /scratch/plan.',
        remedy: 'Check ownership.',
      };
      let failCleanup = () => {};
      let releaseCleanup = () => {};
      const cleanup = new Promise<void>((resolve, reject) => {
        releaseCleanup = resolve;
        failCleanup = () => reject(new stim.StimError(refusal));
      });
      const fixture = gatedPlans(cleanup);
      try {
        await start({ commandLimits: { timeoutMs: 100, maxOutputBytes: 1024 * 1024 } });
        const client = await desktop();
        const response = client.request('desktop.plan.get', { cwd: workspace, platform: 'ios', request: 'timeout' });
        await until(() => fixture.calls.length === 1);
        expect(await response).toHaveProperty('error.code', 'stim-failed');
        const cancellation = client.request('desktop.plan.cancel', { request: 'timeout' });
        expect(await client.request('machine.history')).toMatchObject({ result: expect.anything() });
        failCleanup();
        expect(await cancellation).toMatchObject({ result: { cancelled: true, refusal } });
        expect(await client.request('desktop.plan.cancel', { request: 'timeout' })).toMatchObject({
          result: { cancelled: false },
        });
        const next = client.request('desktop.plan.get', { cwd: workspace, platform: 'android', request: 'next' });
        await until(() => fixture.calls.length === 2);
        fixture.calls[1]?.finish();
        expect(await next).toHaveProperty('result.platform', 'android');
      } finally {
        releaseCleanup();
        fixture.close();
      }
    },
  );

  it('plans the registered workspace in-process and preserves the slot', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const client = await authed(port);
      rmSync(join(root, 'fake-stim.mjs'));
      const response = client.request('build.plan', { workspace, platform: 'android', slot: 'tablet' });
      await until(() => fixture.calls.length === 1);
      expect(fixture.calls[0]).toMatchObject({ cwd: workspace, platform: 'android', slot: 'tablet' });
      fixture.calls[0]?.finish();
      expect(await response).toMatchObject({ result: { platform: 'android', slot: 'tablet' } });
      expect(stimCalls()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('refuses a platform, slot or workspace it cannot plan, running nothing', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const client = await authed(port);
      expect(await client.request('build.plan', { workspace, platform: 'web' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      for (const slot of ['', '--device', 'a\u0000b'])
        expect(await client.request('build.plan', { workspace, platform: 'ios', slot })).toMatchObject({
          error: { code: 'bad-request' },
        });
      expect(await client.request('build.plan', { workspace: '/nowhere', platform: 'ios' })).toMatchObject({
        error: { code: 'unknown-workspace' },
      });
      expect(fixture.calls).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('runs one plan at a time per workspace, across connections', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const first = await authed(port),
        second = await authed(port);
      const ios = first.request('build.plan', { workspace, platform: 'ios' });
      await until(() => fixture.calls.length === 1);
      const android = second.request('build.plan', { workspace, platform: 'android' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
      fixture.calls[0]?.finish();
      expect(await ios).toHaveProperty('result.platform', 'ios');
      await until(() => fixture.calls.length === 2);
      fixture.calls[1]?.finish();
      expect(await android).toHaveProperty('result.platform', 'android');
    } finally {
      fixture.close();
    }
  });

  it('drops the queued plans of a closed connection and lets the next one run', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const closing = await authed(port),
        staying = await authed(port);
      void closing.request('build.plan', { workspace, platform: 'ios' });
      void closing.request('build.plan', { workspace, platform: 'android' });
      await until(() => fixture.calls.length === 1);
      const response = staying.request('build.plan', { workspace, platform: 'ios', slot: 'tablet' });
      closing.socket.close();
      await until(() => fixture.calls.length === 2);
      expect(fixture.calls.map((call) => [call.platform, call.slot])).toEqual([
        ['ios', undefined],
        ['ios', 'tablet'],
      ]);
      fixture.calls[1]?.finish();
      expect(await response).toHaveProperty('result.platform', 'ios');
    } finally {
      fixture.close();
    }
  });

  it('keeps the next plan queued until a timed-out plan finishes cleanup', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = gatedPlans(cleanup);
    try {
      const port = await start({ commandLimits: { timeoutMs: 1000 } });
      const first = await authed(port),
        second = await authed(port);
      const ios = first.request('build.plan', { workspace, platform: 'ios' });
      await until(() => fixture.calls.length === 1);
      const android = second.request('build.plan', { workspace, platform: 'android' });
      expect(await ios).toHaveProperty('error.code', 'stim-failed');
      expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
      release();
      await until(() => fixture.calls.length === 2);
      fixture.calls[1]?.finish();
      expect(await android).toHaveProperty('result.platform', 'android');
    } finally {
      release();
      fixture.close();
    }
  });

  it('keeps later plans waiting when a queued plan ahead of them is dropped', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const staying = await authed(port),
        closing = await authed(port);
      const ios = staying.request('build.plan', { workspace, platform: 'ios' });
      await until(() => fixture.calls.length === 1);
      void closing.request('build.plan', { workspace, platform: 'ios', slot: 'tablet' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const android = staying.request('build.plan', { workspace, platform: 'android' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      closing.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
      fixture.calls[0]?.finish();
      expect(await ios).toHaveProperty('result.platform', 'ios');
      await until(() => fixture.calls.length === 2);
      fixture.calls[1]?.finish();
      expect(await android).toHaveProperty('result.platform', 'android');
    } finally {
      fixture.close();
    }
  });

  test.skipIf(process.platform === 'win32')(
    'limits selected-folder plans to the proved Desktop and validates its native selectors',
    async () => {
      const port = await start();
      const phone = await authed(port);
      assert(server?.localSocket);
      const plain = await localConnect(server.localSocket);
      const hello = await plain.request('hello', { client: CLIENT });
      expect(hello).toMatchObject({ result: { features: expect.arrayContaining(['desktop-plan']) } });
      for (const client of [phone, plain])
        expect(await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios' })).toHaveProperty(
          'error.code',
          'forbidden',
        );
      const client = await desktop();
      for (const params of [
        {},
        { cwd: '.', platform: 'ios' },
        { cwd: workspace, platform: 'web' },
        { cwd: workspace, platform: 'macos', slot: 'preview' },
        { cwd: workspace, platform: 'ios', slot: '--device' },
        { cwd: workspace, platform: 'ios', extra: true },
        { cwd: join(root, 'missing'), platform: 'android' },
      ])
        expect(await client.request('desktop.plan.get', params)).toHaveProperty('error.code', 'bad-request');
      writeFileSync(join(workspace, 'package.json'), '{}');
      rmSync(join(root, 'fake-stim.mjs'));
      expect(await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios' })).toMatchObject({
        result: {
          code: 'STIM_NO_PROJECT',
          message: expect.stringContaining(join(workspace, 'package.json')),
          remedy: expect.stringContaining('package.json'),
        },
      });
      expect(stimCalls()).toEqual([]);
    },
  );

  describe.skipIf(process.platform !== 'darwin')('macOS planning', () => {
    it('plans an unregistered macOS app through the real API without compiling or launching', async () => {
      const selected = join(root, 'native-app');
      mkdirSync(selected);
      writeFileSync(join(selected, 'Package.swift'), '// swift-tools-version: 6.0\n');
      writeFileSync(
        join(selected, 'Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.fixture.plan</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
      );
      writeFileSync(
        join(selected, '.stim.json'),
        JSON.stringify({ macos: { product: 'Fixture', infoPlist: 'Info.plist' } }),
      );
      await start({ env: { STIM_REMOTE_BUILD: 'local' } });
      const client = await desktop();
      rmSync(join(root, 'fake-stim.mjs'));
      expect(await client.request('desktop.plan.get', { cwd: selected, platform: 'macos' })).toMatchObject({
        result: {
          platform: 'macos',
          product: 'Fixture',
          buildMachine: 'local',
          cacheHit: false,
          cacheKey: null,
        },
      });
      expect(existsSync(join(selected, '.build'))).toBe(false);
      expect(stimCalls()).toEqual([]);
    });
  });

  test.skipIf(process.platform === 'win32')(
    'does not advertise or grant private selected-folder plans on an adopted server',
    async () => {
      await start({ desktopBootstrap: null });
      assert(server?.localSocket);
      const client = await localConnect(server.localSocket);
      const hello = await client.request('hello', { client: CLIENT });
      const result: unknown = 'result' in hello ? hello.result : null;
      assert(isJsonObject(result));
      expect(result.features).not.toContain('desktop-plan');
      expect(await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios' })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    },
  );

  it('reports a real planner refusal with its code, message and remedy without a CLI', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const port = await start();
    const client = await authed(port);
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('build.plan', { workspace, platform: 'android' })).toMatchObject({
      error: { code: 'stim-failed', message: expect.stringContaining('STIM_NO_PROJECT:') },
    });
    expect(stimCalls()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop settings writes', () => {
  it('writes and unsets through the proved Desktop without a CLI and keeps secrets out of results and audit', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'ios.runtime',
        value: '26.4',
        scope: 'workspace',
      }),
    ).toMatchObject({
      result: { changed: true, setting: { value: '26.4', origin: 'workspace' } },
    });
    const secret = 'private-setting-value';
    const written = await client.request('desktop.settings.write', {
      cwd: workspace,
      action: 'set',
      key: 'android.keystorePassword',
      value: secret,
      scope: 'workspace',
    });
    expect(written).toMatchObject({ result: { setting: { value: '********', layers: { workspace: '********' } } } });
    expect(JSON.stringify(written)).not.toContain(secret);
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'unset',
        key: 'ios.runtime',
        scope: 'workspace',
      }),
    ).toMatchObject({
      result: { changed: true, setting: { layers: {} } },
    });
    expect(loadConfig()?.projects[workspace]?.settings).toEqual({ android: { keystorePassword: secret } });
    expect(readAudit()).toContainEqual(
      expect.objectContaining({ action: 'settings.set', setting: 'android.keystorePassword', workspace, ok: true }),
    );
    expect(JSON.stringify(readAudit())).not.toContain(secret);
    expect(stimCalls()).toEqual([]);
  });

  it('requires the proved local Desktop and refuses malformed requests without mutation', async () => {
    const port = await start();
    const remote = await authed(port, true);
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    expect(await plain.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.arrayContaining(['desktop-settings-write']) },
    });
    const request = { cwd: workspace, action: 'set', key: 'concurrency.maxBuilds', value: '3' };
    for (const client of [remote, plain]) {
      expect(await client.request('desktop.settings.write', request)).toHaveProperty('error.code', 'forbidden');
    }
    const client = await desktop();
    for (const params of [
      {},
      { ...request, cwd: '.' },
      { ...request, cwd: workspace + '\0' },
      { ...request, cwd: join(root, 'missing') },
      { ...request, action: 'unset' },
      { ...request, value: false },
      { ...request, extra: true },
      { ...request, scope: 'all' },
    ]) {
      expect(await client.request('desktop.settings.write', params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
    expect(stimCalls()).toEqual([]);
  });

  it('accepts a non-project folder for machine writes and preserves typed refusals', async () => {
    await start();
    const client = await desktop();
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: '3',
      }),
    ).toMatchObject({ result: { changed: true, setting: { value: 3 } } });
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'ios.runtime',
        value: '26.4',
        scope: 'workspace',
      }),
    ).toMatchObject({ result: { code: 'STIM_NO_PROJECT', remedy: expect.any(String) } });
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: 'many',
      }),
    ).toMatchObject({ result: { code: 'STIM_BAD_ARG', message: expect.any(String) } });
    expect(loadConfig()?.concurrency?.maxBuilds).toBe(3);
  });
  it('does not advertise or grant writes on a server Desktop did not start', async () => {
    await start({ desktopBootstrap: null });
    assert(server?.localSocket);
    const client = await localConnect(server.localSocket);
    expect(await client.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.not.arrayContaining(['desktop-settings-write']) },
    });
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: '3',
      }),
    ).toHaveProperty('error.code', 'forbidden');
    expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
  });

  it('keeps a canonical folder busy while yielding and cancels a timed-out pending write', async () => {
    await start({ actionLimits: { timeoutMs: 1000 } });
    const client = await desktop();
    const lock = join(root, 'home', 'config.lock');
    mkdirSync(lock);
    const alias = join(root, 'alias');
    symlinkSync(workspace, alias, 'dir');
    const request = { cwd: alias, action: 'set', key: 'concurrency.maxBuilds', value: '3' };
    try {
      const pending = client.request('desktop.settings.write', request);
      expect(await client.request('machine.history')).toHaveProperty('result');
      expect(await client.request('desktop.settings.write', { ...request, cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await pending).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('did not finish within') },
      });
      await until(() => readAudit().some((entry) => entry.action === 'settings.set'));
      expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
      rmSync(lock, { recursive: true });
      expect(await client.request('desktop.settings.write', request)).toHaveProperty('result.changed', true);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('cancels a pending write on disconnect without changing its setting', async () => {
    await start();
    const client = await desktop();
    const lock = join(root, 'home', 'config.lock');
    mkdirSync(lock);
    try {
      void client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: '3',
      });
      expect(await client.request('machine.history')).toHaveProperty('result');
      client.socket.close();
      await client.closed;
      await until(() => readAudit().some((entry) => entry.action === 'settings.set'));
      expect(readAudit()).toContainEqual(
        expect.objectContaining({
          action: 'settings.set',
          ok: false,
          error: { code: 'action-failed', message: 'STIM_CANCELLED' },
        }),
      );
      expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('bounds result output without leaking setting values into the audit', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    await start({ actionLimits: { maxOutputBytes: 8 } });
    const client = await desktop();
    const secret = 'not-for-the-audit';
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'android.keystorePassword',
        value: secret,
        scope: 'workspace',
      }),
    ).toHaveProperty('error.code', 'action-failed');
    expect(loadConfig()?.projects[workspace]?.settings).toEqual({ android: { keystorePassword: secret } });
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: 'invalid-value'.repeat(100),
      }),
    ).toMatchObject({ error: { code: 'action-failed', message: 'Settings write exceeded its output limit.' } });
    expect(JSON.stringify(readAudit())).not.toContain(secret);
  });

  it('holds admission and shutdown until a committed recording deletion drains after timeout', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const selected = join(workspace, 'src');
    mkdirSync(selected);
    const sibling = join(workspace, 'tests');
    mkdirSync(sibling);
    const recordings = join(workspaceStateDir(workspace), 'recordings');
    mkdirSync(recordings, { recursive: true });
    writeFileSync(join(recordings, 'segment'), 'recorded bytes');
    await start({ actionLimits: { timeoutMs: 1000 } });
    const client = await desktop();
    const other = await desktop();
    let started: () => void = () => {};
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = fsPromises.rm;
    const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === recordings) {
        started();
        await blocked;
      }
      return remove(path, options);
    });
    syncBuiltinESMExports();
    let closing: Promise<void> | undefined;
    try {
      const pending = client.request('desktop.settings.write', {
        cwd: selected,
        action: 'set',
        key: 'recording.enabled',
        value: 'false',
        scope: 'workspace',
      });
      await ready;
      expect(await pending).toHaveProperty('error.code', 'action-failed');
      for (const cwd of [workspace, sibling]) {
        expect(
          await other.request('desktop.settings.write', {
            cwd,
            action: 'unset',
            key: 'recording.enabled',
            scope: 'workspace',
          }),
        ).toHaveProperty('error.code', 'action-busy');
      }
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      assert(server);
      let closed = false;
      closing = server.close().then(() => {
        closed = true;
        return undefined;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release();
      await closing;
      server = null;
      expect(existsSync(recordings)).toBe(false);
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'settings.set', ok: false }));
    } finally {
      release();
      await closing;
      deletion.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop stop', () => {
  async function stopped(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-stop-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  function heldConfig() {
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    const lock = join(root, 'home', 'config.lock');
    mkdirSync(lock);
    return lock;
  }

  it('streams stop progress and the resolved workspace JSON without a CLI process', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    const selected = join(workspace, 'src');
    mkdirSync(selected);
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    const reply = await client.request('desktop.stop.subscribe', { cwd: selected });
    expect(reply).toMatchObject({ result: { subscription: expect.any(String) } });
    const { progress, done } = await stopped(client);
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...progress, done].every((message) => acceptsEvent(message))).toBe(true);
    expect(progress).toContainEqual(
      expect.objectContaining({
        event: 'desktop-stop-progress',
        stream: 'stderr',
        message: expect.stringContaining('no supervisor'),
      }),
    );
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ root: workspace, ok: true });
    expect(done.message).toContain('Stopped');
    expect(readWorkspaceState(workspace)?.launches).toBeUndefined();
    expect(stimCalls()).toEqual([]);
  });

  it('requires the proved local Desktop and rejects invalid targets before starting work', async () => {
    const port = await start();
    const remote = await authed(port, true);
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    expect(await plain.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.arrayContaining(['desktop-stop']) },
    });
    for (const client of [remote, plain]) {
      expect(await client.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    }
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, extra: true },
      { cwd: `${workspace}\0` },
      { cwd: workspace, slot: '' },
      { cwd: workspace, slot: '../default' },
      { cwd: workspace, slot: 'constructor' },
      { cwd: join(root, 'missing') },
    ]) {
      expect(await client.request('desktop.stop.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(stimCalls()).toEqual([]);
  });

  it('stops one device slot while preserving sibling launches and the shared server reservation', async () => {
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({
        projects: { [workspace]: { metroPort: 31337, deviceSlots: { tablet: {} } } },
      }),
    );
    const launch = {
      appId: 'dev.fixture',
      deviceId: 'fixture',
      metroPort: 31337,
      release: false,
      launchedAt: new Date().toISOString(),
    };
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: { ios: launch, 'ios:tablet': launch } }));
    await start();
    const client = await desktop();
    await client.request('desktop.stop.subscribe', { cwd: workspace, slot: 'tablet' });
    const { done } = await stopped(client);
    expect(done.exitCode).toBe(0);
    expect(readWorkspaceState(workspace)?.launches).toEqual({ ios: launch });
    expect(loadConfig()?.projects?.[workspace]?.metroPort).toBe(31337);
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'stop', slot: 'tablet', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it('accepts the web slot without clearing native launches or the shared server reservation', async () => {
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({ projects: { [workspace]: { metroPort: 31337 } } }),
    );
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: { ios: { appId: 'dev.fixture' } } }));
    await start();
    const client = await desktop();
    await client.request('desktop.stop.subscribe', { cwd: workspace, slot: 'web' });
    const { done } = await stopped(client);
    expect(done.exitCode).toBe(0);
    expect(readWorkspaceState(workspace)?.launches).toEqual({ ios: { appId: 'dev.fixture' } });
    expect(loadConfig()?.projects?.[workspace]?.metroPort).toBe(31337);
    expect(stimCalls()).toEqual([]);
  });

  it('keeps a timed-out stop busy until started cleanup drains at shutdown', async () => {
    const port = await start({ actionLimits: { timeoutMs: 500 } });
    const client = await desktop();
    const other = await authed(port, true);
    const lock = heldConfig();
    let released = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await client.request('desktop.stop.subscribe', { cwd: workspace });
      await until(() => readWorkspaceState(workspace)?.launches === undefined);
      const { done } = await stopped(client);
      expect(done).toMatchObject({ exitCode: 1, message: 'stim stop did not finish within 0.5 s.' });
      expect(await other.request('action', { action: 'reload', workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await other.request('machine.history')).toHaveProperty('result');
      release = setTimeout(() => {
        released = true;
        rmSync(lock, { recursive: true });
      }, 50);
      assert(server);
      await server.close();
      server = null;
      expect(released).toBe(true);
    } finally {
      clearTimeout(release);
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it.each(['unsubscribe', 'disconnect'])(
    'cancels on %s and retains admission until started cleanup finishes',
    async (mode) => {
      const port = await start();
      const client = await desktop();
      const other = await authed(port, true);
      const lock = heldConfig();
      try {
        const reply = await client.request('desktop.stop.subscribe', { cwd: workspace });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result) && typeof result.subscription === 'string');
        await until(() => readWorkspaceState(workspace)?.launches === undefined);
        if (mode === 'unsubscribe') {
          await client.request('unsubscribe', { subscription: result.subscription });
        } else {
          client.socket.close();
          await client.closed;
        }
        expect(await other.request('action', { action: 'reload', workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        rmSync(lock, { recursive: true });
        await until(() =>
          readAudit().some((entry) => entry.action === 'stop' && entry.error?.message.includes('STIM_CANCELLED')),
        );
        expect(stimCalls()).toEqual([]);
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    },
  );

  it('bounds streamed output and drains cancellation before closing the server', async () => {
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const client = await desktop();
    await client.request('desktop.stop.subscribe', { cwd: workspace });
    const { progress, done } = await stopped(client);
    expect(progress).toEqual([]);
    expect(done).toMatchObject({ exitCode: 1, stdout: '', message: 'stim stop printed more than 1 bytes.' });
    assert(server);
    await server.close();
    server = null;
    expect(readAudit()).toContainEqual(
      expect.objectContaining({
        action: 'stop',
        error: { code: 'action-failed', message: 'stim stop printed more than 1 bytes.' },
      }),
    );
    expect(stimCalls()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop start', () => {
  async function started(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-start-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  it.each(['start', 'stop', 'action-stop'] as const)(
    'reserves the enclosing app while %s is pending',
    async (first) => {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
      const selected = join(workspace, 'src');
      const sibling = join(workspace, 'tests');
      mkdirSync(selected);
      mkdirSync(sibling);
      mkdirSync(workspaceStateDir(workspace), { recursive: true });
      writeFileSync(join(workspaceStateDir(workspace), 'state.json'), JSON.stringify({ launches: {} }));
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({ projects: { [workspace]: {}, [selected]: {} } }),
      );
      const port = await start({ actionLimits: { timeoutMs: 1000 } });
      const client = first === 'action-stop' ? await authed(port, true) : await desktop();
      const other = await desktop();
      let controlStop: Promise<ServerMessage> | undefined;
      const claim = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' });
      assert(claim.acquired);
      try {
        if (first === 'action-stop') controlStop = client.request('action', { action: 'stop', workspace: selected });
        else {
          const reply = await client.request(`desktop.${first}.subscribe`, { cwd: selected });
          assert('result' in reply);
        }
        const lock = join(workspaceStateDir(workspace), first === 'start' ? 'metro-start.lock' : 'native-run.lock');
        await until(() => readClaimSet(lock).live.length > 0);
        const second = first === 'start' ? 'stop' : 'start';
        expect(
          await other.request(`desktop.${second}.subscribe`, {
            cwd: sibling,
            ...(second === 'stop' ? { slot: 'web' } : {}),
          }),
        ).toHaveProperty('result.subscription');
        let terminal: ServerMessage | undefined;
        while (!terminal) {
          const event = await other.next();
          if ('event' in event && event.event === `desktop-${second}-ended`) terminal = event;
        }
        expect(terminal).toMatchObject({ exitCode: 1, message: expect.stringContaining('STIM_ACTION_BUSY') });
      } finally {
        releaseClaim(claim.acquired);
        await controlStop;
      }
    },
  );

  it.each(['unsubscribe', 'deadline', 'retained-unsubscribe'] as const)(
    'waits for startup cleanup before acknowledging %s',
    async (mode) => {
      const claim = tryAcquireClaim({ root: join(root, 'draining-start'), mode: 'exclusive' });
      assert(claim.acquired);
      const heldClaim = claim.acquired;
      await start({ actionLimits: { timeoutMs: mode === 'deadline' ? 100 : 5000 } });
      let markCancelled = () => {};
      const cancelled = new Promise<void>((resolve) => {
        markCancelled = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = stim.createStim;
      const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
        ...original(options),
        start: async (request) => {
          const signal = request?.signal;
          assert(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          markCancelled();
          await gate;
          throw new stim.StimError(
            mode !== 'unsubscribe'
              ? {
                  code: 'STIM_CLAIM_UNAVAILABLE',
                  message: 'Fixture cleanup is unresolved.',
                  remedy: `Recover ${heldClaim.path}`,
                  details: { cause: { retainedClaimRoots: [heldClaim.root] } },
                }
              : { code: 'STIM_CANCELLED', message: 'Fixture startup cancelled.' },
          );
        },
      }));
      try {
        const client = await desktop();
        const other = await desktop();
        const reply = await client.request('desktop.start.subscribe', { cwd: workspace });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result));
        let acknowledged = false;
        const response =
          mode === 'deadline' ? started(client) : client.request('unsubscribe', { subscription: result.subscription });
        void response.then(() => {
          acknowledged = true;
          return undefined;
        });
        await cancelled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        expect(acknowledged).toBe(false);
        release();
        const answer = await response;
        const recoveryMessage = expect.stringContaining(`Recover ${heldClaim.path}`);
        const expected =
          mode === 'deadline'
            ? { code: 'STIM_CLAIM_UNAVAILABLE', remedy: `Recover ${heldClaim.path}` }
            : mode === 'retained-unsubscribe'
              ? { error: { code: 'action-failed', message: recoveryMessage } }
              : { result: {} };
        expect('done' in answer ? JSON.parse(answer.done.stdout) : answer).toMatchObject(expected);
        const subscription = expect.any(String);
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toMatchObject(
          mode !== 'unsubscribe' ? { error: { code: 'action-busy' } } : { result: { subscription } },
        );
      } finally {
        release();
        api.mockRestore();
        releaseClaim(claim.acquired);
      }
    },
  );

  it('releases retained workspace and connection admission after every recorded claim is recovered', async () => {
    const nested = join(workspace, 'src');
    mkdirSync(nested);
    const sibling = join(workspace, 'tests');
    mkdirSync(sibling);
    const roots = [nested, ...[1, 2, 3].map((index) => join(root, `retained-app-${index}`))];
    for (const cwd of roots) {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd === nested ? workspace : cwd, 'package.json'),
        JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }),
      );
    }
    const claims = roots.map((_cwd, index) => {
      const attempt = tryAcquireClaim({ root: join(root, `retained-${index}`), mode: 'exclusive' });
      assert(attempt.acquired);
      return attempt.acquired;
    });
    const second = tryAcquireClaim({ root: join(root, 'retained-second'), mode: 'exclusive' });
    assert(second.acquired);
    const secondClaim = second.acquired;
    const firstClaim = claims[0];
    assert(firstClaim);
    await start({ requestLimits: { connection: 4 } });
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
      ...original(options),
      start: (request) =>
        original(options).start({
          ...request,
          beforeStart: (resolved) => {
            request?.beforeStart?.(resolved);
            const index = roots.indexOf(options.projectRoot);
            const current = claims[index];
            assert(current);
            const retained = index === 0 ? [firstClaim, secondClaim] : [current];
            if (retained.some((claim) => existsSync(claim.path)))
              throw new stim.StimError({
                code: 'STIM_CLAIM_UNAVAILABLE',
                message: 'Fixture child cleanup could not be confirmed.',
                details: { retainedClaimRoots: retained.map((claim) => claim.root) },
              });
            throw new stim.StimError({ code: 'STIM_BAD_ARG', message: 'Recovered startup reached the API.' });
          },
        }),
    }));
    try {
      const client = await desktop();
      const other = await desktop();
      for (const cwd of roots) {
        expect(await client.request('desktop.start.subscribe', { cwd })).toHaveProperty('result.subscription');
        expect(JSON.parse((await started(client)).done.stdout)).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      }
      await until(() => readAudit().filter((entry) => entry.action === 'start').length === 4);
      expect(await client.request('desktop.start.subscribe', { cwd: nested })).toHaveProperty(
        'error.code',
        'limit-exceeded',
      );
      releaseClaim(claims[0]);
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await other.request('desktop.stop.subscribe', { cwd: sibling, slot: 'web' })).toHaveProperty(
        'result.subscription',
      );
      let terminal: ServerMessage | undefined;
      while (!terminal) {
        const event = await other.next();
        if ('event' in event && event.event === 'desktop-stop-ended') terminal = event;
      }
      expect(terminal).toMatchObject({ exitCode: 1, message: expect.stringContaining('STIM_ACTION_BUSY') });
      releaseClaim(second.acquired);
      expect(
        await other.request('desktop.settings.write', {
          cwd: workspace,
          action: 'set',
          key: 'recording.enabled',
          value: 'false',
          scope: 'workspace',
        }),
      ).toHaveProperty('result');
      expect(await client.request('desktop.start.subscribe', { cwd: nested })).toHaveProperty('result.subscription');
      expect(JSON.parse((await started(client)).done.stdout)).toMatchObject({ code: 'STIM_BAD_ARG' });
    } finally {
      api.mockRestore();
      for (const claim of [...claims, second.acquired]) releaseClaim(claim);
    }
  });

  it('streams the real supervisor failure diagnostic before the typed startup refusal', async () => {
    const listener = createHttpServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert(address && typeof address === 'object');
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({ projects: { [workspace]: { metroPort: address.port } } }),
    );
    const tools = join(root, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'lsof'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    const script = join(workspace, 'broken-metro.mjs');
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    writeFileSync(script, "console.error('Error: fixture Metro diagnostic: port setup rejected'); process.exit(1);");
    writeFileSync(
      join(workspace, '.stim.json'),
      JSON.stringify({ metro: { command: [process.execPath, script, '{port}'], tunnel: 'off' } }),
    );
    await start({ env: { PATH: [tools, process.env.PATH ?? ''].join(delimiter) } });
    const client = await desktop();
    await client.request('desktop.start.subscribe', { cwd: workspace, waitSeconds: 5 });
    const { progress, done } = await started(client);
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout)).toMatchObject({ code: 'STIM_SUPERVISOR_EXITED' });
    expect(progress).toContainEqual(
      expect.objectContaining({
        event: 'desktop-start-progress',
        stream: 'stderr',
        message: expect.stringContaining('fixture Metro diagnostic: port setup rejected'),
      }),
    );
    expect(stimCalls()).toEqual([]);
  });

  it('starts and reuses an owned real supervisor without a CLI', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    const script = join(workspace, 'metro.mjs');
    writeFileSync(
      script,
      "import {createServer} from 'node:http'; createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[2]), '127.0.0.1');",
    );
    const listener = createHttpServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert(address && typeof address === 'object');
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const home = join(root, 'home');
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        version: 2,
        projects: {
          [workspace]: {
            metroPort: address.port,
            settings: { metro: { command: [process.execPath, script, '{port}'] } },
          },
        },
        repos: {},
      }),
    );
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    try {
      expect(await client.request('desktop.start.subscribe', { cwd: workspace, waitSeconds: 10 })).toHaveProperty(
        'result.subscription',
      );
      const first = await started(client);
      expect(first.done.exitCode).toBe(0);
      const facts: unknown = JSON.parse(first.done.stdout);
      assert(isJsonObject(facts));
      expect(facts).toMatchObject({ port: address.port, alreadyRunning: false, supervisorPid: expect.any(Number) });
      const record = readWorkspaceState(workspace)?.supervisor;
      expect(record?.pid).toBe(facts.supervisorPid);
      expect(inspectProcessIdentity(record)).toBe('same');
      await until(() => readAudit().some((entry) => entry.action === 'start' && entry.ok));
      expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
      const reused = await started(client);
      expect(reused.done.exitCode).toBe(0);
      expect(JSON.parse(reused.done.stdout)).toMatchObject({
        supervisorPid: facts.supervisorPid,
        alreadyRunning: true,
      });
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      validator.addSchema(protocolJsonSchema(), 'protocol');
      const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
      expect(
        [...first.progress, first.done, ...reused.progress, reused.done].every((message) => acceptsEvent(message)),
      ).toBe(true);
      expect(stimCalls()).toEqual([]);
    } finally {
      await createStim({ projectRoot: workspace, home }).stop();
    }
  }, 30_000);
  it('requires private Desktop proof and rejects invalid startup options before effects', async () => {
    const port = await start();
    const peer = await pair(port, undefined, true);
    const remote = await connect(port, undefined, { keyPair: peer.keyPair });
    const hello = await remote.request('hello', { client: CLIENT });
    expect(hello).toMatchObject({ result: { features: expect.not.arrayContaining(['desktop-start']) } });
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    await plain.request('hello', { client: CLIENT });
    for (const client of [plain, remote])
      expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, extra: true },
      { cwd: `${workspace}\0` },
      { cwd: join(root, 'missing') },
      { cwd: workspace, remote: 'true' },
      { cwd: workspace, resetCache: 1 },
      { cwd: workspace, waitSeconds: 0 },
      { cwd: workspace, waitSeconds: -1 },
      { cwd: workspace, waitSeconds: 1.5 },
    ])
      expect(await client.request('desktop.start.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    expect(stimCalls()).toEqual([]);
    expect(readWorkspaceState(workspace)?.supervisor).toBeUndefined();
  });

  it('does not offer startup on an adopted server or grant it to local control', async () => {
    await start({ desktopBootstrap: null });
    assert(server?.localSocket);
    const client = await localConnect(server.localSocket);
    const hello = await client.request('hello', { client: CLIENT });
    const result: unknown = 'result' in hello ? hello.result : undefined;
    assert(isJsonObject(result));
    expect(result.features).not.toContain('desktop-start');
    expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(stimCalls()).toEqual([]);
  });

  it.each(['unsubscribe', 'disconnect', 'deadline', 'server close'])(
    'reserves the resolved app and drains %s while its metadata lock is held',
    async (mode) => {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
      const nested = join(workspace, 'src');
      mkdirSync(nested);
      await start(mode === 'deadline' ? { actionLimits: { timeoutMs: 500 } } : {});
      const client = await desktop();
      const other = await desktop();
      const attempt = tryAcquireClaim({
        root: join(root, 'home', 'config.lock.claims'),
        mode: 'exclusive',
        label: 'fixture metadata',
      });
      assert(attempt.acquired);
      try {
        const reply = await client.request('desktop.start.subscribe', { cwd: nested });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result) && typeof result.subscription === 'string');
        for (const [method, params] of [
          ['desktop.stop.subscribe', { cwd: workspace }],
          ['desktop.reload.subscribe', { cwd: workspace }],
          [
            'desktop.settings.write',
            { cwd: workspace, action: 'set', key: 'recording.enabled', value: 'false', scope: 'workspace' },
          ],
        ] as const)
          expect(await other.request(method, params)).toHaveProperty('error.code', 'action-busy');
        expect(await other.request('machine.history')).toHaveProperty('result');
        if (mode === 'unsubscribe') await client.request('unsubscribe', { subscription: result.subscription });
        else if (mode === 'disconnect') {
          client.socket.close();
          await client.closed;
        } else if (mode === 'deadline') await started(client);
        else {
          assert(server);
          await server.close();
          server = null;
        }
        await until(() => readAudit().some((entry) => entry.action === 'start'));
        expect(readAudit().find((entry) => entry.action === 'start')).toMatchObject({
          workspace,
          ok: false,
          error: { message: mode === 'deadline' ? 'STIM_METRO_TIMEOUT' : 'STIM_CANCELLED' },
        });
        expect(readWorkspaceState(workspace)?.supervisor).toBeUndefined();
        expect(stimCalls()).toEqual([]);
      } finally {
        releaseClaim(attempt.acquired);
      }
    },
  );
  it('bounds typed startup refusals by the connection output budget', async () => {
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const client = await desktop();
    await client.request('desktop.start.subscribe', { cwd: workspace });
    expect((await started(client)).done).toMatchObject({ exitCode: 1, stdout: '' });
    await until(() => readAudit().some((entry) => entry.action === 'start'));
    expect(readAudit().find((entry) => entry.action === 'start')?.error?.message).toBe('STIM_OUTPUT_LIMIT');
    expect(stimCalls()).toEqual([]);
  });

  it('limits a connection to four startup operations while they wait for metadata', async () => {
    const roots = [workspace, ...[1, 2, 3].map((index) => join(root, `app-${index}`))];
    for (const folder of roots) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    }
    await start({ requestLimits: { connection: 4 } });
    const client = await desktop();
    const attempt = tryAcquireClaim({
      root: join(root, 'home', 'config.lock.claims'),
      mode: 'exclusive',
      label: 'fixture metadata',
    });
    assert(attempt.acquired);
    try {
      const subscriptions: string[] = [];
      for (const cwd of roots) {
        const reply = await client.request('desktop.start.subscribe', { cwd });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result) && typeof result.subscription === 'string');
        subscriptions.push(result.subscription);
      }
      expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'limit-exceeded',
      );
      for (const subscription of subscriptions) await client.request('unsubscribe', { subscription });
      await until(() => readAudit().filter((entry) => entry.action === 'start').length === 4);
      expect(
        readAudit()
          .filter((entry) => entry.action === 'start')
          .every((entry) => entry.error?.message === 'STIM_CANCELLED'),
      ).toBe(true);
      expect(stimCalls()).toEqual([]);
    } finally {
      releaseClaim(attempt.acquired);
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop reload', () => {
  async function reloaded(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-reload-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  it('dispatches to the owned page and returns flat JSON without a CLI', async () => {
    const browser = await reloadBrowser();
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('desktop.reload.subscribe', { cwd: workspace, platform: 'web' })).toHaveProperty(
      'result.subscription',
    );
    const { progress, done } = await reloaded(client);
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...progress, done].every((message) => acceptsEvent(message))).toBe(true);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ platform: 'web', appId: browser.url, strategy: 'cdp' });
    expect(done.message).toContain('Completion is not observed');
    expect(browser.methods.filter((method) => method === 'Page.reload')).toEqual(['Page.reload']);
    expect(stimCalls()).toEqual([]);
    await until(() => readAudit().some((entry) => entry.action === 'reload' && entry.ok));
  });

  it('requires the private proof and refuses invalid selectors before dispatch', async () => {
    const browser = await reloadBrowser();
    const port = await start();
    const remote = await authed(port, true);
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    const hello = await plain.request('hello', { client: CLIENT });
    expect(hello).toMatchObject({ result: { features: expect.arrayContaining(['desktop-reload']) } });
    for (const client of [remote, plain])
      expect(await client.request('desktop.reload.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, extra: true },
      { cwd: `${workspace}\0` },
      { cwd: workspace, platform: '' },
      { cwd: workspace, platform: '--help' },
      { cwd: workspace, platform: 'macos' },
      { cwd: join(root, 'missing') },
    ])
      expect(await client.request('desktop.reload.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    expect(browser.methods).toEqual([]);
  });

  it('does not offer private reload on an adopted server or grant it to local control', async () => {
    await start({ desktopBootstrap: null });
    assert(server?.localSocket);
    const client = await localConnect(server.localSocket);
    const hello = await client.request('hello', { client: CLIENT });
    const result: unknown = 'result' in hello ? hello.result : undefined;
    assert(isJsonObject(result));
    expect(result.features).not.toContain('desktop-reload');
    expect(await client.request('desktop.reload.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(stimCalls()).toEqual([]);
  });

  it('reserves the actual workspace for stop, settings and phone actions when selected from a child directory', async () => {
    const browser = await reloadBrowser(workspace, true);
    const nested = join(workspace, 'src');
    mkdirSync(nested);
    const port = await start();
    const client = await desktop();
    const other = await desktop();
    const phone = await authed(port, true);
    await client.request('desktop.reload.subscribe', { cwd: nested, platform: 'web' });
    await browser.attaching;
    for (const [method, params] of [
      ['desktop.stop.subscribe', { cwd: workspace }],
      ['desktop.reload.subscribe', { cwd: workspace }],
      [
        'desktop.settings.write',
        { cwd: workspace, action: 'set', key: 'ios.runtime', value: '26.4', scope: 'workspace' },
      ],
    ] as const)
      expect(await other.request(method, params)).toHaveProperty('error.code', 'action-busy');
    expect(await phone.request('action', { action: 'reload', workspace })).toHaveProperty('error.code', 'action-busy');
    browser.release();
    expect((await reloaded(client)).done.exitCode).toBe(0);
    await until(() => readAudit().some((entry) => entry.ok && entry.action === 'reload'));
    expect(readAudit().find((entry) => entry.ok && entry.action === 'reload')?.workspace).toBe(workspace);
    expect(loadConfig()?.projects?.[workspace]?.ios).toBeUndefined();
  });

  it.each(['unsubscribe', 'disconnect'])('cancels on %s without sending a late reload', async (mode) => {
    const browser = await reloadBrowser(workspace, true);
    await start();
    const client = await desktop();
    const reply = await client.request('desktop.reload.subscribe', { cwd: workspace, platform: 'web' });
    const result: unknown = 'result' in reply ? reply.result : undefined;
    assert(isJsonObject(result) && typeof result.subscription === 'string');
    await browser.attaching;
    if (mode === 'unsubscribe') await client.request('unsubscribe', { subscription: result.subscription });
    else {
      client.socket.close();
      await client.closed;
    }
    await browser.closed;
    browser.release();
    await until(() => readAudit().some((entry) => entry.action === 'reload'));
    expect(readAudit().find((entry) => entry.action === 'reload')?.error?.message).toBe('STIM_CANCELLED');
    expect(browser.methods).not.toContain('Page.reload');
    expect(stimCalls()).toEqual([]);
  });

  it('aborts a timed-out attachment and records the deadline result after draining', async () => {
    const browser = await reloadBrowser(workspace, true);
    await start({ actionLimits: { timeoutMs: 500 } });
    const client = await desktop();
    await client.request('desktop.reload.subscribe', { cwd: workspace });
    await browser.attaching;
    expect((await reloaded(client)).done).toMatchObject({
      exitCode: 1,
      message: 'stim reload did not finish within 0.5 s.',
    });
    await browser.closed;
    await until(() => readAudit().some((entry) => entry.action === 'reload'));
    expect(readAudit().find((entry) => entry.action === 'reload')?.error?.message).toBe('STIM_RELOAD_TIMEOUT');
    expect(browser.methods).not.toContain('Page.reload');
  });

  it('returns typed refusals and bounds the terminal output', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    await start();
    const client = await desktop();
    await client.request('desktop.reload.subscribe', { cwd: workspace, platform: 'ios' });
    const { done } = await reloaded(client);
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout)).toMatchObject({ code: 'STIM_RELOAD_STOPPED', remedy: 'Run `stim ios` first.' });
    assert(server);
    await server.close();
    server = null;
    const browser = await reloadBrowser();
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const limited = await desktop();
    await limited.request('desktop.reload.subscribe', { cwd: workspace, platform: 'web' });
    expect((await reloaded(limited)).done).toMatchObject({
      exitCode: 1,
      stdout: '',
      message: 'stim reload printed more than 1 bytes.',
    });
    expect(browser.methods).toContain('Page.reload');
  });

  it('bounds concurrent reloads per connection and releases slots after cancellation', async () => {
    const roots = [workspace, ...Array.from({ length: 4 }, (_, i) => join(root, `app-${i}`))];
    for (const cwd of roots.slice(1)) mkdirSync(cwd);
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({ projects: Object.fromEntries(roots.map((cwd) => [cwd, {}])) }),
    );
    const browsers = await Promise.all(roots.map((cwd, i) => reloadBrowser(cwd, i < 4)));
    await start({ requestLimits: { connection: 4 } });
    const client = await desktop();
    const subscriptions: string[] = [];
    for (const cwd of roots.slice(0, 4)) {
      const reply = await client.request('desktop.reload.subscribe', { cwd, platform: 'web' });
      const result: unknown = 'result' in reply ? reply.result : undefined;
      assert(isJsonObject(result) && typeof result.subscription === 'string');
      subscriptions.push(result.subscription);
    }
    await Promise.all(browsers.slice(0, 4).map((browser) => browser.attaching));
    expect(await client.request('desktop.reload.subscribe', { cwd: roots[4], platform: 'web' })).toHaveProperty(
      'error.code',
      'limit-exceeded',
    );
    for (const subscription of subscriptions) await client.request('unsubscribe', { subscription });
    await Promise.all(browsers.slice(0, 4).map((browser) => browser.closed));
    await until(() => readAudit().filter((entry) => entry.action === 'reload').length === 4);
    await client.request('desktop.reload.subscribe', { cwd: roots[4], platform: 'web' });
    expect((await reloaded(client)).done.exitCode).toBe(0);
    for (const browser of browsers.slice(0, 4)) expect(browser.methods).not.toContain('Page.reload');
  });
});

describe('action', () => {
  it('stops the registered workspace without a CLI and keeps the CLI JSON output and audit', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    const port = await start();
    const client = await authed(port, true);
    rmSync(join(root, 'fake-stim.mjs'));
    const reply = await client.request('action', { action: 'stop', workspace });
    expect(readWorkspaceState(workspace)?.launches).toBeUndefined();
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../../stim-cli/dist/cli.mjs', import.meta.url)), 'stop', '--json'],
        { cwd: workspace, env: process.env, encoding: 'utf8' },
      ),
    );
    expect(reply).toEqual({ id: expect.any(Number), result: { action: 'stop', workspace, output } });
    expect(stimCalls()).toEqual([]);
    expect(readAudit()).toEqual([
      expect.objectContaining({ action: 'stop', workspace, ok: true, durationMs: expect.any(Number) }),
    ]);
  });

  function holdConfigDuringStop(): string {
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    const lock = join(root, 'home', 'config.lock');
    mkdirSync(lock);
    return lock;
  }

  test.skipIf(process.platform === 'win32')(
    'answers another client while an Android stop waits for its device probe',
    async () => {
      const sdk = join(root, 'sdk');
      const bin = join(root, 'bin');
      const avds = join(root, 'avds');
      const avd = 'stim-delayed-fixture';
      const entered = join(root, 'probe-entered');
      const released = join(root, 'probe-released');
      const finished = join(root, 'probe-finished');
      mkdirSync(join(sdk, 'emulator'), { recursive: true });
      mkdirSync(join(sdk, 'platform-tools'));
      mkdirSync(join(avds, `${avd}.avd`), { recursive: true });
      writeFileSync(join(avds, `${avd}.ini`), `path=${join(avds, `${avd}.avd`)}\n`);
      mkdirSync(bin);
      const emulator = join(sdk, 'emulator', 'emulator');
      const adb = join(sdk, 'platform-tools', 'adb');
      const agent = join(bin, 'agent-device');
      writeFileSync(emulator, `#!${process.execPath}\nconsole.log(${JSON.stringify(avd)});\n`);
      writeFileSync(agent, `#!${process.execPath}\nconsole.log(JSON.stringify({success:true,data:{sessions:[]}}));\n`);
      writeFileSync(
        adb,
        `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(entered)}, '');
const deadline = Date.now() + 2000;
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(released)}) && Date.now() < deadline) return;
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(finished)}, '');
  console.log('List of devices attached');
}, 10);
`,
      );
      for (const tool of [emulator, adb, agent]) chmodSync(tool, 0o755);
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({
          projects: { [workspace]: { platforms: { android: { avdName: avd, owned: true } } } },
        }),
      );
      const port = await start({
        env: { ANDROID_HOME: sdk, ANDROID_AVD_HOME: avds, PATH: `${bin}:${process.env.PATH}` },
      });
      const client = await authed(port, true);
      const other = await authed(port, true);
      rmSync(join(root, 'fake-stim.mjs'));
      const stopping = client.request('action', { action: 'stop', workspace });
      try {
        await until(() => existsSync(entered));
        expect(await other.request('machine.history')).toMatchObject({ result: expect.anything() });
        expect(existsSync(finished)).toBe(false);
        writeFileSync(released, '');
        expect(await stopping).toMatchObject({ result: { action: 'stop', output: { ok: true } } });
        expect(stimCalls()).toEqual([]);
      } finally {
        writeFileSync(released, '');
        await stopping;
      }
    },
    15_000,
  );

  it('retains an unverifiable supervisor and reports a failed stop without running a CLI', async () => {
    const config = join(root, 'home', 'config.json');
    writeFileSync(config, JSON.stringify({ projects: { [workspace]: { supervisor: { pid: process.pid } } } }));
    const port = await start();
    const client = await authed(port, true);
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('unverified') },
    });
    expect(JSON.parse(readFileSync(config, 'utf8')).projects[workspace].supervisor.pid).toBe(process.pid);
    expect(stimCalls()).toEqual([]);
    expect(readAudit()).toEqual([expect.objectContaining({ action: 'stop', ok: false })]);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports the storage failure when a stop cannot update registration',
    async () => {
      const state = workspaceStateDir(workspace);
      mkdirSync(state, { recursive: true });
      const port = await start();
      const client = await authed(port, true);
      const home = join(root, 'home');
      rmSync(join(root, 'fake-stim.mjs'));
      chmodSync(home, 0o500);
      try {
        expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
          error: { code: 'action-failed', message: expect.stringContaining('EACCES') },
        });
        expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).projects[workspace]).toBeDefined();
        expect(stimCalls()).toEqual([]);
      } finally {
        chmodSync(home, 0o700);
        await createStim({ projectRoot: workspace, home }).stop();
      }
    },
  );

  it('bounds the in-process stop response by the existing action output limit', async () => {
    const port = await start({ actionLimits: { maxOutputBytes: 8 } });
    const client = await authed(port, true);
    expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
      error: { code: 'action-failed', message: 'stim stop printed more than 8 bytes.' },
    });
    expect(stimCalls()).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'reaps a SIGTERM-ignoring stop probe before server shutdown completes',
    async () => {
      const bin = join(root, 'probe-bin');
      mkdirSync(bin);
      const entered = join(root, 'probe-started');
      const escaped = join(root, 'probe-escaped');
      const probe = join(bin, 'lsof');
      writeFileSync(
        probe,
        `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
setTimeout(() => { fs.writeFileSync(${JSON.stringify(escaped)}, ''); process.exit(0); }, 15000);
`,
      );
      chmodSync(probe, 0o755);
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({ projects: { [workspace]: { metroPort: 8083 } } }),
      );
      const port = await start({ env: { PATH: `${bin}:${process.env.PATH}` }, actionLimits: { timeoutMs: 500 } });
      const client = await authed(port, true);
      const other = await authed(port, true);
      const stopping = client.request('action', { action: 'stop', workspace });
      let owned: { pid: number; processToken: string } | undefined;
      try {
        const pid = await readPid(entered);
        const processToken = captureProcessToken(pid);
        assert(processToken);
        owned = { pid, processToken };
        expect(await stopping).toMatchObject({ error: { code: 'action-failed' } });
        expect(await other.request('machine.history')).toMatchObject({ result: expect.anything() });
        assert(server);
        await server.close();
        server = null;
        expect(existsSync(escaped)).toBe(false);
        expect(alive(await readPid(entered))).toBe(false);
      } finally {
        if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
        await stopping;
      }
    },
    25_000,
  );

  it('drains a timed-out stop at shutdown while a foreign status response keeps streaming', async () => {
    let escaped = false;
    const listener = createHttpServer((_request, response) => {
      response.write('packager-status:running');
      const chunks = setInterval(() => response.write('.'), 20);
      const escape = setTimeout(() => {
        escaped = true;
        response.end();
      }, 3000);
      response.once('close', () => {
        clearInterval(chunks);
        clearTimeout(escape);
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, 'localhost', resolve));
    try {
      const address = listener.address();
      assert(address && typeof address === 'object');
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({ projects: { [workspace]: { metroPort: address.port } } }),
      );
      const port = await start({ actionLimits: { timeoutMs: 500 } });
      const client = await authed(port, true);
      expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
        error: { code: 'action-failed' },
      });
      assert(server);
      await server.close();
      server = null;
      expect(escaped).toBe(false);
      expect(listener.listening).toBe(true);
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('keeps a timed-out stop busy until cleanup drains and waits for it at server shutdown', async () => {
    const port = await start({ actionLimits: { timeoutMs: 1000 } });
    const client = await authed(port, true);
    const other = await authed(port, true);
    const lock = holdConfigDuringStop();
    let released = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = client.request('action', { action: 'stop', workspace });
      await until(() => readWorkspaceState(workspace)?.launches === undefined);
      expect(await reply).toMatchObject({
        error: { code: 'action-failed', message: 'stim stop did not finish within 1 s.' },
      });
      expect(await other.request('action', { action: 'reload', workspace })).toMatchObject({
        error: { code: 'action-busy' },
      });
      release = setTimeout(() => {
        released = true;
        rmSync(lock, { recursive: true });
      }, 50);
      const active = server;
      if (!active) throw new Error('Server was not started.');
      await active.close();
      server = null;
      expect(released).toBe(true);
      expect(stimCalls()).toEqual([]);
    } finally {
      clearTimeout(release);
      rmSync(lock, { recursive: true, force: true });
      await createStim({ projectRoot: workspace, home: join(root, 'home') }).stop();
    }
  });

  it('keeps an in-process stop running after its requesting client disconnects', async () => {
    const port = await start();
    const client = await authed(port, true);
    const other = await authed(port, true);
    const lock = holdConfigDuringStop();
    try {
      client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'stop', workspace } }));
      await until(() => readWorkspaceState(workspace)?.launches === undefined);
      client.socket.terminate();
      await client.closed;
      expect(await other.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(readAudit()).toEqual([]);
      rmSync(lock, { recursive: true });
      await until(() => readAudit().some((record) => record.action === 'stop' && record.ok));
      expect(stimCalls()).toEqual([]);
    } finally {
      rmSync(lock, { recursive: true, force: true });
      await createStim({ projectRoot: workspace, home: join(root, 'home') }).stop();
    }
  });

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

  it('advertises the actions to a control device and stops honoring them once the machine takes control back', async () => {
    const port = await start();
    const { id, keyPair } = await pair(port, undefined, true);
    const client = await connect(port, undefined, { keyPair });
    expect(await client.request('hello', { client: CLIENT })).toMatchObject({
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

  test.skipIf(process.platform === 'win32')(
    'runs an action for the Unix socket connection, which holds control without a pairing',
    async () => {
      const browser = await reloadBrowser();
      await start();
      const local = await desktop();
      expect(await local.request('action', { action: 'reload', workspace })).toMatchObject({
        result: { action: 'reload', workspace },
      });
      expect(browser.methods.filter((method) => method === 'Page.reload')).toEqual(['Page.reload']);
      expect(stimCalls()).toEqual([]);
    },
  );

  it('reloads the owned page in process and audits the requested platform', async () => {
    const browser = await reloadBrowser();
    const port = await start();
    const client = await authed(port, true);
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('action', { action: 'reload', workspace, platform: 'web' })).toEqual({
      id: 2,
      result: {
        action: 'reload',
        workspace,
        output: {
          platform: 'web',
          appId: browser.url,
          deviceId: expect.stringContaining('http://127.0.0.1:'),
          deviceName: 'Chrome',
          metroPort: null,
          strategy: 'cdp',
          targets: 1,
          reverseRestored: [],
        },
      },
    });
    await client.request('action', { action: 'reload', workspace });
    expect(browser.methods.filter((method) => method === 'Page.reload')).toHaveLength(2);
    expect(stimCalls()).toEqual([]);
    const [first] = readAudit();
    expect(first).toEqual({
      at: expect.any(String),
      device: { id: readDevices()[0]!.id, name: 'Test phone' },
      action: 'reload',
      workspace,
      platform: 'web',
      ok: true,
      durationMs: expect.any(Number),
    });
    expect(readAudit().map((record) => [record.action, record.ok])).toEqual([
      ['reload', true],
      ['reload', true],
    ]);
  });

  it('reports the API refusal with its code and remedy', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const port = await start();
    const client = await authed(port, true);
    expect(await client.request('action', { action: 'reload', workspace })).toMatchObject({
      error: {
        code: 'action-failed',
        message: 'STIM_RELOAD_STOPPED: No live app launch is recorded. Run `stim ios` or `stim android` first.',
      },
    });
    expect(readAudit()).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'action-failed' }) }),
    ]);
  });

  it('runs one action per workspace at a time and ends one that runs past its timeout', async () => {
    const browser = await reloadBrowser(workspace, true);
    const port = await start({ actionLimits: { timeoutMs: process.platform === 'win32' ? 5000 : 500 } });
    const client = await authed(port, true);
    const other = await authed(port, true);
    client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'reload', workspace } }));
    await browser.attaching;
    expect(await other.request('action', { action: 'reload', workspace })).toMatchObject({
      error: { code: 'action-busy' },
    });
    expect(await client.next()).toMatchObject({
      id: 10,
      error: { code: 'action-failed', message: expect.stringContaining('did not finish') },
    });
    await browser.closed;
    expect(browser.methods).not.toContain('Page.reload');
    expect(readAudit().map((record) => record.error?.code)).toEqual(['action-busy', 'action-failed']);
  });

  it('keeps running an action when the client disconnects', async () => {
    const browser = await reloadBrowser(workspace, true);
    const port = await start();
    const client = await authed(port, true);
    const other = await authed(port, true);
    client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'reload', workspace } }));
    await browser.attaching;
    client.socket.terminate();
    await client.closed;
    expect(await other.request('action', { action: 'reload', workspace })).toHaveProperty('error.code', 'action-busy');
    browser.release();
    await browser.closed;
    await until(() => readAudit().some((record) => record.action === 'reload' && record.ok));
    expect(browser.methods).toContain('Page.reload');
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
  if (env.FAKE_XCRUN_GATE) {
    writeFileSync(env.FAKE_XCRUN_GATE + '.' + seen + '.ready', '');
    while (!existsSync(env.FAKE_XCRUN_GATE + '.' + seen + '.release')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } else if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
if (run.args[0] !== 'simulator-options' || env.FAKE_SIMULATOR_OPTIONS) process.on('exit', record);
if (run.args[0] === 'simulator-options') {
  if (!env.FAKE_SIMULATOR_OPTIONS) process.exit(1);
  if (env.FAKE_SIMULATOR_WAIT && run.args[2] !== 'read') {
    appendFileSync(env.FAKE_TOOL_CALLS + '.option-started', String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    const options = JSON.parse(env.FAKE_SIMULATOR_OPTIONS);
    if (run.args[2] === 'slow-animations') options.slowAnimations = run.args[3] === 'on';
    process.stdout.write(JSON.stringify(options));
    process.exit(0);
  }
}
process.on('SIGTERM', () => process.exit(0));
const message = (kind, body) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = kind;
  process.stdout.write(Buffer.concat([header, body]));
};
if (env.FAKE_HELPER_KEYBOARD) message(2, Buffer.from(JSON.stringify({ keyboard: env.FAKE_HELPER_KEYBOARD })));
if (env.FAKE_HELPER_STALLED) message(2, Buffer.from(JSON.stringify({ stalled: env.FAKE_HELPER_STALLED })));
if (run.args[0] === 'macos') {
  for (const windows of [env.FAKE_HELPER_MACOS_WINDOWS, env.FAKE_HELPER_MACOS_WINDOWS_MALFORMED]) {
    if (windows) message(2, Buffer.from(JSON.stringify({ macosWindows: JSON.parse(windows) })));
  }
}
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
    if (line.input && env.FAKE_HELPER_INPUTS) appendFileSync(env.FAKE_HELPER_INPUTS, JSON.stringify(line) + '\\n');
    if (line.keyframe) keyframe = true;
    else if (line.recordKeyframe) recordKeyframe = true;
    else if (!line.input) {
      const wantsArtwork = !config.deviceFrame && line.deviceFrame;
      config = line;
      if (wantsArtwork && env.FAKE_HELPER_ARTWORK) message(2, Buffer.from(JSON.stringify({ deviceFrame: JSON.parse(env.FAKE_HELPER_ARTWORK) })));
    }
    lines = lines.slice(at + 1);
  }
});
process.stdin.on('end', () => process.exit(0));
let sent = 0;
const displays = JSON.parse(env.FAKE_HELPER_DISPLAYS ?? '[]');
setInterval(() => {
  if (typeof displays[sent] === 'number') message(2, Buffer.from(JSON.stringify({ display: displays[sent] })));
  if (config.duoFrame && env.FAKE_HELPER_DUO) {
    const metadata = Buffer.from(env.FAKE_HELPER_DUO);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(metadata.length);
    message(6, Buffer.concat([size, metadata, Buffer.from('composed ' + sent)]));
  }
  if (config.video) {
    const header = Buffer.alloc(13);
    header[0] = (keyframe ? 1 : 0) | (env.FAKE_HELPER_ARTWORK ? 32 | (2 << 3) : 0);
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
  message(env.FAKE_HELPER_ARTWORK ? 5 : 1, Buffer.concat([size, ...(env.FAKE_HELPER_ARTWORK ? [Buffer.from([2])] : []), Buffer.from('frame ' + sent++)]));
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

const OWNED_MACOS = {
  launchId: 'LAUNCH-1',
  product: 'MyApp',
  arguments: [],
  bundle: '/stim/macos/MyApp.app',
  bundleId: 'dev.myapp.stim.workspace',
  executable: '/stim/macos/MyApp.app/Contents/MacOS/MyApp',
  state: 'running',
  build: { state: 'ok', startedAt: '2026-10-04T12:00:00Z' },
  app: { pid: 4242, startedAtMicros: 123456, processToken: 'owned-process' },
};

describe('frames.subscribe', () => {
  it('preserves only the trusted AVD name when an attached emulator status becomes unknown', () => {
    const target = { workspace, platform: 'android' as const };
    const payload = (name: string) =>
      statusPayload({
        android: { name, owned: true, physical: false, serial: null, state: 'unknown' },
      }) as StatusPayload;
    expect(ownedDevice(payload('stim-app'), target, 'android:emulator-5554')).toEqual({
      platform: 'android',
      serial: 'emulator-5554',
      avdName: 'stim-app',
    });
    expect(ownedDevice(payload('../other-avd'), target, 'android:emulator-5554')).toEqual({
      platform: 'android',
      serial: 'emulator-5554',
    });
    expect(ownedDevice(payload('stim-app'), target, null)).toBeTypeOf('string');
  });
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
      const gate = join(root, 'capture-gate');
      const realSetTimeout = setTimeout;
      const ready = async (capture: number) => {
        const file = `${gate}.${capture}.ready`;
        for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((resolve) => realSetTimeout(resolve, 10));
        expect(existsSync(file)).toBe(true);
      };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: JSON.stringify([a, b].map((bytes) => bytes.toString('base64'))),
          FAKE_XCRUN_DELAYS: JSON.stringify([200, 600, 20]),
          FAKE_XCRUN_DELAY_COUNTER: join(root, 'xcrun-delay-counter'),
          FAKE_XCRUN_GATE: gate,
        },
        { toolTimeoutMs: 400, slowCaptureMs: 150, failureBackoffMs: 100, maxConsecutiveFailures: 3 },
      );
      const client = await authed(port);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        await client.request('frames.subscribe', { workspace, platform: 'ios' });
        await ready(0);
        await vi.advanceTimersByTimeAsync(200);
        writeFileSync(`${gate}.0.release`, '');
        expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
        expect(await client.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
        await vi.advanceTimersByTimeAsync(200);
        await ready(1);
        await vi.advanceTimersByTimeAsync(400);
        const retained = await authed(port);
        await retained.request('frames.subscribe', { workspace, platform: 'ios' });
        expect(await retained.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
        expect(await retained.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
        await vi.advanceTimersByTimeAsync(100);
        await ready(2);
        await vi.advanceTimersByTimeAsync(20);
        writeFileSync(`${gate}.2.release`, '');
        let recovered = false;
        let changed = false;
        while (!recovered || !changed) {
          const message = await client.next();
          if ('event' in message && message.event === 'frame-delayed') {
            expect(message).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
            recovered = true;
          } else {
            expect(message).toMatchObject({ event: 'frame', data: b.toString('base64') });
            changed = true;
          }
        }
        expect(toolRuns().filter((run) => run.tool === 'xcrun').length).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
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
    'routes composed Duo images and their pose together without replacing raw subscribers',
    async () => {
      const pose = { revision: '16ef79a2-5cef-4cdb-b5e9-ab09ef0722d2', screenID: 10, angle: 76, orientation: 3 };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-test (iPhone Duo 27.1)' } }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_DUO: JSON.stringify({ width: 800, height: 600, ...pose }),
        },
        undefined,
        fakeHelper(),
      );
      const plain = await authed(port);
      await plain.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await plain.next()).toMatchObject({ event: 'frame', width: 390, height: 844 });
      const composed = await authed(port);
      expect(
        await composed.request('frames.subscribe', { workspace, platform: 'ios', duoFrame: true, video: ['h264'] }),
      ).toMatchObject({ result: { subscription: 's1' } });
      let shown = await composed.next();
      while ('event' in shown && shown.event === 'frame' && !shown.duo) shown = await composed.next();
      expect(shown).toMatchObject({ event: 'frame', width: 800, height: 600, duo: pose });
      expect(Buffer.from((shown as { data: string }).data, 'base64').toString()).toMatch(/^composed /);
      const raw = await plain.next();
      expect(raw).toMatchObject({ event: 'frame', width: 390, height: 844 });
      expect(raw).not.toHaveProperty('duo');
      expect(Buffer.from((raw as { data: string }).data, 'base64').toString()).toMatch(/^frame /);
      const cached = await authed(port);
      await cached.request('frames.subscribe', { workspace, platform: 'ios', duoFrame: true });
      expect(await cached.next()).toMatchObject({ event: 'frame', duo: pose });
      expect(
        await cached.request('frames.subscribe', { workspace, platform: 'android', duoFrame: true }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      for (const client of [plain, composed, cached]) client.socket.close();
    },
  );

  test.skipIf(!fakeTailscale)(
    'sends cached installed artwork only to opt-in read subscribers and preserves guest bytes',
    async () => {
      const artwork = {
        width: 450,
        height: 900,
        aperture: { x: 30, y: 20, width: 390, height: 844 },
        cornerRadius: 12,
        quarterTurns: 2,
        background: 'png-bg',
        foreground: 'png-fg',
      };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_ARTWORK: JSON.stringify(artwork),
        },
        undefined,
        fakeHelper(),
      );
      const framed = await authed(port);
      await framed.request('frames.subscribe', { workspace, platform: 'ios', deviceFrame: true });
      expect(await framed.next()).toMatchObject({ event: 'device-frame', artwork: null });
      expect(await framed.next()).toMatchObject({ event: 'device-frame', artwork });
      const captured = await framed.next();
      expect(captured).toMatchObject({ event: 'frame', width: 390, height: 844, artworkTurns: 2 });
      expect(Buffer.from((captured as { data: string }).data, 'base64').toString()).toMatch(/^frame /);
      const plain = await authed(port);
      await plain.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await plain.next()).toMatchObject({ event: 'frame' });
      const again = await authed(port);
      await again.request('frames.subscribe', { workspace, platform: 'ios', deviceFrame: true });
      expect(await again.next()).toMatchObject({ event: 'device-frame', artwork: null });
      expect(await again.next()).toMatchObject({ event: 'device-frame', artwork });
      expect(
        await again.request('frames.subscribe', { workspace: '/not-registered', platform: 'ios', deviceFrame: true }),
      ).toMatchObject({ error: { code: 'unknown-workspace' } });
      const video = await authed(port);
      await video.request('frames.subscribe', { workspace, platform: 'ios', deviceFrame: true, video: ['h264'] });
      expect(await video.next()).toMatchObject({ event: 'device-frame', artwork: null });
      expect(await video.next()).toMatchObject({ event: 'device-frame', artwork });
      const packet = ((await video.next()) as unknown as { binary: Buffer }).binary;
      expect(packet[1]! & 56).toBe(32 | (2 << 3));
      expect(packet.subarray(packet.readUInt16BE(2), packet.readUInt16BE(2) + 4)).toEqual(Buffer.from([0, 0, 0, 1]));
      video.socket.close();
      framed.socket.close();
      plain.socket.close();
      again.socket.close();
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'routes hosted macOS frames and native input without local viewer permission setup',
    async () => {
      const captureHelper = fakeHelper();
      writeFileSync(
        captureHelper,
        readFileSync(captureHelper, 'utf8').replace('run.configs.push(line);', 'run.configs.push(line); record();'),
      );
      const port = await startWithTools({ FAKE_STIM_PAYLOADS: '[]' }, undefined, captureHelper);
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
        import {writeFileSync} from 'node:fs';import {join} from 'node:path';
        const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks));
        const device={architecture:'arm64',macosVersion:'27.0',appSlot:input.appSlot};
        if(input.mode==='prepare')writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
        process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
      `,
      );
      const pending = setupClient(['device-host'], 'Hosting Mac client');
      const client = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      const reserved = await client.request('device-host.reserve', {
        workspace: '/client/not-worker-registered',
        slot: 'default',
        platform: 'macos',
        attempt: 'hosted-macos-view',
      });
      if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
      const session = (reserved.result as { id: string }).id;
      await vi.waitFor(async () =>
        expect(await client.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      const appProcess = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      try {
        const appAttempt = 'app-first';
        const area = join(deviceHostArea(session), 'apps', appAttempt);
        const workerHome = join(deviceHostArea(session), 'home');
        const bundle = join(area, 'App.app');
        mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
        const executable = join(bundle, 'Contents', 'MacOS', 'Fixture');
        writeFileSync(executable, 'fixture');
        mkdirSync(join(workerHome, 'macos-app'));
        const state = join(workerHome, 'workspaces', workspaceName(realpathSync(join(workerHome, 'macos-app'))));
        mkdirSync(state, { recursive: true });
        const appStart = processStartMicros(appProcess.pid!);
        const processToken = captureProcessToken(appProcess.pid!);
        if (appStart.status !== 'running' || !processToken) throw new Error('Cannot identify fake macOS app');
        const identity = { pid: appProcess.pid!, processToken, startedAtMicros: appStart.startedAtMicros };
        const bundleId = 'dev.stim.fixture.hosted1';
        writeFileSync(
          join(state, 'state.json'),
          JSON.stringify({
            macos: {
              launchId: 'launch-1',
              arguments: [],
              product: 'Fixture',
              bundle,
              bundleId,
              executable,
              build: { state: 'ok', startedAt: new Date().toISOString() },
              app: identity,
              supervisor: identity,
            },
          }),
        );
        writeFileSync(join(workerHome, 'hosted-macos-app.json'), JSON.stringify({ bundleId }));
        writeFileSync(
          join(area, 'receipt.json'),
          JSON.stringify({
            session,
            attempt: appAttempt,
            bundleId: 'dev.stim.fixture',
            mode: 'release',
            manifest: { size: 1, sha256: 'a'.repeat(64) },
            state: 'installed',
            launched: true,
          }),
        );
        const journal = join(deviceHostRoot(), 'sessions.json');
        const stored = JSON.parse(readFileSync(journal, 'utf8'));
        stored.sessions[0].appAttempt = appAttempt;
        writeFileSync(journal, JSON.stringify(stored));
        expect(await client.request('device-host.frames.subscribe', { session, at: 1 })).toHaveProperty(
          'error.code',
          'bad-request',
        );
        expect(await client.request('device-host.frames.subscribe', { session })).toHaveProperty(
          'result.subscription',
          's1',
        );
        expect(await client.next()).toMatchObject({ event: 'frame', subscription: 's1', platform: 'macos' });
        expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toHaveProperty(
          'nativeViewerOpened',
          false,
        );
        const begun = await client.request('device-host.control.begin', { session });
        if (!('result' in begun)) throw new Error(JSON.stringify(begun));
        const controlSession = (begun.result as { session: string }).session;
        expect(
          await client.request('device-host.input.scroll', {
            session: controlSession,
            x: 0.25,
            y: 0.75,
            deltaX: -5,
            deltaY: 10,
          }),
        ).toHaveProperty('result');
        expect(
          await client.request('device-host.input.key', { session: controlSession, key: 'a', modifiers: ['command'] }),
        ).toHaveProperty('result');
        expect(await client.request('device-host.input.window', { session: controlSession, window: 7 })).toHaveProperty(
          'result',
        );
        expect(
          await client.request('device-host.input.window', { session: controlSession, window: null }),
        ).toHaveProperty('result');
        expect(
          await client.request('device-host.input.key', { session: controlSession, key: 'invalid' }),
        ).toHaveProperty('error.code', 'bad-request');
        expect(
          await client.request('device-host.input.scroll', {
            session: controlSession,
            x: 2,
            y: 0,
            deltaX: 0,
            deltaY: 0,
          }),
        ).toHaveProperty('error.code', 'bad-request');
        await vi.waitFor(() => {
          const configs = helperRuns().flatMap((run) => run.configs);
          expect(configs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ input: 'scroll', deltaX: -5, deltaY: 10 }),
              expect.objectContaining({ input: 'key', key: 'a', modifiers: ['command'] }),
              expect.objectContaining({ input: 'window', window: 7, controlSession: expect.any(String) }),
              expect.objectContaining({ input: 'window', window: null, controlSession: expect.any(String) }),
            ]),
          );
          const args = helperRuns()[0]!.args;
          expect(args[0]).toBe('macos');
          expect(JSON.parse(args[1]!)).toMatchObject({ bundleId, app: { pid: appProcess.pid } });
        });
        expect(await client.request('device-host.stop', { session })).toHaveProperty('result.state', 'stopping');
        await vi.waitFor(async () =>
          expect(await client.request('device-host.attach', { session })).toHaveProperty('result.state', 'stopped'),
        );
      } finally {
        appProcess.kill('SIGKILL');
        await new Promise<void>((resolve) => appProcess.once('exit', () => resolve()));
      }
    },
  );

  test.skipIf(!fakeTailscale)(
    'streams and controls only the hosting client session and closes its capture before native stop',
    async () => {
      const captureHelper = fakeHelper();
      writeFileSync(
        captureHelper,
        readFileSync(captureHelper, 'utf8')
          .replace("process.on('SIGTERM', () => process.exit(0));", "process.on('SIGTERM', () => {});")
          .replace("process.stdin.on('end', () => process.exit(0));", "process.stdin.on('end', () => {});")
          .replace('run.configs.push(line);', 'run.configs.push(line); record();'),
      );
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }) },
        undefined,
        captureHelper,
      );
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
        import { writeFileSync, readFileSync, existsSync } from 'node:fs';
        import { delimiter, dirname, join } from 'node:path';
        const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks));
        const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
        const home=process.env.STIM_HOME;
        if(input.mode==='prepare') {
          writeFileSync(join(home,'hosted-device.json'),JSON.stringify(device));
          writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
        } else {
          const file=process.env.FAKE_TOOL_CALLS+'.started';
          const pids=existsSync(file)?readFileSync(file,'utf8').trim().split(/\\s+/).filter(Boolean).map(Number):[];
          if(pids.some(pid=>{try{process.kill(pid,0);return true;}catch{return false;}})) {
            process.stdout.write(JSON.stringify({state:'unknown',device,notice:'capture still running'}));
            process.exit(0);
          }
        }
        process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
      `,
      );
      const pending = setupClient(['device-host'], 'Hosting client');
      const open = () => returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      const first = await open();
      const observerIdentity = await pair(port);
      const observer = await returning(port, observerIdentity.keyPair);
      const reserved = await first.request('device-host.reserve', {
        workspace: '/client/not-worker-registered',
        slot: 'phone',
        platform: 'ios',
        attempt: 'hosted-view',
      });
      if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
      const session = (reserved.result as { id: string }).id;
      await vi.waitFor(async () =>
        expect(await first.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      expect(await first.request('frames.subscribe', { workspace, platform: 'ios' })).toHaveProperty(
        'error.code',
        'forbidden',
      );
      expect(await first.request('device-host.frames.subscribe', { session, at: 1 })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(await first.request('device-host.frames.subscribe', { session, fps: 5 })).toHaveProperty(
        'result.subscription',
        's1',
      );
      expect(await first.next()).toMatchObject({ event: 'frame', subscription: 's1', platform: 'ios', slot: 'phone' });
      expect(await first.request('device-host.frames.subscribe', { session, video: ['h264'] })).toMatchObject({
        result: { subscription: 's2', video: 'h264' },
      });
      let streamed = await first.next();
      while (!('binary' in streamed)) streamed = await first.next();
      expect(await first.request('device-host.frames.keyframe', { subscription: 's2' })).toHaveProperty('result');
      expect(await first.request('device-host.frames.congested', { subscription: 's1' })).toHaveProperty(
        'error.code',
        'unknown-subscription',
      );
      expect(await first.request('device-host.frames.congested', { subscription: 's2' })).toHaveProperty('result');
      await vi.waitFor(() =>
        expect(helperRuns().flatMap((run) => run.configs)).toContainEqual(
          expect.objectContaining({ video: true, bitrate: 1_500_000 }),
        ),
      );
      expect(await first.request('device-host.unsubscribe', { subscription: 's2' })).toHaveProperty('result');
      const claimRoot = join(deviceHostRoot(), `${session}.claims`);
      const helper = readClaimSet(claimRoot).live[0]!.child;
      expect(helper).not.toBeNull();
      expect(alive(helper!.pid)).toBe(true);
      const began = await first.request('device-host.control.begin', { session });
      if (!('result' in began)) throw new Error(JSON.stringify(began));
      const controlSession = (began.result as { session: string }).session;
      expect(began).toHaveProperty('result.lease', null);
      expect(
        await first.request('device-host.input.touch', { session: controlSession, phase: 'down', x: 0, y: 1 }),
      ).toHaveProperty('result');
      expect(
        await first.request('device-host.input.touch', { session: controlSession, phase: 'up', x: 0, y: 1 }),
      ).toHaveProperty('result');
      const sameClient = await open();
      expect(await sameClient.request('device-host.control.begin', { session })).toHaveProperty(
        'error.code',
        'device-busy',
      );
      expect(
        await sameClient.request('device-host.input.touch', { session: controlSession, phase: 'down', x: 1, y: 0 }),
      ).toHaveProperty('error.code', 'unknown-session');
      const other = setupClient(['device-host'], 'Other client');
      const foreign = await returning(port, other.keyPair, '100.64.0.3', 'device-host');
      expect(await foreign.request('device-host.frames.subscribe', { session })).toHaveProperty(
        'error.code',
        'action-failed',
      );
      revokeDevice(observerIdentity.id);
      await observer.closed;
      expect(
        await first.request('device-host.input.touch', { session: controlSession, phase: 'move', x: 0.5, y: 0.5 }),
      ).toHaveProperty('result');
      first.socket.close();
      await first.closed;
      await until(() => !alive(helper!.pid));
      expect(await sameClient.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready');
      expect(await sameClient.request('device-host.frames.subscribe', { session })).toHaveProperty(
        'result.subscription',
        's1',
      );
      expect(await sameClient.next()).toMatchObject({ event: 'frame', subscription: 's1', slot: 'phone' });
      const replacement = readClaimSet(claimRoot).live[0]!.child;
      expect(replacement!.pid).not.toBe(helper!.pid);
      expect(await sameClient.request('device-host.stop', { session })).toHaveProperty('result.state', 'stopping');
      await vi.waitFor(
        async () =>
          expect(await sameClient.request('device-host.attach', { session })).toHaveProperty('result.state', 'stopped'),
        { timeout: 4000 },
      );
      expect(alive(replacement!.pid)).toBe(false);
      expect(readClaimSet(claimRoot).live).toEqual([]);
      const captures = [...new Map(helperRuns().map((run) => [run.pid, run])).values()];
      expect(captures.map((run) => run.args)).toEqual([
        ['ios', '12345678-1234-1234-1234-123456789abc'],
        ['ios', '12345678-1234-1234-1234-123456789abc'],
      ]);
      expect(captures[0]!.configs).toEqual(
        expect.arrayContaining([
          { input: 'touch', phase: 'down', x: 0, y: 1, display: 0 },
          { input: 'touch', phase: 'up', x: 0, y: 1, display: 0 },
        ]),
      );
    },
    10_000,
  );

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

  test.each([undefined, false, true])(
    'streams a verified native app to a read-only phone without control, replay or device tools (pinned: %s)',
    { skip: !fakeTailscale, timeout: 10_000 },
    async (pinned) => {
      const windows = [
        { id: 12, title: 'MyApp', frame: { x: -100, y: 20, width: 800, height: 600 } },
        { id: 13, title: '', frame: { x: 100, y: -20, width: 400, height: 300 } },
      ];
      const macosWindows = { current: windows[0], windows, pinned: pinned ?? false };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ macos: OWNED_MACOS }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_INTERVAL_MS: '10',
          FAKE_HELPER_MACOS_WINDOWS: JSON.stringify({ ...macosWindows, pinned }),
          FAKE_HELPER_MACOS_WINDOWS_MALFORMED: JSON.stringify(
            pinned === undefined
              ? { current: null, windows: [{ id: -1 }] }
              : { current: null, windows: [], pinned: 'yes' },
          ),
        },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      expect(await client.request('frames.subscribe', { workspace, platform: 'macos', video: ['h264'] })).toMatchObject(
        { result: { video: 'h264' } },
      );
      const event = await client.next();
      expect(event).toEqual({ event: 'macos-windows', subscription: 's1', ...macosWindows });
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      validator.addSchema(protocolJsonSchema(), 'protocol');
      const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
      expect(acceptsEvent(event)).toBe(true);
      expect(
        acceptsEvent({ event: 'macos-windows', subscription: 's1', current: null, windows: [], pinned: false }),
      ).toBe(true);
      expect(acceptsEvent({ event: 'macos-windows', subscription: 's1', current: null, windows: [] })).toBe(false);
      expect(acceptsEvent({ ...event, pinned: 'yes' })).toBe(false);
      expect(await client.next()).toHaveProperty('binary');
      const again = await authed(port);
      expect(await again.request('frames.subscribe', { workspace, platform: 'macos', video: ['h264'] })).toMatchObject({
        result: { subscription: 's1', video: 'h264' },
      });
      expect(await again.next()).toEqual({ event: 'macos-windows', subscription: 's1', ...macosWindows });
      expect(await again.next()).toHaveProperty('binary');
      expect(await client.request('control.begin', { workspace, platform: 'macos' })).toMatchObject({
        error: { code: 'forbidden' },
      });
      expect(await client.request('replay.range', { workspace, platform: 'macos' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      client.socket.close();
      again.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['macos', JSON.stringify(OWNED_MACOS)]);
      expect(toolRuns().filter((run) => run.tool === 'xcrun' || run.tool === 'adb')).toEqual([]);
      expect(readViewedDevices()).toEqual([]);
    },
  );

  test.skipIf(!fakeTailscale)(
    'controls only an owned native app session and keeps its view alive after an input permission refusal',
    async () => {
      const helper = fakeHelper();
      writeFileSync(
        helper,
        readFileSync(helper, 'utf8')
          .replace('else config = line;', 'else if (!line.input && !line.control) config = line;')
          .replace(
            'run.configs.push(line);',
            `run.configs.push(line); record();
          if (line.input === 'key' && line.key === 'escape') message(2, Buffer.from(JSON.stringify({ inputError: 'Control needs existing Accessibility permission.', controlSession: line.controlSession })));
          const enabled = run.configs.filter(c => c.control?.enabled);
          if (line.input === 'key' && line.key === 'a' && enabled.length > 1) message(2, Buffer.from(JSON.stringify({ inputError: 'Delayed failure from old controller.', controlSession: enabled[0].control.session })));`,
          ),
      );
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({
            macos: OWNED_MACOS,
            android: {
              ...OWNED_EMULATOR,
              activity: { state: 'driven', driver: { tool: 'agent-device', pid: 42, since: null }, basis: [] },
            },
          }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        helper,
      );
      const client = await authed(port, true);
      const observerIdentity = await pair(port);
      const observer = await returning(port, observerIdentity.keyPair);
      const viewed = await observer.request('frames.subscribe', { workspace, platform: 'macos' });
      const begun = await client.request('control.begin', { workspace, platform: 'macos' });
      expect(begun).toMatchObject({ result: { platform: 'macos', lease: null, postures: [] } });
      const { session } = (begun as { result: { session: string } }).result;
      const other = await authed(port, true);
      expect(await other.request('control.begin', { workspace, platform: 'macos' })).toHaveProperty(
        'error.code',
        'device-busy',
      );
      expect(await other.request('input.text', { session, text: 'wrong connection' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 })).toHaveProperty('result');
      expect(await client.request('input.text', { session, text: 'native' })).toHaveProperty('result');
      expect(await client.request('input.scroll', { session, x: 0.5, y: 0.5, deltaX: 0, deltaY: -30 })).toHaveProperty(
        'result',
      );
      expect(await client.request('input.scroll', { session, x: 0.5, y: 0.5, deltaX: 0, deltaY: 1001 })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(
        await client.request('input.key', { session, key: 'a', modifiers: ['command', 'command'] }),
      ).toHaveProperty('error.code', 'bad-request');
      expect(await client.request('input.key', { session, key: 'space', modifiers: ['command'] })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(await client.request('input.key', { session, key: 'q', modifiers: ['command'] })).toHaveProperty('result');
      expect(await client.request('input.key', { session, key: '7', modifiers: ['shift'] })).toHaveProperty('result');
      expect(await client.request('input.key', { session, key: 'a', modifiers: ['command'] })).toHaveProperty('result');
      expect(await client.request('input.window', { session, window: 12 })).toHaveProperty('result');
      expect(await client.request('input.window', { session, window: null })).toHaveProperty('result');
      for (const window of [undefined, -1, 0x100000000, 1.5, '12'])
        expect(await client.request('input.window', { session, window })).toHaveProperty('error.code', 'bad-request');
      for (const [method, params] of [
        ['input.rotate', { direction: 'left' }],
        ['input.button', { button: 'home' }],
        ['input.simulator', { action: 'shake' }],
      ]) {
        expect(await client.request(method as string, { session, ...(params as object) })).toHaveProperty(
          'error.code',
          'bad-request',
        );
      }
      const ended = client.next();
      expect(await client.request('input.key', { session, key: 'escape' })).toHaveProperty('result');
      expect(await ended).toMatchObject({ reason: 'failed', message: expect.stringContaining('Accessibility') });
      expect(await client.request('input.text', { session, text: 'after refusal' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(
        await new Promise((resolve) => observer.socket.once('message', (raw) => resolve(JSON.parse(raw.toString())))),
      ).toMatchObject({ subscription: (viewed as { result: { subscription: string } }).result.subscription });
      expect(lockCalls()).toEqual([]);
      const sent = helperRuns().at(-1)!.configs;
      const active = sent.find((entry) => entry.control && (entry.control as { enabled: boolean }).enabled)!
        .control as { session: string };
      expect(sent.filter((entry) => entry.input).map((entry) => entry.controlSession)).toEqual(
        Array(9).fill(active.session),
      );
      expect(sent.filter((entry) => entry.input === 'window')).toEqual([
        { input: 'window', window: 12, controlSession: active.session },
        { input: 'window', window: null, controlSession: active.session },
      ]);
      const resumed = await client.request('control.begin', { workspace, platform: 'macos' });
      const next = (resumed as { result: { session: string } }).result.session;
      expect(await client.request('input.key', { session: next, key: 'a', modifiers: ['command'] })).toHaveProperty(
        'result',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        await client.request('input.text', { session: next, text: 'new controller survives old notice' }),
      ).toHaveProperty('result');
      other.socket.close();
      observer.socket.close();
      client.socket.close();
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'preserves a native capture permission failure without a screenshot fallback',
    async () => {
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ macos: OWNED_MACOS }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_FAIL: 'Screen Recording access is unavailable',
        },
        undefined,
        fakeHelper(),
      );
      const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(before).toHaveProperty('nativeViewerOpened', false);
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'macos' });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('Screen Recording access is unavailable') },
      });
      const after = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(after).toHaveProperty('nativeViewerOpened', true);
      expect(toolRuns().filter((run) => run.tool === 'xcrun' || run.tool === 'adb')).toEqual([]);
    },
    10_000,
  );

  test.each([{ state: 'stopped' }, { state: 'unverified' }, { app: undefined }])(
    'refuses native windows without a verified running process: %j',
    async (extra) => {
      if (!fakeTailscale) return;
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ macos: { ...OWNED_MACOS, ...extra } }), FAKE_FRAMES: '[]' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'macos' });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('No verified owned macOS app') },
      });
      expect(helperRuns()).toEqual([]);
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toHaveProperty('nativeViewerOpened', false);
    },
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
    hostedRelay?: ServerOptions['hostedRelay'],
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
      hostedRelay,
    });
  }

  function lockCalls(): string[] {
    return stimCalls()
      .map((call) => call.args)
      .filter((args) => args.startsWith('device '));
  }

  test.skipIf(!fakeTailscale)(
    'preserves the displayed Duo revision and releases its gesture while read subscribers remain',
    async () => {
      const inputs = join(root, 'duo-inputs.ndjson');
      const port = await startControl({
        FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-test (iPhone Duo 27.1)' } }),
        FAKE_HELPER_INPUTS: inputs,
      });
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios' });
      await viewer.next();
      const driver = await authed(port, true);
      const begun = await driver.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session } = begun.result as { session: string };
      const revision = '16ef79a2-5cef-4cdb-b5e9-ab09ef0722d2';
      const touch = { session, phase: 'down', x: 0.25, y: 0.75, duoRevision: revision };
      expect(await driver.request('input.touch', { ...touch, duoRevision: 'unbound' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await driver.request('input.touch', { ...touch, display: 0 })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await driver.request('input.touch', touch)).toMatchObject({ result: {} });
      driver.socket.close();
      await driver.closed;
      const commands = () =>
        existsSync(inputs)
          ? readFileSync(inputs, 'utf8')
              .split('\n')
              .slice(0, -1)
              .map((line) => JSON.parse(line))
          : [];
      await until(() => commands().some((command) => command.input === 'duo-release'));
      expect(commands()).toEqual([
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, duoRevision: revision },
        { input: 'duo-release' },
      ]);
      expect(alive(await readPid(`${toolCalls}.started`))).toBe(true);
      expect(await viewer.next()).toMatchObject({ event: 'frame' });
      viewer.socket.close();
    },
  );

  test.skipIf(!fakeTailscale)(
    'changes only advertised simulator options under the current control session',
    async () => {
      const port = await startControl({
        FAKE_SIMULATOR_OPTIONS: JSON.stringify({ canShake: true, slowAnimations: false }),
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, simulator } = begun.result as { session: string; simulator: unknown };
      expect(simulator).toEqual({ canShake: true, slowAnimations: false });
      expect(
        await client.request('input.simulator', { session, action: 'slow-animations', enabled: true }),
      ).toMatchObject({ result: { canShake: true, slowAnimations: true } });
      expect(await client.request('input.simulator', { session, action: 'shake', enabled: true })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(
        await client.request('input.simulator', { session, action: 'slow-animations', enabled: 'true' }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      expect(await client.request('input.simulator', { session, action: 'shake' })).toMatchObject({
        result: { canShake: true },
      });
      const stranger = await authed(port, true);
      expect(await stranger.request('input.simulator', { session, action: 'shake' })).toMatchObject({
        error: { code: 'unknown-session' },
      });
      expect(
        toolRuns()
          .filter((run) => run.args[0] === 'simulator-options')
          .map((run) => run.args.slice(2)),
      ).toEqual([['read'], ['slow-animations', 'on'], ['shake']]);
    },
  );

  test.skipIf(!fakeTailscale)(
    'hides unavailable simulator controls and refuses a mutation without capability',
    async () => {
      const port = await startControl({
        FAKE_SIMULATOR_OPTIONS: JSON.stringify({ canShake: false, slowAnimations: null }),
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session } = begun.result as { session: string };
      expect(await client.request('input.simulator', { session, action: 'shake' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(
        await client.request('input.simulator', { session, action: 'slow-animations', enabled: true }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      expect(toolRuns().filter((run) => run.args[0] === 'simulator-options')).toHaveLength(1);
    },
  );

  test.skipIf(!fakeTailscale)('stops a pending simulator option when its control session ends', async () => {
    const port = await startControl({
      FAKE_SIMULATOR_OPTIONS: JSON.stringify({ canShake: true, slowAnimations: false }),
      FAKE_SIMULATOR_WAIT: '1',
    });
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    if (!('result' in begun)) throw new Error(JSON.stringify(begun));
    const { session } = begun.result as { session: string };
    const pending = client.request('input.simulator', { session, action: 'slow-animations', enabled: true });
    let pid = 0;
    await until(() => {
      if (!existsSync(`${toolCalls}.option-started`)) return false;
      pid = Number(readFileSync(`${toolCalls}.option-started`, 'utf8'));
      return Number.isSafeInteger(pid) && pid > 0;
    });
    expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
    expect(await pending).toMatchObject({ error: { code: 'action-failed' } });
    expect(() => process.kill(pid, 0)).toThrow('ESRCH');
  });

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
      expect(await client.request('input.window', { session, window: null })).toMatchObject({
        error: { code: 'bad-request' },
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

  test.skipIf(!fakeTailscale)(
    'isolates two hosts returning c1 from each other and from local c1',
    async () => {
      const hosts: WebSocketServer[] = [];
      const hostKeys: string[] = [];
      const seen: { method: string; params: Record<string, unknown> }[][] = [[], []];
      const sessions = ['12345678-1234-1234-1234-123456789abc', '12345678-1234-1234-1234-123456789def'];
      const paths = [join(root, 'hosted-a'), join(root, 'hosted-b')];
      try {
        for (const [index, session] of sessions.entries()) {
          const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
          hosts.push(host);
          await new Promise<void>((resolve, reject) => {
            host.once('listening', resolve);
            host.once('error', reject);
          });
          const hostKey = generateNoiseKeyPair();
          hostKeys.push(hostKey.publicKey.toString('base64url'));
          host.on('connection', (raw) =>
            raw.once('message', async (first, isBinary) => {
              const { socket } = await acceptNoise(raw, first, isBinary, {
                keyPair: hostKey,
                psk: () => null,
                timeoutMs: 5000,
              });
              socket.on('message', (data: Buffer) => {
                const request = JSON.parse(data.toString()) as {
                  id: number;
                  method: string;
                  params: Record<string, unknown>;
                };
                seen[index]!.push(request);
                let result: Record<string, unknown> = {};
                if (request.method === 'hello') {
                  if (request.params.access !== 'device-host') return socket.close();
                  result = { capabilities: ['device-host'] };
                } else if (request.method === 'device-host.control.begin') {
                  if (request.params.session !== session) return socket.close();
                  result = { session: 'c1', platform: 'macos', lease: null, postures: [] };
                } else if (request.params.session !== 'c1') return socket.close();
                socket.send(JSON.stringify({ id: request.id, result }));
              });
            }),
          );
          const path = paths[index]!;
          mkdirSync(path);
          mkdirSync(workspaceStateDir(path), { recursive: true });
          writeFileSync(
            join(workspaceStateDir(path), 'state.json'),
            JSON.stringify({
              macos: {
                ...OWNED_MACOS,
                app: undefined,
                host: {
                  machine: `mini-${index}`,
                  session,
                  appSlot: 1,
                  appAttempt: 'app',
                  bundleId: 'com.app.hosted1',
                  agent: { driver: 'none', setting: 'hosting.agentDriver' },
                },
              },
            }),
          );
        }
        writeFileSync(
          join(process.env.STIM_HOME!, 'config.json'),
          JSON.stringify({ projects: { [workspace]: {}, [paths[0]!]: {}, [paths[1]!]: {} } }),
        );
        writeFileSync(
          join(process.env.STIM_HOME!, 'device-host-machines.json'),
          JSON.stringify({
            version: 2,
            machines: sessions.map((_, index) => ({
              machine: `mini-${index}`,
              transport: 'tailscale',
              address: `mini-${index}.tail.ts.net`,
              deviceId: `device-${index}`,
              serverKey: hostKeys[index],
              state: 'approved',
              requestedAt: new Date().toISOString(),
            })),
          }),
        );
        const port = await startControl(
          { FAKE_STIM_PAYLOADS: statusWith({ macos: OWNED_MACOS }) },
          undefined,
          undefined,
          {
            status: () => ({
              Peer: Object.fromEntries(
                sessions.map((_, index) => [
                  index,
                  {
                    ID: `node-${index}`,
                    DNSName: `mini-${index}.tail.ts.net.`,
                    TailscaleIPs: [`100.64.0.${index + 8}`],
                  },
                ]),
              ),
            }),
            endpoint: (found) => ({
              ...found,
              url: `ws://127.0.0.1:${(hosts[found.servername.startsWith('mini-0.') ? 0 : 1]!.address() as { port: number }).port}`,
            }),
          },
        );
        const client = await authed(port, true);
        const ids: string[] = [];
        for (const path of [...paths, workspace]) {
          const reply = await client.request('control.begin', { workspace: path, platform: 'macos' });
          expect(reply).toHaveProperty('result.session');
          ids.push((reply as { result: { session: string } }).result.session);
        }
        expect(ids).toEqual(['h1', 'h2', 'c1']);
        for (const [index, session] of ids.entries()) {
          expect(await client.request('input.text', { session, text: `target-${index}` })).toMatchObject({
            result: {},
          });
          expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
        }
        for (const index of [0, 1]) {
          expect(
            seen[index]!.filter((request) => request.method === 'device-host.input.text').map(
              (request) => request.params,
            ),
          ).toEqual([{ session: 'c1', text: `target-${index}` }]);
          expect(
            seen[index]!.filter((request) => request.method === 'device-host.control.end').map(
              (request) => request.params,
            ),
          ).toEqual([{ session: 'c1' }]);
        }
        expect(
          readAudit()
            .filter((record) => record.action === 'control.end')
            .map((record) => record.workspace)
            .toSorted(),
        ).toEqual([...paths, workspace].toSorted());
      } finally {
        for (const host of hosts) {
          for (const socket of host.clients) socket.terminate();
          await new Promise<void>((resolve) => host.close(() => resolve()));
        }
      }
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
        { input: 'duo-release' },
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
        const grandchildPid = await readPid(grandchild);
        expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      } finally {
        if (existsSync(grandchild)) process.kill(await readPid(grandchild), 'SIGKILL');
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
      const { id, keyPair } = await pair(port, undefined, true);
      const client = await returning(port, keyPair);
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
        liveLogFixture(logged);
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
        expect(logs).toEqual([]);
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

describe('request log', () => {
  it('writes a failed request to the service log with the client and its run id, and nothing else', async () => {
    const lines: string[] = [];
    const port = await start({ requestLog: createRequestLog({ service: (line) => lines.push(line), debug: off }) });
    const { id, keyPair } = await pair(port);
    const client = await connect(port, undefined, { keyPair });
    await client.request('hello', { client: { ...CLIENT, runId: 'desktop-run.7' } });
    await client.request('machine.get');
    const token = 'request-param-text';
    expect(await client.request('no.such.method', { token })).toMatchObject({ error: { code: 'unknown-method' } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^stim-server: request failed method=no.such.method client=${id} run=desktop-run.7 ms=\\d+ error=unknown-method$`,
      ),
    );
    expect(lines.join('\n')).not.toContain(token);
  });

  it('with debug on, times every request and splits the hello into its slow steps', async () => {
    const lines: string[] = [];
    const port = await start({
      host: { executable: join(root, 'missing'), name: 'Stim Host Dev' },
      requestLog: createRequestLog({
        service: (line) => lines.push(line),
        debug: { enabled: () => true, log: () => {} },
      }),
    });
    const { keyPair } = await pair(port, '100.64.0.2');
    lines.length = 0;
    await returning(port, keyPair, '100.64.0.2');
    expect(lines.find((line) => line.includes('method=hello'))).toMatch(/debug request method=hello .*probe=\d+/);
  });
});

async function platformEnded(client: Client) {
  const progress: ServerMessage[] = [];
  for (;;) {
    const message = await client.next();
    if ('event' in message && (message.event === 'desktop-run-ended' || message.event === 'desktop-build-ended'))
      return { progress, done: message };
    if ('event' in message && message.event === 'error') throw new Error(message.error.message);
    progress.push(message);
  }
}

describe.skipIf(process.platform === 'win32')('Desktop web output', () => {
  it.each([
    { launched: true, running: true, verdict: 'loaded' },
    { launched: 'bundling', running: true, verdict: 'bundling' },
    { launched: 'unverified', running: true, verdict: 'unverified' },
    { launched: 'unverified', running: false, verdict: 'unverified' },
  ] as const)('preserves $verdict with running=$running', async ({ launched, running, verdict }) => {
    await start();
    const result: stim.StimRunResult = {
      platform: 'web',
      facts: {
        platform: 'web',
        browser: 'chrome',
        version: null,
        running,
        pid: running ? 123 : null,
        supervisorPid: null,
        url: 'http://localhost:8901/selected-page/',
        headless: true,
        viewport: 'desktop',
        profile: join(workspace, 'profile'),
        cdpEndpoint: null,
        targetId: null,
        reused: false,
        launched,
        metroPort: null,
        logs: { dir: join(workspace, 'logs') },
        durationMs: 1,
      },
    };
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
      ...original(options),
      run: vi.fn<stim.StimClient['run']>().mockResolvedValue(result),
    }));
    try {
      const client = await desktop();
      await client.request('desktop.run.subscribe', { cwd: workspace, options: { platform: 'web' } });
      const observed = await platformEnded(client);
      expect(observed.done.exitCode).toBe(0);
      expect(JSON.parse(observed.done.stdout)).toEqual(result);
      expect(observed.done.message).toContain(`${result.facts.url} ${verdict}`);
      expect(observed.done.message).toContain('stim logs --errors');
      expect(observed.done.message.includes('stim web again')).toBe(!running);
      expect(stimCalls()).toEqual([]);
    } finally {
      api.mockRestore();
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop platform build result', () => {
  it('orders build progress before artifact facts and preserves selectors without invoking a runtime', async () => {
    await start();
    const result: stim.StimBuildResult = {
      platform: 'android',
      facts: {
        apkPath: join(workspace, 'owned.apk'),
        androidPackage: 'dev.example.test',
        variant: 'demoDebug',
        abi: 'x86_64',
        cacheKey: 'exact-key',
        cacheHit: 'local',
        cacheSkipped: false,
        buildMachine: 'local',
        builtOn: null,
        ccache: { status: 'not-run', hits: null, misses: null, hitRatePercent: null },
        durationMs: 1,
        logs: { dir: join(workspace, 'logs') },
        links: { workspace: 'https://stim.appandflow.com/open' },
      },
    };
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
      ...original(options),
      build: vi.fn<stim.StimClient['build']>().mockImplementation(async (request) => {
        expect(request).toMatchObject({
          platform: 'android',
          variant: 'demoDebug',
          abi: 'x86_64',
          buildCache: false,
          remoteBuild: 'local',
        });
        options.onProgress?.({ stream: 'stderr', message: 'Cache lookup\n' });
        options.onProgress?.({ stream: 'stdout', message: 'Artifact ready\n' });
        return result;
      }),
      run: async (): Promise<never> => {
        throw new Error('Build-only must never start a runtime.');
      },
    }));
    try {
      const client = await desktop();
      expect(
        await client.request('desktop.build.subscribe', {
          cwd: workspace,
          options: {
            platform: 'android',
            variant: 'demoDebug',
            abi: 'x86_64',
            buildCache: false,
            remoteBuild: 'local',
          },
        }),
      ).toHaveProperty('result.subscription');
      const observed = await platformEnded(client);
      expect(observed.progress).toMatchObject([
        { event: 'desktop-build-progress', stream: 'stderr', message: 'Cache lookup\n' },
        { event: 'desktop-build-progress', stream: 'stdout', message: 'Artifact ready\n' },
      ]);
      expect(observed.done).toMatchObject({ event: 'desktop-build-ended', exitCode: 0 });
      expect(JSON.parse(observed.done.stdout)).toEqual(result);
      expect(await client.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'build', platform: 'android', ok: true }));
      expect(stimCalls()).toEqual([]);
    } finally {
      api.mockRestore();
    }
  });
});

describe.skipIf(process.platform === 'win32').each(['run', 'build'] as const)('Desktop platform %s', (kind) => {
  it('requires private Desktop proof and validates platform selectors before effects', async () => {
    const port = await start();
    const peer = await pair(port, undefined, true);
    const remote = await connect(port, undefined, { keyPair: peer.keyPair });
    expect(await remote.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.not.arrayContaining([`desktop-${kind}`]) },
    });
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    await plain.request('hello', { client: CLIENT });
    for (const client of [plain, remote]) {
      expect(
        await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options: { platform: 'ios' } }),
      ).toHaveProperty('error.code', 'forbidden');
    }
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, options: {} },
      { cwd: workspace, options: { platform: 'other' } },
      { cwd: workspace, options: { platform: 'web', remote: 'mini' } },
      { cwd: workspace, options: { platform: 'ios', variant: 'debug' } },
      { cwd: workspace, options: { platform: 'android', simulatorApp: 'stim-desktop' } },
      { cwd: workspace, options: { platform: 'ios', device: 7 } },
      { cwd: workspace, options: { platform: 'ios', wait: {} } },
      { cwd: workspace, options: { platform: 'ios', slot: 'bad\0slot' } },
      { cwd: workspace, options: { platform: 'macos', remote: '' } },
      { cwd: workspace, options: { platform: 'web', headed: 'true' } },
      { cwd: workspace, options: { platform: 'ios', json: true } },
      { cwd: workspace, options: { platform: 'ios' }, signal: {} },
    ])
      expect(await client.request(`desktop.${kind}.subscribe`, params)).toHaveProperty('error.code', 'bad-request');
    const buildOnlyRefusals =
      kind === 'build'
        ? [
            { platform: 'ios', arch: 'aarch64' },
            { platform: 'android', abi: 'arm64' },
            { platform: 'macos', buildCache: false },
            { platform: 'ios', remote: 'mini' },
            { platform: 'ios', device: true },
            { platform: 'android', slot: 'fold' },
            { platform: 'ios', wait: '90' },
            { platform: 'android', metroCheck: false },
            { platform: 'ios', easProfile: 'development' },
            { platform: 'web' },
            { platform: 'ios', buildCache: 'false' },
            { platform: 'ios', scheme: '' },
            { platform: 'android', remoteBuild: 'x'.repeat(1025) },
          ]
        : [];
    for (const options of buildOnlyRefusals)
      expect(await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options })).toHaveProperty(
        'error.code',
        'bad-request',
      );
    expect(stimCalls()).toEqual([]);
  });

  it('does not advertise or grant the operation on an adopted local server', async () => {
    await start({ desktopBootstrap: null });
    assert(server?.localSocket);
    const client = await localConnect(server.localSocket);
    expect(await client.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.not.arrayContaining([`desktop-${kind}`]) },
    });
    expect(
      await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options: { platform: 'ios' } }),
    ).toHaveProperty('error.code', 'forbidden');
  });

  it.each(
    kind === 'run'
      ? [{ platform: 'ios' }, { platform: 'macos', remote: 'eas' }]
      : [{ platform: 'ios' }, { platform: 'android' }],
  )('streams the real API refusal for %j without a CLI and releases the workspace', async (options) => {
    await start();
    const client = await desktop();
    expect(await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options })).toHaveProperty(
      'result.subscription',
    );
    const result = await platformEnded(client);
    expect(result.done.exitCode).toBe(1);
    expect(JSON.parse(result.done.stdout)).toMatchObject({
      code: options.platform === 'macos' ? 'STIM_BAD_ARG' : 'STIM_NO_PROJECT',
    });
    expect(readAudit()).toContainEqual(
      expect.objectContaining({ action: kind, platform: options.platform, ok: false }),
    );
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const accepts = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...result.progress, result.done].every((message) => accepts(message))).toBe(true);
    expect(await client.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
    expect(stimCalls()).toEqual([]);
  });

  it('bounds real API output without sending an oversized progress event', async () => {
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const client = await desktop();
    await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options: { platform: 'ios' } });
    const result = await platformEnded(client);
    expect(result.progress).toEqual([]);
    expect(result.done).toMatchObject({
      exitCode: 1,
      stdout: '',
      message: `${kind === 'run' ? 'stim ios' : 'ios build'} printed more than 1 bytes.`,
    });
    expect(stimCalls()).toEqual([]);
  });

  it.each(['unsubscribe', 'deadline', 'unknown-claims'] as const)(
    'drains cleanup before %s and retains unresolved admission',
    async (mode) => {
      const claim = tryAcquireClaim({ root: join(root, `draining-${kind}`), mode: 'exclusive' });
      assert(claim.acquired);
      const held = claim.acquired;
      await start({ actionLimits: { timeoutMs: mode === 'deadline' ? 100 : 5000 } });
      let cancelObserved = () => {};
      const cancelled = new Promise<void>((resolve) => {
        cancelObserved = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = stim.createStim;
      const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
        ...original(options),
        [kind]: async (request: stim.StimRunOptions | stim.StimBuildOptions): Promise<never> => {
          const signal = request.signal;
          assert(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          cancelObserved();
          await gate;
          throw new stim.StimError({
            code: 'STIM_CLAIM_UNAVAILABLE',
            message: `Fixture ${kind} cleanup is unresolved.`,
            remedy: `Recover ${held.path}`,
            details: mode === 'unknown-claims' ? undefined : { cause: { retainedClaimRoots: [held.root] } },
          });
        },
      }));
      try {
        const client = await desktop();
        const other = await desktop();
        const reply = await client.request(`desktop.${kind}.subscribe`, {
          cwd: workspace,
          options: { platform: 'ios' },
        });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result));
        let acknowledged = false;
        const response =
          mode === 'deadline'
            ? platformEnded(client)
            : client.request('unsubscribe', { subscription: result.subscription });
        void response.then(() => {
          acknowledged = true;
          return undefined;
        });
        await cancelled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(acknowledged).toBe(false);
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        release();
        const answer = await response;
        const recoveryMessage = expect.stringContaining(`Recover ${held.path}`);
        expect('done' in answer ? JSON.parse(answer.done.stdout) : answer).toMatchObject(
          mode === 'deadline'
            ? { code: 'STIM_CLAIM_UNAVAILABLE', remedy: `Recover ${held.path}` }
            : { error: { code: 'action-failed', message: recoveryMessage } },
        );
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        releaseClaim(held);
        const recovered = await other.request('desktop.stop.subscribe', { cwd: workspace });
        const subscription = expect.any(String);
        expect(recovered).toMatchObject(
          mode === 'unknown-claims' ? { error: { code: 'action-busy' } } : { result: { subscription } },
        );
      } finally {
        release();
        api.mockRestore();
        releaseClaim(held);
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('Desktop worktree warming', () => {
  async function ended(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-worktree-warm-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  function warmingFixture() {
    const linked = join(root, 'warm-linked');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 15_000 });
    git('init', '-q');
    writeFileSync(join(workspace, '.gitignore'), '.env\n');
    writeFileSync(join(workspace, 'package.json'), '{"dependencies":{"react-native":"0.88.0"}}');
    git('add', '.gitignore', 'package.json');
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
    );
    git('worktree', 'add', '--detach', linked);
    writeFileSync(join(workspace, '.env'), 'PRIVATE_FIXTURE=only');
    return linked;
  }

  it('copies real ignored state and streams its result without running the CLI', async () => {
    const linked = warmingFixture();
    await start({ env: { HOME: root, USERPROFILE: root, STIM_MAINTENANCE: 'off' } });
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('desktop.worktree.warm.subscribe', { cwd: linked })).toHaveProperty(
      'result.subscription',
    );
    const { progress, done } = await ended(client);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toEqual({ exitCode: 0 });
    expect(progress).toContainEqual(
      expect.objectContaining({ event: 'desktop-worktree-warm-progress', stream: 'stderr' }),
    );
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const accepts = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...progress, done].every((message) => accepts(message))).toBe(true);
    expect(readFileSync(join(linked, '.env'), 'utf8')).toBe('PRIVATE_FIXTURE=only');
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'worktree-warm', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it.each(['plain local', 'phone control', 'adopted local'])('denies warming from %s', async (mode) => {
    const port = await start(mode === 'adopted local' ? { desktopBootstrap: null } : {});
    assert(server?.localSocket);
    const client =
      mode === 'phone control'
        ? await connect(port, undefined, { keyPair: (await pair(port, undefined, true)).keyPair })
        : await localConnect(server.localSocket);
    const hello = await client.request('hello', { client: CLIENT });
    const offered = expect.arrayContaining(['desktop-worktree-warm']);
    const hidden = expect.not.arrayContaining(['desktop-worktree-warm']);
    const features = mode === 'plain local' ? offered : hidden;
    expect(hello).toMatchObject({ result: { features } });
    expect(await client.request('desktop.worktree.warm.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(stimCalls()).toEqual([]);
  });

  it('rejects malformed warm requests before effects', async () => {
    await start();
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, refresh: true },
      { cwd: workspace, target: workspace },
      { cwd: workspace, signal: {} },
    ])
      expect(await client.request('desktop.worktree.warm.subscribe', params)).toHaveProperty(
        'error.code',
        'bad-request',
      );
    expect(stimCalls()).toEqual([]);
  });

  it.each([false, true])(
    'allows long warming unless an explicit server deadline applies: %s',
    async (shortDeadline) => {
      await start(shortDeadline ? { actionLimits: { timeoutMs: 100 } } : {});
      const client = await desktop();
      let began = () => {};
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal: AbortSignal | undefined;
      const original = stim.createStim;
      const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
        ...original(options),
        warmWorktree: async (request: stim.StimWorktreeWarmOptions = {}) => {
          signal = request.signal;
          began();
          await gate;
          return { exitCode: 0 };
        },
      }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        expect(await client.request('desktop.worktree.warm.subscribe', { cwd: workspace })).toHaveProperty(
          'result.subscription',
        );
        await started;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(signal?.aborted).toBe(shortDeadline);
        release();
        const { done } = await ended(client);
        expect(done.exitCode).toBe(shortDeadline ? 1 : 0);
        expect(done.message).toBe(
          shortDeadline ? 'stim worktree warm did not finish within 0.1 s.' : 'Worktree warming completed.',
        );
      } finally {
        release();
        vi.useRealTimers();
        api.mockRestore();
      }
    },
  );

  it('bounds warming progress before sending an oversized event', async () => {
    const linked = warmingFixture();
    await start({ actionLimits: { maxOutputBytes: 1 }, env: { HOME: root, USERPROFILE: root } });
    const client = await desktop();
    expect(await client.request('desktop.worktree.warm.subscribe', { cwd: linked })).toHaveProperty(
      'result.subscription',
    );
    const result = await ended(client);
    expect(result.progress).toEqual([]);
    expect(result.done).toMatchObject({
      exitCode: 1,
      stdout: '',
      message: 'stim worktree warm printed more than 1 bytes.',
    });
    expect(stimCalls()).toEqual([]);
  });

  it('reserves resolved descendant workspaces while queued and releases them after cancellation', async () => {
    const linked = warmingFixture();
    const nested = join(linked, 'nested');
    mkdirSync(nested);
    const home = process.env.STIM_HOME;
    assert(home);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 2, projects: { [nested]: { metroPort: null } } }),
    );
    let admitted = () => {};
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => {
      const client = original(options);
      return {
        ...client,
        warmWorktree: (request: stim.StimWorktreeWarmOptions = {}) =>
          client.warmWorktree({
            ...request,
            beforeWarm: (path) => {
              request.beforeWarm?.(path);
              if (path === nested) admitted();
            },
          }),
      };
    });
    await start({ env: { HOME: root, USERPROFILE: root, STIM_MAINTENANCE: 'off' } });
    const claim = tryAcquireClaim({
      root: join(home, 'warm-locks', `${workspaceName(workspace)}.lock`),
      mode: 'exclusive',
    });
    assert(claim.acquired);
    try {
      const client = await desktop();
      const other = await desktop();
      const reply = await client.request('desktop.worktree.warm.subscribe', { cwd: linked });
      const result: unknown = 'result' in reply ? reply.result : undefined;
      assert(isJsonObject(result));
      await ready;
      expect(await other.request('desktop.stop.subscribe', { cwd: nested })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await client.request('unsubscribe', { subscription: result.subscription })).toHaveProperty('result');
      expect(existsSync(join(linked, '.env'))).toBe(false);
      const stopping = await other.request('desktop.stop.subscribe', { cwd: nested });
      expect(stopping).toHaveProperty('result.subscription');
      const stopped: unknown = 'result' in stopping ? stopping.result : undefined;
      assert(isJsonObject(stopped));
      await other.request('unsubscribe', { subscription: stopped.subscription });
      expect(stimCalls()).toEqual([]);
    } finally {
      releaseClaim(claim.acquired);
      api.mockRestore();
    }
  });

  it('waits for cancelled warming cleanup and retains admission until exact claims are released', async () => {
    const claim = tryAcquireClaim({ root: join(root, 'warm-draining'), mode: 'exclusive' });
    assert(claim.acquired);
    const held = claim.acquired;
    let cancelled = () => {};
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
      ...original(options),
      warmWorktree: async (request: stim.StimWorktreeWarmOptions = {}) => {
        const signal = request.signal;
        assert(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled();
        await gate;
        throw new stim.StimError({
          code: 'STIM_CLAIM_UNAVAILABLE',
          message: `Recover ${held.path}`,
          details: { cause: { retainedClaimRoots: [held.root] } },
        });
      },
    }));
    try {
      await start();
      const client = await desktop();
      const other = await desktop();
      const reply = await client.request('desktop.worktree.warm.subscribe', { cwd: workspace });
      const result: unknown = 'result' in reply ? reply.result : undefined;
      assert(isJsonObject(result));
      let acknowledged = false;
      const response = client.request('unsubscribe', { subscription: result.subscription });
      void response.then(() => {
        acknowledged = true;
        return undefined;
      });
      await observed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(false);
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      release();
      expect(await response).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining(held.path) },
      });
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      releaseClaim(held);
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
    } finally {
      release();
      releaseClaim(held);
      api.mockRestore();
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop worktree removal', () => {
  function removalFixture() {
    const linked = join(root, 'linked');
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args], { env, encoding: 'utf8', timeout: 15_000 }).trim();
    git('init', '-q');
    writeFileSync(join(workspace, 'package.json'), '{"private":true}');
    git('add', 'package.json');
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
    );
    git('worktree', 'add', '-b', 'rpc-owned', linked);
    assert(process.env.STIM_HOME);
    writeFileSync(
      join(process.env.STIM_HOME, 'config.json'),
      JSON.stringify({
        version: 2,
        projects: {
          [workspace]: { metroPort: null },
          [linked]: {
            metroPort: null,
            worktreeBranchOwned: true,
            worktreeBranch: 'rpc-owned',
            worktreeMainRoot: workspace,
          },
        },
      }),
    );
    return { linked, git, env: { HOME: root, USERPROFILE: root, STIM_MAINTENANCE: 'off' } };
  }

  async function remove(client: Client, params: unknown) {
    expect(await client.request('desktop.worktree.remove.subscribe', params)).toHaveProperty('result.subscription');
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-worktree-remove-ended') return message;
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
    }
  }

  it('transports dirty refusal, forced deletion and source cleanup without running the CLI', async () => {
    const fixture = removalFixture();
    const unsaved = join(fixture.linked, 'unsaved.txt');
    writeFileSync(unsaved, 'keep until explicitly forced');
    await start({ env: fixture.env });
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    const refused = await remove(client, { cwd: workspace, target: fixture.linked });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toEqual({ removed: false, exitCode: 1 });
    expect(existsSync(unsaved)).toBe(true);
    const removed = await remove(client, { cwd: workspace, target: fixture.linked, force: true });
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, exitCode: 0 });
    expect(existsSync(fixture.linked)).toBe(false);
    const source = await remove(client, { cwd: workspace });
    expect(JSON.parse(source.stdout)).toEqual({ removed: false, exitCode: 0 });
    expect(existsSync(join(workspace, '.git'))).toBe(true);
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'worktree-remove', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it.each(['alias', 'subfolder', 'descendant'])(
    'reserves the resolved %s scope through drain and refuses a busy target',
    async (mode) => {
      const fixture = removalFixture();
      const alias = join(root, 'linked-alias');
      symlinkSync(fixture.linked, alias);
      const nested = join(fixture.linked, 'app');
      mkdirSync(nested);
      const busy = mode === 'descendant' ? nested : fixture.linked;
      if (mode === 'descendant') {
        const configFile = join(root, 'home', 'config.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        config.projects[nested] = { metroPort: null };
        writeFileSync(configFile, JSON.stringify(config));
      }
      const target = mode === 'subfolder' ? nested : alias;
      let observed = () => {};
      const admitted = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const original = stim.createStim;
      const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => {
        const client = original(options);
        return {
          ...client,
          removeWorktree: (request: stim.StimWorktreeRemoveOptions = {}) =>
            client.removeWorktree({
              ...request,
              beforeRemove: (path) => {
                request.beforeRemove?.(path);
                if (path === busy) observed();
              },
            }),
        };
      });
      await start({ env: fixture.env });
      const client = await desktop();
      const other = await desktop();
      const lock = tryAcquireClaim({
        root: join(root, 'home', 'config.lock.claims'),
        mode: 'exclusive',
        label: 'fixture metadata',
      });
      assert(lock.acquired);
      try {
        const removing = await client.request('desktop.worktree.remove.subscribe', { cwd: workspace, target });
        const removal: unknown = 'result' in removing ? removing.result : undefined;
        assert(isJsonObject(removal));
        await admitted;
        for (const method of ['desktop.stop.subscribe', 'desktop.reload.subscribe'])
          expect(await other.request(method, { cwd: busy })).toHaveProperty('error.code', 'action-busy');
        await client.request('unsubscribe', { subscription: removal.subscription });
        expect(existsSync(fixture.linked)).toBe(true);
        const stopping = await other.request('desktop.stop.subscribe', { cwd: busy });
        const stop: unknown = 'result' in stopping ? stopping.result : undefined;
        assert(isJsonObject(stop));
        const refused = await remove(client, { cwd: workspace, target });
        expect(refused.exitCode).toBe(1);
        expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'STIM_ACTION_BUSY' });
        expect(existsSync(fixture.linked)).toBe(true);
        await other.request('unsubscribe', { subscription: stop.subscription });
        expect(stimCalls()).toEqual([]);
      } finally {
        releaseClaim(lock.acquired);
        api.mockRestore();
      }
    },
    30_000,
  );

  it('retains deletion success when branch cleanup fails and accepts a missing target for retry', async () => {
    const fixture = removalFixture();
    const lock = join(workspace, '.git', 'refs', 'heads', 'rpc-owned.lock');
    writeFileSync(lock, 'held');
    await start({ env: fixture.env });
    const client = await desktop();
    const partial = await remove(client, { cwd: workspace, target: fixture.linked });
    expect(partial.exitCode).toBe(1);
    expect(JSON.parse(partial.stdout)).toEqual({ removed: true, exitCode: 1 });
    expect(existsSync(fixture.linked)).toBe(false);
    rmSync(lock);
    const retried = await remove(client, { cwd: workspace, target: fixture.linked });
    expect(retried.exitCode).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual({ removed: false, exitCode: 0 });
    expect(fixture.git('branch', '--list', 'rpc-owned')).toBe('');
    expect(stimCalls()).toEqual([]);
  });

  it.each(['plain local', 'phone control', 'adopted local'])(
    'denies removal from %s without deleting the target',
    async (mode) => {
      const fixture = removalFixture();
      const port = await start({ env: fixture.env, ...(mode === 'adopted local' ? { desktopBootstrap: null } : {}) });
      assert(server?.localSocket);
      const client =
        mode === 'phone control'
          ? await connect(port, undefined, { keyPair: (await pair(port, undefined, true)).keyPair })
          : await localConnect(server.localSocket);
      await client.request('hello', { client: CLIENT });
      expect(
        await client.request('desktop.worktree.remove.subscribe', { cwd: workspace, target: fixture.linked }),
      ).toHaveProperty('error.code', 'forbidden');
      expect(existsSync(fixture.linked)).toBe(true);
      expect(stimCalls()).toEqual([]);
    },
  );

  it('rejects malformed effects before removing a worktree', async () => {
    const fixture = removalFixture();
    await start({ env: fixture.env });
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, target: '' },
      { cwd: workspace, target: '../linked' },
      { cwd: workspace, target: 1 },
      { cwd: workspace, target: fixture.linked, force: 'yes' },
      { cwd: workspace, target: fixture.linked, delete: true },
    ])
      expect(await client.request('desktop.worktree.remove.subscribe', params)).toHaveProperty(
        'error.code',
        'bad-request',
      );
    expect(existsSync(fixture.linked)).toBe(true);
    expect(stimCalls()).toEqual([]);
  });
});

const off = { enabled: () => false, log: () => {} };

describe.skipIf(process.platform === 'win32')('Desktop GC mutation', () => {
  function cacheFixture() {
    const home = process.env.STIM_HOME;
    assert(home);
    const cache = join(home, 'rpc-cache');
    mkdirSync(cache);
    const artifact = join(cache, 'artifact');
    writeFileSync(artifact, 'keep until requested cleanup');
    writeFileSync(
      join(home, 'caches.json'),
      JSON.stringify({
        version: 1,
        caches: [{ name: 'rpc-fixture', dir: cache, prune: 'entries' }],
      }),
    );
    return { home, cache, artifact, env: { HOME: root, USERPROFILE: root, STIM_MAINTENANCE: 'off' } };
  }

  async function ended(client: Client) {
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-gc-ended') return message;
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
    }
  }

  it('deletes only the selected private cache and refreshes cached reports without a CLI process', async () => {
    const fixture = cacheFixture();
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => {
      const client = original(options);
      return { ...client, gc: (request: stim.StimGcOptions = {}) => client.gc({ ...request, cache: 'rpc-fixture' }) };
    });
    try {
      await start({ env: fixture.env });
      const client = await desktop();
      const before = await client.request('desktop.reports.get', { report: 'gc' });
      expect(before).toMatchObject({
        result: { value: { sections: { caches: [{ name: 'rpc-fixture', dir: fixture.cache }] } } },
      });
      const config = readFileSync(join(fixture.home, 'config.json'), 'utf8');
      expect(
        await client.request('desktop.gc.subscribe', { cwd: workspace, cache: 'rpc-fixture', delete: true }),
      ).toHaveProperty('result.subscription');
      const done = await ended(client);
      expect(done.exitCode).toBe(0);
      expect(JSON.parse(done.stdout)).toMatchObject({ mode: 'delete', cacheScope: 'rpc-fixture', failures: 0 });
      expect(existsSync(fixture.artifact)).toBe(false);
      expect(readFileSync(join(fixture.home, 'config.json'), 'utf8')).toBe(config);
      expect(await client.request('desktop.reports.get', { report: 'gc' })).not.toEqual(before);
      expect(readClaimSet(join(fixture.home, 'maintenance', 'run.claims'))).toMatchObject({ live: [], unresolved: [] });
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'gc', ok: true }));
      expect(stimCalls()).toEqual([]);
    } finally {
      api.mockRestore();
    }
  });

  it('denies unproved local and phone control and rejects invalid selectors before deleting files', async () => {
    const fixture = cacheFixture();
    const port = await start({ env: fixture.env });
    const paired = await pair(port, undefined, true);
    const peer = await connect(port, undefined, { keyPair: paired.keyPair });
    assert(server?.localSocket);
    const plain = await localConnect(server.localSocket);
    expect(await plain.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.arrayContaining(['desktop-gc']) },
    });
    expect(await peer.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.not.arrayContaining(['desktop-gc']) },
    });
    for (const client of [plain, peer]) {
      expect(
        await client.request('desktop.gc.subscribe', { cwd: workspace, cache: 'rpc-fixture', delete: true }),
      ).toHaveProperty('error.code', 'forbidden');
    }
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, cache: '' },
      { cwd: workspace, cache: 1 },
      { cwd: workspace, delete: 'yes' },
      { cwd: workspace, worktrees: 1 },
      { cwd: workspace, olderThan: 1.5 },
      { cwd: workspace, idleMs: 0 },
      { cwd: workspace, idleMs: 1.5 },
      { cwd: workspace, signal: {} },
    ])
      expect(await client.request('desktop.gc.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    expect(readFileSync(fixture.artifact, 'utf8')).toBe('keep until requested cleanup');
    expect(stimCalls()).toEqual([]);
  });

  it('denies GC on an adopted server without the private Desktop bootstrap', async () => {
    const fixture = cacheFixture();
    await start({ env: fixture.env, desktopBootstrap: null });
    assert(server?.localSocket);
    const client = await localConnect(server.localSocket);
    expect(await client.request('hello', { client: CLIENT })).toMatchObject({
      result: { features: expect.not.arrayContaining(['desktop-gc']) },
    });
    expect(
      await client.request('desktop.gc.subscribe', { cwd: workspace, cache: 'rpc-fixture', delete: true }),
    ).toHaveProperty('error.code', 'forbidden');
    expect(existsSync(fixture.artifact)).toBe(true);
  });

  it.each(['unsubscribe', 'disconnect', 'shutdown', 'timeout'] as const)(
    '%s drains the actual GC native child and preserves files before releasing admission',
    async (ending) => {
      const fixture = cacheFixture();
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const witness = join(root, 'gc-child');
      const du = join(bin, 'du');
      writeFileSync(
        du,
        `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(witness)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      chmodSync(du, 0o755);
      let record: { pid: number; processToken: string } | undefined;
      try {
        await start({
          env: { ...fixture.env, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) },
          ...(ending === 'timeout' ? { actionLimits: { timeoutMs: 1500 } } : {}),
        });
        const client = await desktop();
        const reply = await client.request('desktop.gc.subscribe', {
          cwd: workspace,
          cache: 'rpc-fixture',
          delete: true,
        });
        assert(
          'result' in reply &&
            isJsonObject(reply.result) &&
            'subscription' in reply.result &&
            typeof reply.result.subscription === 'string',
        );
        await until(() => existsSync(witness));
        const pid = await readPid(witness);
        const processToken = captureProcessToken(pid);
        assert(processToken);
        record = { pid, processToken };
        const claims = join(fixture.home, 'maintenance', 'run.claims');
        expect(readClaimSet(claims).live).toContainEqual(
          expect.objectContaining({ child: expect.objectContaining({ pid }) }),
        );
        const other = await desktop();
        expect(await other.request('desktop.settings.get', { cwd: workspace })).toHaveProperty('result');
        let completion: unknown = {};
        if (ending === 'unsubscribe')
          completion = await client.request('unsubscribe', { subscription: reply.result.subscription });
        else if (ending === 'disconnect') client.socket.close();
        else if (ending === 'shutdown') {
          assert(server);
          await server.close();
          server = null;
        } else completion = await ended(client);
        const unsubscribed = { result: expect.any(Object) };
        const timedOut = { exitCode: 1, message: expect.stringContaining('did not finish') };
        expect(completion).toMatchObject(
          ending === 'unsubscribe' ? unsubscribed : ending === 'timeout' ? timedOut : {},
        );
        await until(() => inspectProcessIdentity(record) !== 'same');
        expect(inspectProcessIdentity(record)).toMatch(/^(gone|different)$/);
        await until(() => readClaimSet(claims).live.length === 0);
        expect(readClaimSet(claims).unresolved).toEqual([]);
        expect(readFileSync(fixture.artifact, 'utf8')).toBe('keep until requested cleanup');
        expect(stimCalls()).toEqual([]);
      } finally {
        if (record && inspectProcessIdentity(record) === 'same') process.kill(record.pid, 'SIGKILL');
        await server?.close();
        server = null;
      }
    },
  );

  it('keeps a failed cache deletion in the JSON report and returns a failing exit status', async () => {
    const fixture = cacheFixture();
    writeFileSync(
      join(fixture.home, 'caches.json'),
      JSON.stringify({
        version: 1,
        caches: [{ name: 'rpc-fixture', dir: fixture.cache, prune: 'atomic' }],
      }),
    );
    const original = fsPromises.rm;
    const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === fixture.artifact) throw new Error('fixture deletion denied');
      return original(path, options);
    });
    syncBuiltinESMExports();
    try {
      await start({ env: fixture.env });
      const client = await desktop();
      expect(
        await client.request('desktop.gc.subscribe', { cwd: workspace, cache: 'rpc-fixture', delete: true }),
      ).toHaveProperty('result.subscription');
      const done = await ended(client);
      expect(done.exitCode).toBe(1);
      expect(JSON.parse(done.stdout)).toMatchObject({
        mode: 'delete',
        cacheScope: 'rpc-fixture',
        results: expect.arrayContaining([
          expect.objectContaining({ kind: 'cache', status: 'failed', id: fixture.cache }),
        ]),
      });
      expect(existsSync(fixture.artifact)).toBe(true);
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'gc', ok: false }));
      expect(readClaimSet(join(fixture.home, 'maintenance', 'run.claims'))).toMatchObject({ live: [], unresolved: [] });
    } finally {
      deletion.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('bounds GC progress and terminal JSON while retaining files on a read-only request', async () => {
    const fixture = cacheFixture();
    await start({ env: fixture.env, actionLimits: { maxOutputBytes: 128 } });
    const client = await desktop();
    expect(await client.request('desktop.gc.subscribe', { cwd: workspace, cache: 'rpc-fixture' })).toHaveProperty(
      'result.subscription',
    );
    expect(await ended(client)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('printed more than 128 bytes'),
    });
    expect(existsSync(fixture.artifact)).toBe(true);
    expect(readClaimSet(join(fixture.home, 'maintenance', 'run.claims'))).toMatchObject({ live: [], unresolved: [] });
  });
});

describe.skipIf(process.platform === 'win32')('Desktop machine access requests', () => {
  it('returns an in-process setup report without exposing its ticket or running the CLI', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    await start({ env: { HOME: root, USERPROFILE: root, STIM_MAINTENANCE: 'off' } });
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    const ticket = 'a'.repeat(42) + 'A';
    expect(await client.request('desktop.machine-access.subscribe', { cwd: workspace, ticket })).toHaveProperty(
      'result.subscription',
    );
    let terminal: ServerMessage;
    for (;;) {
      terminal = await client.next();
      if ('event' in terminal && terminal.event === 'desktop-machine-access-ended') break;
    }
    assert('event' in terminal && terminal.event === 'desktop-machine-access-ended');
    expect(terminal).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(terminal.stdout)).toMatchObject({ project: workspace, platform: 'ios' });
    expect(JSON.stringify(terminal)).not.toContain(ticket);
    expect(JSON.stringify(readAudit())).not.toContain(ticket);
    expect(stimCalls()).toEqual([]);
  });

  it.each(['plain local', 'phone control', 'adopted local'])('denies access requests from %s', async (mode) => {
    const port = await start(mode === 'adopted local' ? { desktopBootstrap: null } : {});
    assert(server?.localSocket);
    const client =
      mode === 'phone control'
        ? await connect(port, undefined, { keyPair: (await pair(port, undefined, true)).keyPair })
        : await localConnect(server.localSocket);
    const hello = await client.request('hello', { client: CLIENT });
    assert(
      'result' in hello &&
        isJsonObject(hello.result) &&
        'features' in hello.result &&
        Array.isArray(hello.result.features),
    );
    expect(hello.result.features.includes('desktop-machine-access')).toBe(mode === 'plain local');
    expect(await client.request('desktop.machine-access.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(stimCalls()).toEqual([]);
  });

  it('rejects invalid tickets and extra environment before effects without echoing secrets', async () => {
    await start();
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, fix: true },
      { cwd: workspace, ticket: 'private-invalid-ticket' },
      { cwd: workspace, ticket: 'B'.repeat(43) },
      { cwd: workspace, extraEnvironment: { STIM_ACCESS_TICKET: 'private-invalid-ticket' } },
    ]) {
      const reply = await client.request('desktop.machine-access.subscribe', params);
      expect(reply).toHaveProperty('error.code', 'bad-request');
      expect(JSON.stringify(reply)).not.toContain('private-invalid-ticket');
    }
    expect(existsSync(join(root, 'home', 'build-machines.json'))).toBe(false);
    expect(existsSync(join(root, 'home', 'device-host-machines.json'))).toBe(false);
    expect(stimCalls()).toEqual([]);
  });

  it('acknowledges cancellation only after access cleanup and retains unresolved admission', async () => {
    let cancelled = () => {};
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = stim.createStim;
    const api = vi.spyOn(stim, 'createStim').mockImplementation((options) => ({
      ...original(options),
      requestMachineAccess: async ({ signal }: stim.StimMachineAccessOptions = {}) => {
        assert(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled();
        await gate;
        throw new stim.StimError({ code: 'STIM_CLAIM_UNAVAILABLE', message: 'Access request cleanup is unresolved.' });
      },
    }));
    try {
      await start();
      const client = await desktop();
      const other = await desktop();
      const reply = await client.request('desktop.machine-access.subscribe', { cwd: workspace });
      assert('result' in reply && isJsonObject(reply.result) && 'subscription' in reply.result);
      let acknowledged = false;
      const response = client.request('unsubscribe', { subscription: reply.result.subscription });
      void response.then(() => {
        acknowledged = true;
        return undefined;
      });
      await observed;
      expect(acknowledged).toBe(false);
      expect(await other.request('desktop.machine-access.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      release();
      expect(await response).toMatchObject({
        error: { code: 'action-failed', message: 'STIM_CLAIM_UNAVAILABLE: Access request cleanup is unresolved.' },
      });
      expect(await other.request('desktop.machine-access.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
    } finally {
      release();
      api.mockRestore();
    }
  });
});
