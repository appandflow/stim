import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import { stimdRecordFile, stimdSocket } from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet } from '@stim-cli/core/ownership-claim';
import { holdCIStimd } from '../api.ts';
import {
  acquireDeviceTicket,
  beforeCommand,
  cancelCliOp,
  ensureMetroThroughStimd,
  releaseDeviceTicket,
  releaseOrphanedTicket,
} from '../daemon/client.ts';
import { listLeaseFiles, releaseRunLease, takeLease } from '../engine/device-lease.ts';
import { operationState } from '../engine/operation-state.ts';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import * as spawnEntry from '../spawn-entry.ts';
import { invocation } from '../stimd/forwarded.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir } from '../workspace/paths.ts';

const entry = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
const RESTARTED = 'Stim: stimd restarted; this command continues with the new stimd.';

let dir: string;
let home: string;

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
  const child = spawn(process.execPath, [entry, '__stimd'], { env: { ...process.env }, stdio: 'ignore' });
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
    runId: 'resume-test',
    signal,
    output: () => {},
  };
  operationState(operation).takesSignals = true;
  return operation;
}

/** A stimd entry that starts the real one `delayMs` after it ran, so a resume is in progress meanwhile. */
function delayedEntry(delayMs: number): { path: string; marker: string } {
  const path = join(dir, 'delayed-entry.mjs');
  const marker = join(dir, 'delayed-entry.started');
  writeFileSync(
    path,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'started');
setTimeout(() => {
  process.argv[1] = ${JSON.stringify(entry)};
  import(${JSON.stringify(entry)});
}, ${delayMs});
`,
  );
  return { path, marker };
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
  id: 'SIM-RESUME',
  deviceName: null,
  idLabel: 'udid',
  waitSeconds: 30,
  noWait: false,
  installBoundMs: 0,
  appId: null,
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-resume-')));
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
});

afterEach(async () => {
  try {
    cancelCliOp();
    await stopStimd();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe.skipIf(process.platform === 'win32')('a command waiting on stimd', () => {
  test.each(['SIGKILL', 'SIGTERM'] as const)(
    'a device lease wait continues with the stimd started after a %s and ends holding one lease',
    async (signal) => {
      const other = workspace('other');
      const root = workspace('app');
      takeLease({ root: other, platform: 'ios', slot: 'default', id: 'SIM-RESUME', kind: 'run', durationMs: 5000 });
      const first = await startStimd();
      await admitCli(root);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const operation = context(root);
      let killed = false;
      const result = await acquireDeviceTicket(leaseParams(root), operation, (line) => {
        if (killed || !line.startsWith('waiting for')) return;
        killed = true;
        first.kill(signal);
      });
      expect(killed).toBe(true);
      expect(result).toMatchObject({ status: 'leased', kind: 'run' });
      expect(stimdPid()).not.toBe(first.pid);
      expect(errors.mock.calls.filter(([line]) => line === RESTARTED)).toHaveLength(1);
      const leases = listLeaseFiles().map((file) => file.lease);
      expect(leases).toEqual([
        expect.objectContaining({ holder: root, token: result.status === 'leased' && result.token }),
      ]);
      await releaseDeviceTicket(String(result.ticket), operation);
      expect(listLeaseFiles()).toEqual([]);
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

  test('a second stimd that dies under the repeated step fails with the unavailable-daemon error after one retry', async () => {
    const other = workspace('other');
    const root = workspace('app');
    takeLease({ root: other, platform: 'ios', slot: 'default', id: 'SIM-RESUME', kind: 'run', durationMs: 60_000 });
    const first = await startStimd();
    await admitCli(root);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let second: number | null = null;
    await expect(
      acquireDeviceTicket(leaseParams(root), context(root), (line) => {
        if (!line.startsWith('waiting for')) return;
        const pid = stimdPid();
        if (second === null && pid === first.pid) first.kill('SIGKILL');
        else if (second === null && pid !== null) {
          second = pid;
          process.kill(pid, 'SIGKILL');
        }
      }),
    ).rejects.toMatchObject({
      code: 'STIM_DAEMON_UNAVAILABLE',
      message: expect.stringContaining('already continued after one restart'),
    });
    expect(second).not.toBeNull();
    expect(errors.mock.calls.filter(([line]) => line === RESTARTED)).toHaveLength(1);
    expect(stimdPid()).toBe(second);
    expect(listLeaseFiles().map((file) => file.lease?.holder)).toEqual([other]);
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

  test('a lease wait cancelled during the resume stops at once and is not admitted again', async () => {
    const other = workspace('other');
    const root = workspace('app');
    takeLease({ root: other, platform: 'ios', slot: 'default', id: 'SIM-RESUME', kind: 'run', durationMs: 60_000 });
    const first = await startStimd();
    await admitCli(root);
    const delayed = delayedEntry(3000);
    vi.spyOn(spawnEntry, 'spawnEntry').mockReturnValue(delayed.path);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    let killed = false;
    const waiting = acquireDeviceTicket(leaseParams(root), context(root, controller.signal), (line) => {
      if (killed || !line.startsWith('waiting for')) return;
      killed = true;
      first.kill('SIGKILL');
    });
    const outcome = waiting.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(() => readFileSync(delayed.marker)).not.toThrow(), { timeout: 20_000, interval: 50 });
    const aborted = Date.now();
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(Date.now() - aborted).toBeLessThan(2000);
    await vi.waitFor(() => expect(stimdPid()).not.toBe(first.pid), { timeout: 20_000, interval: 50 });
    expect(errors.mock.calls.filter(([line]) => line === RESTARTED)).toHaveLength(0);
    expect(listLeaseFiles().map((file) => file.lease?.holder)).toEqual([other]);
  }, 60_000);

  test('a wait whose stimd does not come back fails within the bound with the unavailable-daemon error', async () => {
    const other = workspace('other');
    const root = workspace('app');
    takeLease({ root: other, platform: 'ios', slot: 'default', id: 'SIM-RESUME', kind: 'run', durationMs: 60_000 });
    const first = await startStimd();
    await admitCli(root);
    vi.spyOn(spawnEntry, 'spawnEntry').mockReturnValue(join(dir, 'missing-entry.mjs'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = Date.now();
    let killed = false;
    await expect(
      acquireDeviceTicket(leaseParams(root), context(root), (line) => {
        if (killed || !line.startsWith('waiting for')) return;
        killed = true;
        first.kill('SIGKILL');
      }),
    ).rejects.toMatchObject({ code: 'STIM_DAEMON_UNAVAILABLE', message: expect.stringContaining('stopped') });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(errors.mock.calls.filter(([line]) => line === RESTARTED)).toHaveLength(0);
    expect(listLeaseFiles().map((file) => file.lease?.holder)).toEqual([other]);
  }, 60_000);
});

/** A bare React Native project whose `metro` starts answering `/status` only after `delayMs`. */
function slowMetroProject(delayMs: number): string {
  const root = join(dir, 'bare');
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
exports.loadConfig = async ({ port }) => ({ server: { port }, resolver: { platforms: ['ios'] }, watchFolders: [] });
exports.runServer = (config) => new Promise((resolve) => setTimeout(() => {
  const httpServer = http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : ''));
  httpServer.listen(config.server.port, () => resolve({ httpServer }));
}, ${delayMs}));`,
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
  return realpathSync(root);
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
  }
}

describe.skipIf(process.platform === 'win32')('Metro across a stimd restart', () => {
  test('a Metro wait continues with the stimd started after a kill and answers the same Metro', async () => {
    const root = slowMetroProject(4000);
    const port = await freePort();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const answer = ensureMetroThroughStimd({ root, port }, 45_000);
      let metro: number | undefined;
      await vi.waitFor(
        () => {
          metro = metroChildren(root)[0];
          expect(metro).toBeDefined();
        },
        { timeout: 20_000, interval: 50 },
      );
      const first = stimdPid();
      expect(first).not.toBeNull();
      process.kill(Number(first), 'SIGKILL');
      await expect(answer).resolves.toMatchObject({ op: 'metro', pid: metro, port });
      expect(stimdPid()).not.toBe(first);
      expect(metroChildren(root)).toEqual([metro]);
      expect(errors.mock.calls.filter(([line]) => line === RESTARTED)).toHaveLength(1);
    } finally {
      await stopStimd();
      await stopMetro(root);
    }
  }, 90_000);
});

describe.skipIf(process.platform === 'win32')('an operation held through the API', () => {
  test('cancelled during a resume, it stops at once and is not admitted again', async () => {
    const root = slowMetroProject(4000);
    const port = await freePort();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const delayed = delayedEntry(3000);
    const controller = new AbortController();
    try {
      const answer = ensureMetroThroughStimd({ root, port }, 45_000, undefined, controller.signal);
      await vi.waitFor(() => expect(metroChildren(root)[0]).toBeDefined(), { timeout: 20_000, interval: 50 });
      const first = stimdPid();
      expect(first).not.toBeNull();
      vi.spyOn(spawnEntry, 'spawnEntry').mockReturnValue(delayed.path);
      process.kill(Number(first), 'SIGKILL');
      await vi.waitFor(() => expect(() => readFileSync(delayed.marker)).not.toThrow(), {
        timeout: 20_000,
        interval: 50,
      });
      const aborted = Date.now();
      controller.abort();
      await answer;
      expect(Date.now() - aborted).toBeLessThan(2000);
      await vi.waitFor(() => expect(stimdPid()).not.toBe(first), { timeout: 20_000, interval: 50 });
      expect(errors.mock.calls.filter(([line]) => line === RESTARTED)).toHaveLength(0);
    } finally {
      await stopStimd();
      await stopMetro(root);
    }
  }, 90_000);
});

describe.skipIf(process.platform === 'win32')('a CI hold', () => {
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

  test('pins the stimd it starts after the held one is killed', async () => {
    const first = await startStimd();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = await holdCIStimd({ ...process.env }, dir, null);
    try {
      first.kill('SIGKILL');
      await vi.waitFor(
        () =>
          expect(errors.mock.calls.map(([line]) => line)).toContain(
            'Stim: stimd restarted; the CI job holds the new stimd.',
          ),
        { timeout: 30_000, interval: 50 },
      );
      const pid = stimdPid();
      expect(pid).not.toBe(first.pid);
      expect(alive(Number(pid))).toBe(true);
    } finally {
      release();
    }
  }, 60_000);
});
