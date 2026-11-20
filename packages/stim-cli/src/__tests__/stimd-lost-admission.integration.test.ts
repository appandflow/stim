import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject, stimdClaimRoot, stimdRecordFile, stimdSocket } from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { holdCIStimd } from '../stimd/attached.ts';
import {
  acquireDeviceTicket,
  admittedOpToken,
  beforeCommand,
  cancelCliOp,
  deviceLogReadinessWait,
  ensureMetroThroughStimd,
  ensureTunnelThroughStimd,
  releaseDeviceTicket,
  releaseOrphanedTicket,
  startDeviceLogStream,
  stimdLive,
} from '../daemon/client.ts';
import { acquireRunLease } from '../engine/device-lease-run.ts';
import { verifyLaunch } from '../engine/launch-verify.ts';
import { listLeaseFiles, releaseRunLease, takeLease } from '../engine/device-lease.ts';
import { operationState } from '../engine/operation-state.ts';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import * as spawnEntry from '../spawn-entry.ts';
import { invocation } from '../stimd/forwarded.ts';
import { METRO_RUN_ACCEPT } from '../stimd/metro/child-server.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

const entry = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
const RERUN = { code: 'STIM_DAEMON_UNAVAILABLE', remedy: expect.stringContaining('Run the command again') };

let dir: string;
let home: string;
let retainFixture: boolean;

function stimdPid(): number | null {
  try {
    const pid = JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startStimd(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [entry, '__stimd'], {
    env: { ...process.env, STIM_DAEMON: 'on' },
    stdio: 'ignore',
  });
  await vi.waitFor(() => expect(stimdPid()).toBe(child.pid), { timeout: 15_000, interval: 50 });
  return child;
}

async function stopStimd(): Promise<void> {
  const pid = stimdPid();
  if (pid === null || !alive(pid)) return;
  process.kill(pid, 'SIGTERM');
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 20_000, interval: 50 });
}

function workspace(name: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
  upsertProject(root, {});
  return realpathSync(root);
}

function context(root: string, signal: AbortSignal = new AbortController().signal): StimContext {
  const operation: StimContext = {
    home,
    buildCache: null,
    projectRoot: root,
    cwd: root,
    env: process.env,
    runId: 'lost-admission-test',
    signal,
    output: () => {},
  };
  operationState(operation).takesSignals = true;
  return operation;
}

async function admitCli(root: string): Promise<void> {
  const forwarded = invocation(root, process.env);
  if ('code' in forwarded) throw new Error(forwarded.message);
  await beforeCommand('ios', process.env, { cwd: root, recordUse: false, pin: true, invocation: forwarded });
}

const leaseParams = (root: string) => ({
  root,
  platform: 'ios' as const,
  slot: 'default',
  id: 'SIM-LOST',
  deviceName: null,
  idLabel: 'udid',
  waitSeconds: 30,
  noWait: false,
  installBoundMs: 0,
  appId: null,
});

beforeEach(() => {
  retainFixture = false;
  makeScratch(tmpdir());
});

function makeScratch(base: string): void {
  dir = realpathSync(mkdtempSync(join(base, 'stim-lost-admission-')));
  home = join(dir, 'home');
  mkdirSync(home);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of ['launchctl', 'systemd-run']) {
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, tool), 0o755);
  }
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_DAEMON', 'on');
  vi.stubEnv('STIM_ENGINE_ROOT', join(dir, 'engine'));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('XDG_RUNTIME_DIR', '');
  vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
}

afterEach(async () => {
  try {
    cancelCliOp();
    if (!retainFixture) await stopStimd();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (!retainFixture) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe.skipIf(process.platform === 'win32')('a command waiting on stimd when stimd goes away', () => {
  test.each(['SIGKILL', 'SIGTERM'] as const)(
    'a device lease wait fails with the rerun error after a %s and starts no stimd',
    async (signal) => {
      const other = workspace('other');
      const root = workspace('app');
      takeLease({ root: other, platform: 'ios', slot: 'default', id: 'SIM-LOST', kind: 'run', durationMs: 60_000 });
      const first = await startStimd();
      await admitCli(root);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      let killed = false;
      await expect(
        acquireDeviceTicket(leaseParams(root), context(root), (line) => {
          if (killed || !line.startsWith('waiting for')) return;
          killed = true;
          first.kill(signal);
        }),
      ).rejects.toMatchObject(RERUN);
      expect(killed).toBe(true);
      await once(first, 'exit').catch(() => {});
      expect(stimdLive()).toBe(false);
      expect(errors).not.toHaveBeenCalled();
      expect(listLeaseFiles().map((file) => file.lease?.holder)).toEqual([other]);
    },
    60_000,
  );

  test('a lease granted before stimd was killed is released by its token', async () => {
    const root = workspace('app');
    const first = await startStimd();
    await admitCli(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const operation = context(root);
    const result = await acquireDeviceTicket({ ...leaseParams(root), waitSeconds: 0 }, operation, () => {});
    expect(result).toMatchObject({ status: 'leased' });
    first.kill('SIGKILL');
    await releaseDeviceTicket(String(result.ticket), operation);
    expect(listLeaseFiles()).toEqual([]);
  }, 60_000);

  test('releaseOrphanedTicket releases only when the issuing admission is lost, and only by its own token', async () => {
    const root = workspace('app');
    const first = await startStimd();
    await admitCli(root);
    const operation = context(root);
    const result = await acquireDeviceTicket({ ...leaseParams(root), waitSeconds: 0 }, operation, () => {});
    expect(result).toMatchObject({ status: 'leased' });
    const ticket = String(result.ticket);
    releaseOrphanedTicket(ticket);
    expect(listLeaseFiles()).toHaveLength(1);
    first.kill('SIGKILL');
    await vi.waitFor(() => expect(alive(Number(first.pid))).toBe(false), { timeout: 10_000, interval: 50 });
    await new Promise((done) => setTimeout(done, 1500));
    const held = listLeaseFiles()[0]?.lease;
    releaseRunLease({ root, platform: 'ios', slot: 'default', token: String(held?.token) });
    takeLease({ root, platform: 'ios', slot: 'default', id: 'SIM-RESUME', kind: 'run', durationMs: 60_000 });
    releaseOrphanedTicket(ticket);
    expect(listLeaseFiles()).toHaveLength(1);
    releaseOrphanedTicket(ticket);
  }, 60_000);

  test('a lease granted before stimd was killed is released by releaseOrphanedTicket', async () => {
    const root = workspace('app');
    const first = await startStimd();
    await admitCli(root);
    const result = await acquireDeviceTicket({ ...leaseParams(root), waitSeconds: 0 }, context(root), () => {});
    first.kill('SIGKILL');
    await vi.waitFor(() => expect(alive(Number(first.pid))).toBe(false), { timeout: 10_000, interval: 50 });
    await new Promise((done) => setTimeout(done, 1500));
    releaseOrphanedTicket(String(result.ticket));
    expect(listLeaseFiles()).toEqual([]);
  }, 60_000);

  test('a spawned Android CLI whose stimd is killed during its lease wait exits with the rerun remedy and starts no stimd', async () => {
    rmSync(dir, { recursive: true });
    // Vitest removes its run root even when it cannot inspect leftover processes.
    makeScratch(dirname(realpathSync(tmpdir())));
    const other = workspace('other');
    const root = workspace('app');
    const device = 'STIM-TEST-PHONE';
    const sdk = join(dir, 'sdk');
    const adbDir = join(sdk, 'platform-tools');
    const trace = join(dir, 'trace.json');
    const launches = join(dir, 'launches');
    const daemonGate = join(dir, 'daemon-gate.mjs');
    const cliPreload = join(dir, 'cli-preload.mjs');
    mkdirSync(launches);
    writeFileSync(
      daemonGate,
      `import { once } from 'node:events';
if (!process.connected) process.exit(1);
process.once('disconnect', () => process.exit(1));
const [message] = await once(process, 'message');
if (message !== 'start') process.exit(1);
process.removeAllListeners('disconnect');
process.disconnect();
`,
    );
    writeFileSync(
      cliPreload,
      `import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from ${JSON.stringify(new URL('../exec.ts', import.meta.url).href)};
import { captureProcessToken } from ${JSON.stringify(new URL('../process-identity.ts', import.meta.url).href)};
const executor = getExecutor();
const spawn = executor.spawn.bind(executor);
executor.spawn = (command, args, options) => {
  if (command !== process.execPath || args?.[0] !== ${JSON.stringify(entry)} || args[1] !== '__stimd' ||
      options?.cwd !== ${JSON.stringify(join(home, 'run'))} || !options.detached) return spawn(command, args, options);
  const child = spawn(command, ['--import', ${JSON.stringify(daemonGate)}, ...args], {
    ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  if (!child.pid) return child;
  const processToken = captureProcessToken(child.pid);
  if (!processToken) {
    child.kill();
    throw new Error('Could not record the replacement stimd identity');
  }
  const record = join(${JSON.stringify(launches)}, child.pid + '.json');
  writeFileSync(record + '.tmp', JSON.stringify({ pid: child.pid, processToken }));
  renameSync(record + '.tmp', record);
  child.send('start', (error) => { if (error) child.kill(); });
  return child;
};
`,
    );
    const replacementRecords = (): { pid: number; processToken: string }[] =>
      readdirSync(launches)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(join(launches, file), 'utf8')));

    vi.stubEnv('ANDROID_HOME', sdk);
    vi.stubEnv('ANDROID_SDK_ROOT', sdk);
    vi.stubEnv('PATH', [adbDir, process.env.PATH].join(delimiter));
    mkdirSync(adbDir, { recursive: true });
    mkdirSync(join(sdk, 'build-tools', '35.0.0'), { recursive: true });
    writeFileSync(join(root, 'settings.gradle'), "rootProject.name = 'fixture'\n");
    writeFileSync(join(root, '.stim.json'), '{"optimizations":{"android":{"compilerCache":"none"}}}');
    writeFileSync(join(sdk, 'build-tools', '35.0.0', 'apksigner'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(root, 'gradlew'),
      `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const model = process.argv.find(arg => arg.startsWith('-Pstim.native.model='));
if (!model) process.exit(0);
const apk = path.join(__dirname, 'app.apk');
fs.writeFileSync(apk, 'fixture bytes');
const output = model.slice('-Pstim.native.model='.length);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schema: 1, module: ':app', variant: 'debug',
  applicationId: 'com.fixture.app', sdkDirectory: process.env.ANDROID_HOME, elements: [{ path: apk, filters: [] }] }));
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(adbDir, 'adb'),
      `#!/bin/sh
case "$1" in
  devices) printf 'List of devices attached\\n${device}\\tdevice\\n' ;;
  -s) case "$5" in
    ro.product.cpu.abi) echo arm64-v8a ;;
    ro.product.model) echo 'fixture phone' ;;
  esac ;;
esac
`,
      { mode: 0o755 },
    );
    const held = takeLease({ root: other, platform: 'android', id: device, kind: 'run', durationMs: 60_000 });
    assert(held.status === 'taken');
    const first = spawn(process.execPath, [entry, '__stimd'], {
      env: { ...process.env, STIM_DAEMON: 'on' },
      stdio: 'ignore',
    });
    const firstExit = once(first, 'exit');
    let command: { child: ChildProcess; exited: Promise<unknown> } | undefined;
    retainFixture = true;
    try {
      await vi.waitFor(() => expect(stimdPid()).toBe(first.pid), { timeout: 15_000, interval: 50 });
      const cli = spawn(
        process.execPath,
        ['--import', cliPreload, entry, 'android', '--device', device, '--no-metro-check', '--remote-build', 'local'],
        {
          cwd: root,
          env: { ...process.env, STIM_TRACE: trace },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      command = { child: cli, exited: once(cli, 'exit') };
      let output = '';
      cli.stdout?.on('data', (chunk) => (output += String(chunk)));
      cli.stderr?.on('data', (chunk) => (output += String(chunk)));
      const waitsForHolder = () => output.split(`waiting for ${other} to release`).length - 1;
      await vi.waitFor(() => assert.equal(waitsForHolder(), 1, output), { timeout: 15_000, interval: 25 });
      assert(first.kill('SIGKILL'));
      await firstExit;
      await command.exited;
      expect({ code: cli.exitCode, output }).toMatchObject({
        code: 1,
        output: expect.stringContaining("This Stim home's stimd stopped while this command was running."),
      });
      expect(output).toContain('Run the command again');
      expect(output).not.toContain('stimd restarted');
      expect(replacementRecords()).toEqual([]);
      expect(listLeaseFiles().map(({ lease }) => lease?.token)).toEqual([held.lease.token]);
      releaseRunLease({ root: other, platform: 'android', token: held.lease.token });
    } finally {
      if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
      const cli = command?.child;
      if (cli?.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
      await Promise.all([firstExit, command?.exited]);
      await Promise.all(
        replacementRecords().map(async (owner) => {
          if (inspectProcessIdentity(owner) === 'same') {
            try {
              process.kill(owner.pid, 'SIGKILL');
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
            }
          }
          assert(await waitForProcessExit(owner, 5000), `Replacement stimd ${owner.pid} did not exit in ${home}.`);
        }),
      );
      retainFixture = false;
    }
  }, 80_000);
});

describe.skipIf(process.platform === 'win32')('a command not waiting on stimd when stimd goes away', () => {
  const killIdle = async (root: string) => {
    const first = await startStimd();
    await admitCli(root);
    first.kill('SIGKILL');
    await once(first, 'exit');
    return first;
  };

  test('its next device lease fails with the rerun error instead of a local lease or a new stimd', async () => {
    const root = workspace('app');
    await killIdle(root);
    await expect(
      acquireRunLease({
        root,
        platform: 'ios',
        id: 'SIM-LOST',
        idLabel: 'udid',
        waitSeconds: 0,
        noWait: true,
        installBoundMs: 0,
        operation: context(root),
      }),
    ).rejects.toMatchObject(RERUN);
    expect(stimdLive()).toBe(false);
    expect(listLeaseFiles()).toEqual([]);
  }, 60_000);

  test('its next log stream start fails with the rerun error instead of a warning', async () => {
    const root = workspace('app');
    await killIdle(root);
    await expect(
      startDeviceLogStream(
        { root, platform: 'ios', slot: 'default', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        context(root),
      ),
    ).rejects.toMatchObject(RERUN);
    expect(stimdLive()).toBe(false);
  }, 60_000);

  test('its next tunnel request answers the rerun error and starts no stimd', async () => {
    const root = workspace('app');
    const first = await startStimd();
    vi.stubEnv('STIM_DAEMON', 'off');
    const forwarded = invocation(root, process.env);
    if ('code' in forwarded) throw new Error(forwarded.message);
    await beforeCommand('start', process.env, { cwd: root, recordUse: false, pin: true, invocation: forwarded });
    first.kill('SIGKILL');
    await once(first, 'exit');
    const answer = await ensureTunnelThroughStimd(
      { root, port: 8081, mode: 'off', isExpo: false, ngrokUrl: null },
      10_000,
      context(root),
    );
    expect(answer).toMatchObject({ op: 'error', ...RERUN });
    expect(stimdLive()).toBe(false);
  }, 60_000);
  test('an API-scoped operation whose stimd is lost still fails a tunnel request as before with the daemon mode off', async () => {
    const root = workspace('app');
    const first = await startStimd();
    vi.stubEnv('STIM_DAEMON', 'off');
    const forwarded = invocation(root, process.env);
    if ('code' in forwarded) throw new Error(forwarded.message);
    await beforeCommand('start', process.env, { cwd: root, recordUse: false, pin: true, invocation: forwarded });
    const token = admittedOpToken();
    first.kill('SIGKILL');
    await once(first, 'exit');
    cancelCliOp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const operation = context(root);
    operationState(operation).takesSignals = false;
    operationState(operation).stimdOpToken = token;
    const answer = await ensureTunnelThroughStimd(
      { root, port: 8081, mode: 'off', isExpo: false, ngrokUrl: null },
      10_000,
      operation,
    );
    expect(answer).toMatchObject({ code: 'STIM_DAEMON_UNAVAILABLE' });
    expect(stimdPid()).toBe(first.pid);
  }, 60_000);
});

function pausedMetroProject() {
  const root = join(dir, 'bare');
  const allowReady = join(dir, 'metro-ready');
  const helperAccepted = join(dir, 'metro-helper-accepted');
  const recordAcceptance = join(dir, 'record-metro-acceptance.cjs');
  writeFileSync(
    recordAcceptance,
    `const { writeFileSync } = require('node:fs');
if (process.argv[1] === ${JSON.stringify(spawnEntry.spawnEntry('metro-run'))}) {
  process.on('message', (message) => {
    if (message !== ${JSON.stringify(METRO_RUN_ACCEPT)}) return;
    process.once('disconnect', () => writeFileSync(${JSON.stringify(helperAccepted)}, String(process.pid)));
  });
}`,
  );
  vi.stubEnv(
    'NODE_OPTIONS',
    [process.env.NODE_OPTIONS, `--require ${JSON.stringify(recordAcceptance)}`].filter(Boolean).join(' '),
  );
  const module = (name: string, body: string) => {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(root, 'node_modules', name, 'index.js'), body);
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'bare', dependencies: { 'react-native': '0.0.0' } }),
  );
  module(
    'metro',
    `const http = require('node:http');
const { existsSync } = require('node:fs');
const { setTimeout } = require('node:timers/promises');
exports.loadConfig = async ({ port }) => ({ server: { port }, resolver: { platforms: ['ios'] }, watchFolders: [] });
exports.runServer = async (config) => {
  while (!existsSync(${JSON.stringify(allowReady)})) await setTimeout(25);
  const httpServer = http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : ''));
  return new Promise((resolve) => httpServer.listen(config.server.port, () => resolve({ httpServer })));
};`,
  );
  module(
    '@react-native/dev-middleware',
    `exports.createDevMiddleware = () => ({ middleware: (q, s, n) => n(), websocketEndpoints: {} });`,
  );
  module(
    '@react-native-community/cli-server-api',
    `exports.createDevServerMiddleware = () => ({ middleware: (q, s, n) => n(), websocketEndpoints: {} });`,
  );
  upsertProject(root, {});
  return {
    root: realpathSync(root),
    helperAccepted,
    allowReady: () => writeFileSync(allowReady, ''),
  };
}

async function waitForAcceptedMetro(root: string, helperAccepted: string): Promise<number> {
  return vi.waitFor(
    () => {
      const [claim] = readClaimSet(join(workspaceDir(root), 'metro.claim')).live;
      assert(claim?.child && claim.details.starting === true);
      const helper = claim.details.helper;
      assert(isJsonObject(helper) && typeof helper.pid === 'number');
      expect(existsSync(helperAccepted) && readFileSync(helperAccepted, 'utf8')).toBe(String(helper.pid));
      expect(readWorkspaceState(root)?.supervisor).toMatchObject(claim.child);
      return claim.child.pid;
    },
    { timeout: 20_000, interval: 50 },
  );
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, 'listening');
  const address = server.address();
  server.close();
  return typeof address === 'object' && address ? address.port : 0;
}

function metroChildren(root: string): number[] {
  return readClaimSet(join(workspaceDir(root), 'metro.claim')).live.flatMap((holder) =>
    holder.child ? [holder.child.pid] : [],
  );
}

async function stopMetro(root: string): Promise<void> {
  for (const holder of readClaimSet(join(workspaceDir(root), 'metro.claim')).live) {
    const child = holder.child;
    if (!child || !processGroupAlive(child.pid) || inspectProcessIdentity(child) !== 'same') continue;
    process.kill(-child.pid, 'SIGKILL');
    await waitForProcessExit(child, 5000);
    const helper = holder.details.helper;
    if (isJsonObject(helper) && typeof helper.pid === 'number' && typeof helper.processToken === 'string')
      await waitForProcessExit({ pid: helper.pid, processToken: helper.processToken }, 15_000);
  }
}

describe.skipIf(process.platform === 'win32')('Metro when stimd goes away', () => {
  test('a Metro wait fails with the rerun error, and the rerun answers the same Metro', async () => {
    const { root, helperAccepted, allowReady } = pausedMetroProject();
    const port = await freePort();
    try {
      const answer = ensureMetroThroughStimd({ root, port }, 45_000);
      const metro = await waitForAcceptedMetro(root, helperAccepted);
      const first = stimdPid();
      expect(first).not.toBeNull();
      process.kill(Number(first), 'SIGKILL');
      await expect(answer).resolves.toMatchObject({ op: 'error', ...RERUN });
      expect(stimdLive()).toBe(false);
      allowReady();
      await expect(ensureMetroThroughStimd({ root, port }, 45_000)).resolves.toMatchObject({
        op: 'metro',
        state: 'started',
        pid: metro,
        port,
      });
      expect(stimdPid()).not.toBe(first);
      expect(metroChildren(root)).toEqual([metro]);
    } finally {
      await stopStimd();
      await stopMetro(root);
    }
  }, 90_000);
});

const attachedHold = { op: 'op.begun', attached: true, instance: 'other-job' };
const otherBuildHold = { op: 'engine-changed', build: 'aaaaaaaaaaaa', version: '2.0.0-other' };

async function withCIHoldServer(replies: Record<string, unknown>[], run: (connections: Socket[]) => Promise<void>) {
  const path = stimdSocket();
  mkdirSync(join(path, '..'), { recursive: true });
  const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired;
  if (!claim) throw new Error('Could not claim the test stimd socket.');
  const connections: Socket[] = [];
  const server = createServer((socket) => {
    const reply = replies[connections.length];
    connections.push(socket);
    socket.once('data', () => {
      if (reply?.op === 'engine-changed') socket.end(JSON.stringify(reply) + '\n');
      else socket.write(JSON.stringify({ op: 'hello' }) + '\n' + JSON.stringify(reply ?? { op: 'op.begun' }) + '\n');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
    await run(connections);
  } finally {
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseClaim(claim);
  }
}

describe.skipIf(process.platform === 'win32')('a command refused by another build', () => {
  test('a log stream start answers the refusal with its remedy', async () => {
    const root = workspace('app');
    await withCIHoldServer([otherBuildHold, otherBuildHold, otherBuildHold], async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await admitCli(root).catch(() => {});
      const reply = await startDeviceLogStream(
        { root, platform: 'ios', slot: 'default', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        context(root),
      );
      expect(reply).toEqual({ error: expect.stringContaining('2.0.0-other') });
      expect(reply).toEqual({ error: expect.stringContaining('Run the command with Stim 2.0.0-other') });
      expect(JSON.stringify(reply)).not.toContain('no stimd connection');
    });
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('a CI hold', () => {
  test.each([
    ['an attached stimd', attachedHold],
    ["another build's stimd", otherBuildHold],
  ] as const)('refuses the first pin against %s without retrying', async (_name, reply) => {
    await withCIHoldServer([reply], async (connections) => {
      const hold = holdCIStimd({ ...process.env }, dir, null).then((release) => {
        release();
        return undefined;
      });
      await expect(hold).rejects.toThrow('Could not pin the Stim daemon for this CI job.');
      expect(connections).toHaveLength(1);
    });
  });

  test('pins a fresh stimd when the one it asked ends instead of answering', async () => {
    const path = stimdSocket();
    mkdirSync(join(path, '..'), { recursive: true });
    const ending = createServer((socket) => {
      socket.once('data', () => {
        ending.close();
        rmSync(path, { force: true });
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => ending.once('error', reject).listen(path, resolve));
    const release = await holdCIStimd({ ...process.env }, dir, null);
    try {
      const pid = stimdPid();
      expect(pid).not.toBeNull();
      expect(alive(Number(pid))).toBe(true);
    } finally {
      release();
    }
  }, 60_000);

  test('a held stimd that is killed is not replaced, and the hold says so', async () => {
    const first = await startStimd();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = await holdCIStimd({ ...process.env }, dir, null);
    try {
      first.kill('SIGKILL');
      await vi.waitFor(
        () =>
          expect(errors).toHaveBeenCalledWith(
            "Stim: stimd stopped during the CI job; the job's next stim command starts one.",
          ),
        { timeout: 10_000, interval: 50 },
      );
      await once(first, 'exit').catch(() => {});
      await new Promise((done) => setTimeout(done, 1000));
      expect(stimdLive()).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('launch verification when stimd goes away', () => {
  test('a readiness wait whose admission is lost fails the launch with the rerun error, not unverified', async () => {
    const root = workspace('app');
    const path = stimdSocket();
    mkdirSync(join(path, '..'), { recursive: true });
    const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired;
    assert(claim);
    let admissions = 0;
    let admission: Socket | undefined;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const request: unknown = JSON.parse(line);
          if (!isJsonObject(request)) continue;
          if (request.op === 'op.begin') {
            admission = socket;
            socket.write(
              `${JSON.stringify({ op: 'hello' })}\n${JSON.stringify({ op: 'op.begun', opToken: `admission-${++admissions}` })}\n`,
            );
          } else if (request.op === 'readiness.wait') {
            admission?.end();
            socket.end();
          }
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
      await admitCli(root);
      const since = Date.now();
      const delivery = { src: 'metro', platform: 'ios', requestId: 'r1' };
      const metro = [
        { ...delivery, ts: since + 200, event: 'bundle_response_started' },
        { ...delivery, ts: since + 400, event: 'bundle_response_finished', statusCode: 200 },
      ];
      await expect(
        verifyLaunch({
          since,
          platform: 'ios',
          metroPort: 8081,
          requireBundleResponse: true,
          readRecords: () => metro.filter((record) => record.ts <= Date.now()),
          readDeviceRecords: () => [],
          readClientRecords: () => [],
          deviceStreamId: 'stream',
          processAlive: async () => true,
          sleep: deviceLogReadinessWait(root, 'ios', 'default', 'stream', since, context(root)),
        }),
      ).rejects.toMatchObject(RERUN);
      expect(admissions).toBe(1);
    } finally {
      cancelCliOp();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      releaseClaim(claim);
    }
  }, 60_000);
});
