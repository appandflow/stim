import assert from 'node:assert';
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  daemonClaimRoot,
  daemonNdjsonFile,
  stimdClaimRoot,
  stimdRecordFile,
  stimdSocket,
  diskUsageWalkClaims,
  gcLogFile,
  readDaemonSnapshot,
  readDiskUsage,
  readMaintenanceState,
  stimBuildId,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as clonefile from '../clonefile.ts';
import {
  claimRemoveCommand,
  markClaimChildPending,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
} from '../ownership-claim.ts';
import { captureProcessIdentity } from '../process-identity.ts';
import { goneClaimOwner } from './_factories.ts';
import * as engineSwitch from '../daemon/engine-switch.ts';
import * as engineFollow from '../stimd/engine-follow.ts';
import * as stimdThreads from '../stimd/threads.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { takeWaitTicket } from '../engine/wait-queue.ts';
import {
  backgroundPassesAvailable,
  ensurePersistentStimd,
  ensureStimd,
  observeOwnedWeb,
  requestDaemonTick,
  stimdBuildId,
} from '../daemon/client.ts';
import { holdCIStimd } from '../api.ts';
import { reclaimForBootWaiters } from '../daemon/reclaim.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import * as measure from '../daemon/measure.ts';
import { createMaintenanceLane, runHomePasses } from '../daemon/passes.ts';
import * as daemonPasses from '../daemon/passes.ts';
import { macosDir } from '../macos/state.ts';
import { runStimd } from '../stimd/main.ts';
import * as netThread from '../stimd/net.ts';
import * as maintenanceMeasure from '../stimd/passes/measure.ts';
import * as maintenanceRun from '../stimd/passes/run.ts';
import * as spawnEntry from '../spawn-entry.ts';
import * as ndjson from '../ndjson.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { daemonFindings, daemonStatus } from '../daemon/status.ts';
import { parseBoots } from '../stimd/crash-hold.ts';

vi.mock('../stimd/threads.ts', () => import('./fixtures/inline-stimd-threads.ts'));

const entry = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
let home: string;
interface SpawnedDaemon {
  child: ReturnType<ReturnType<typeof getExecutor>['spawn']>;
  exited: Promise<number | null>;
}
let daemons: SpawnedDaemon[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = home;
  vi.stubEnv('XDG_RUNTIME_DIR', '');
});

afterEach(async () => {
  for (const daemon of daemons) daemon.child.kill('SIGTERM');
  await Promise.all(daemons.map((daemon) => daemon.exited));
  daemons = [];
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === 'win32')('background passes availability', () => {
  test.each([
    ['older daemon', {}, false],
    ['report mode', { mode: 'report' }, false],
    ['attached daemon', { mode: 'on', attached: true }, false],
    ['persistent acting daemon', { mode: 'on' }, true],
  ] as const)(
    'background passes availability rejects %s unless it can act persistently',
    async (_label, hello, expected) => {
      const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'fixture stimd' }).acquired;
      assert(claim);
      const socketPath = stimdSocket();
      mkdirSync(dirname(socketPath), { recursive: true });
      const server = createServer((socket) => {
        let buffer = '';
        let framed = false;
        socket.on('data', (chunk) => {
          buffer += String(chunk);
          for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            const message: Record<string, unknown> = JSON.parse(line);
            if (!framed) {
              framed = true;
              if (message.build !== stimdBuildId()) {
                socket.end(`${JSON.stringify({ op: 'engine-changed' })}\n`);
                return;
              }
              socket.write(`${JSON.stringify({ op: 'hello', kind: 'stimd' })}\n`);
            } else socket.end(`${JSON.stringify({ op: 'hello', ...hello })}\n`);
          }
        });
      });
      try {
        await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
        expect(await backgroundPassesAvailable()).toBe(expected);
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(socketPath, { force: true });
        releaseClaim(claim);
      }
    },
  );
});

/** A stand-in for a stim-daemon from Stim 1.40 to 1.42: holds the daemon claim exclusively and notes SIGTERM before it exits. */
const LEGACY_DAEMON = `
import { appendFileSync, mkdirSync } from 'node:fs';
import { daemonClaimRoot, daemonDir } from '@stim-cli/core/state';
import { tryAcquireClaim } from '@stim-cli/core/ownership-claim';
const record = process.argv[1];
mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
tryAcquireClaim({ root: daemonClaimRoot(), mode: 'exclusive', label: 'stim-daemon' });
process.on('SIGTERM', () => {
  appendFileSync(record, 'sigterm\\n');
  process.exit(0);
});
appendFileSync(record, 'listening\\n');
setInterval(() => {}, 1000);
`;

function daemonLog(): string {
  return existsSync(daemonNdjsonFile()) ? readFileSync(daemonNdjsonFile(), 'utf8') : '';
}

function startDaemonProcess(): SpawnedDaemon {
  const child = getExecutor().spawn(process.execPath, [entry, '__stimd'], { env: { ...process.env }, stdio: 'ignore' });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  daemons.push({ child, exited });
  return { child, exited };
}

async function listening(): Promise<void> {
  await vi.waitFor(() => expect(daemonLog()).toContain('"event":"daemon_started"'), { timeout: 10_000, interval: 20 });
}

function lines(socket: Socket): string[] {
  const received: string[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      received.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  return received;
}

const frame = () => `${JSON.stringify({ kind: 'cli', build: stimdBuildId() })}\n`;

test.skipIf(process.platform === 'win32')(
  'targeted observers reject a generic old-daemon acknowledgement',
  async () => {
    const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'fixture' }).acquired;
    assert(claim);
    mkdirSync(dirname(stimdSocket()), { recursive: true });
    const requests: string[] = [];
    const server = createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        const frames = data.split('\n');
        if (frames.length < 3) return;
        const requestFrame = frames[1];
        if (requestFrame === undefined) return;
        const request = JSON.parse(requestFrame);
        requests.push(request.op);
        socket.end(`${JSON.stringify({ op: 'hello' })}\n${JSON.stringify({ op: 'logs.observed', error: null })}\n`);
      });
    });
    await new Promise<void>((done) => server.listen(stimdSocket(), done));
    try {
      expect(await observeOwnedWeb('/fixture', 123, 'token')).toContain('did not answer');
      expect(requests).toEqual(['logs.observe-web']);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      releaseClaim(claim);
    }
  },
);

test('shutdown retains the daemon claim until the net thread and observers close', async () => {
  let finish: () => void = () => {};
  const closing = new Promise<void>((done) => {
    finish = done;
  });
  const close = vi.fn<() => Promise<void>>(() => closing);
  const net = vi.spyOn(netThread, 'createNetThread').mockReturnValue({
    ensure: async () => ({ listening: false, message: 'unused' }),
    running: () => null,
    connect: () => false,
    presence: () => false,
    close,
  });
  const before = new Set(process.listeners('SIGTERM'));
  const run = runStimd({ tickMs: 60_000, mode: 'on' });
  try {
    await listening();
    const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
    assert(handler);
    handler('SIGTERM');
    expect(close).toHaveBeenCalledOnce();
    const attempt = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'successor' });
    expect(attempt.acquired).toBeUndefined();
    if (attempt.pending) releaseClaim(attempt.pending);
    finish();
    await run;
    expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
  } finally {
    finish();
    await run;
    net.mockRestore();
  }
});

async function stopStimd(): Promise<void> {
  saveConfig({ version: 2, projects: {}, repos: {}, daemon: { mode: 'off' } });
  await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
}

async function waiter(resource: 'slot' | 'boot' = 'slot'): Promise<{ socket: Socket; received: string[] }> {
  const socket = connect(stimdSocket());
  onTestFinished(() => {
    socket.destroy();
  });
  const received = lines(socket);
  socket.write(`${frame()}${JSON.stringify({ op: `${resource}.wait` })}\n`);
  await vi.waitFor(() => expect(received.join()).toContain(`"op":"${resource}.waiting"`), {
    timeout: 10_000,
    interval: 20,
  });
  return { socket, received };
}

function release(resource: 'slot' | 'boot' = 'slot'): void {
  const socket = connect(stimdSocket());
  socket.once('connect', () => socket.end(`${frame()}${JSON.stringify({ op: `${resource}.released` })}\n`));
}

describe('stimd on every platform', () => {
  test('one stimd per home: a second one exits and leaves the first one holding both claims and the socket', async () => {
    const first = startDaemonProcess();
    await listening();
    const second = startDaemonProcess();
    expect(await second.exited).toBe(0);
    expect(daemonLog()).toContain('"event":"stimd_claim_held"');
    expect(readClaimSet(stimdClaimRoot()).live.map((holder) => holder.owner.pid)).toEqual([first.child.pid]);
    expect(readClaimSet(daemonClaimRoot()).live.map((holder) => [holder.owner.pid, holder.mode])).toEqual([
      [first.child.pid, 'shared'],
    ]);
    expect(existsSync(stimdRecordFile())).toBe(true);
  }, 20_000);

  test('a released build slot wakes the oldest waiter at once, and the next release the one after it', async () => {
    startDaemonProcess();
    await listening();
    const holder = tryAcquireBuildSlot({ max: 1 });
    assert(holder);
    const first = await waiter();
    const second = await waiter();
    expect(releaseBuildSlot(holder)).toBe(true);
    await vi.waitFor(() => expect(first.received.join()).toContain('"op":"slot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
    expect(second.received.join()).not.toContain('"op":"slot.changed"');
    first.socket.destroy();
    release();
    await vi.waitFor(() => expect(second.received.join()).toContain('"op":"slot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
  }, 20_000);

  test('a finished boot wakes the oldest boot waiter only, never a build waiter', async () => {
    startDaemonProcess();
    await listening();
    const build = await waiter('slot');
    const first = await waiter('boot');
    const second = await waiter('boot');
    release('boot');
    await vi.waitFor(() => expect(first.received.join()).toContain('"op":"boot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
    expect(second.received.join()).not.toContain('"op":"boot.changed"');
    expect(build.received.join()).not.toContain('changed');
    first.socket.destroy();
    release('boot');
    await vi.waitFor(() => expect(second.received.join()).toContain('"op":"boot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
  }, 20_000);
});

describe.skipIf(process.platform === 'win32')('stimd', () => {
  test('a CI hold keeps a quiescent persistent daemon alive through off mode', async () => {
    const running = runStimd({ mode: 'on', tickMs: 500 });
    await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
    let ended = false;
    void running.then(() => {
      ended = true;
    });
    const releaseHold = await vi
      .waitFor(() => holdCIStimd({ ...process.env, STIM_HOME: home }, home, null), { timeout: 10_000, interval: 50 })
      .catch((error: unknown) => {
        throw new Error(
          `${String(error)}\nstimd ended: ${ended}; record: ${existsSync(stimdRecordFile())}\ndaemon.ndjson:\n${daemonLog()}`,
        );
      });
    try {
      await new Promise((done) => setTimeout(done, 1200));
      expect(existsSync(stimdRecordFile())).toBe(true);
      saveConfig({ version: 2, projects: {}, repos: {}, daemon: { mode: 'off' } });
      await new Promise((done) => setTimeout(done, 1200));
      expect(existsSync(stimdRecordFile())).toBe(true);
    } finally {
      releaseHold();
    }
    await running;
    expect(existsSync(stimdRecordFile())).toBe(false);
  }, 20_000);

  test('an attached daemon reports a failed tick as an unsuccessful exit', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const oldExit = process.exitCode;
    const failing = vi.spyOn(daemonPasses, 'runHomePasses').mockRejectedValueOnce(new Error('tick failed in test'));
    try {
      process.exitCode = undefined;
      const running = runStimd({ mode: 'on', tickMs: 60_000, attached: { handover: false } });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
      await running;
      expect(process.exitCode).toBe(1);
      expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
      expect(readClaimSet(stimdClaimRoot()).unresolved).toEqual([]);
      process.exitCode = undefined;
      const retry = runStimd({ mode: 'on', tickMs: 60_000, attached: { handover: false } });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
      assert(handler);
      handler('SIGTERM');
      await retry;
      expect(readClaimSet(stimdClaimRoot()).unresolved).toEqual([]);
    } finally {
      failing.mockRestore();
      process.exitCode = oldExit;
    }
  });

  test.each(['attached', 'persistent'])(
    '%s shutdown joins a foreground child before releasing the home',
    async (kind) => {
      const before = new Set(process.listeners('SIGTERM'));
      let childPid = 0;
      let childStarted = () => {};
      let childStopped = () => {};
      let releaseCleanup = () => {};
      const started = new Promise<void>((done) => {
        childStarted = done;
      });
      const stopped = new Promise<void>((done) => {
        childStopped = done;
      });
      const cleanup = new Promise<void>((done) => {
        releaseCleanup = done;
      });
      const passes = vi.spyOn(daemonPasses, 'runHomePasses').mockImplementation(async ({ signal }) => {
        if (!signal) throw new Error('foreground signal missing');
        try {
          await getExecutor().runFileAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            timeoutMs: 30_000,
            signal,
            onSpawn: (child) => {
              childPid = child.pid ?? 0;
              childStarted();
            },
          });
        } finally {
          childStopped();
          await cleanup;
        }
        throw new Error('foreground child unexpectedly completed');
      });
      let running: Promise<boolean> | undefined;
      try {
        running = runStimd({
          mode: 'on',
          tickMs: 60_000,
          ...(kind === 'attached' ? { attached: { handover: false } } : {}),
        });
        await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
        const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
        assert(handler);
        void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
        await started;
        handler('SIGTERM');
        await stopped;
        expect(childPid).toBeGreaterThan(0);
        expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/);
        expect(readClaimSet(stimdClaimRoot()).live.length).toBeGreaterThan(0);
        releaseCleanup();
        await running;
        expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
      } finally {
        releaseCleanup();
        passes.mockRestore();
        await running?.catch(() => {});
      }
    },
    20_000,
  );

  test('an attached stimd ended by an unverified foreground cleanup releases its engine claim and leaves the home and daemon claims complete', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const oldExit = process.exitCode;
    const root = join(home, 'engine');
    const build = 'aaaaaaaaaaaa';
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: build, version: '1' }));
    const ownEngine = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build });
    const releaseEngine = vi.fn<() => void>();
    const follower = vi.spyOn(engineFollow, 'followEngine').mockReturnValue({
      engine: { root, build },
      record: () => {},
      admit: async () => null,
      check: async () => null,
      release: releaseEngine,
    });
    let entered = () => {};
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const passes = vi.spyOn(daemonPasses, 'runHomePasses').mockImplementation(async ({ signal }) => {
      if (!signal) throw new Error('foreground signal missing');
      entered();
      await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }));
      throw Object.assign(new Error('fixture cleanup unverified'), {
        code: 'STIM_CLAIM_UNAVAILABLE',
        remedy: 'Inspect fixture child.',
        reportCleanup: true,
      });
    });
    let running: Promise<boolean> | undefined;
    try {
      process.exitCode = undefined;
      running = runStimd({ mode: 'on', tickMs: 60_000, attached: { handover: false } });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
      assert(handler);
      void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
      await started;
      handler('SIGTERM');
      await expect(running).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', retentionFailure: true });
      expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      expect(readClaimSet(daemonClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      expect(releaseEngine).toHaveBeenCalled();
    } finally {
      passes.mockRestore();
      follower.mockRestore();
      ownEngine.mockRestore();
      process.exitCode = oldExit;
      await running?.catch(() => {});
    }
  }, 20_000);

  test('an attached stimd ended by an unverified final measurement releases its engine claim and leaves the home claim complete', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const oldExit = process.exitCode;
    const root = join(home, 'engine');
    const build = 'aaaaaaaaaaaa';
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: build, version: '1' }));
    const ownEngine = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build });
    const releaseEngine = vi.fn<() => void>();
    const follower = vi.spyOn(engineFollow, 'followEngine').mockReturnValue({
      engine: { root, build },
      record: () => {},
      admit: async () => null,
      check: async () => null,
      release: releaseEngine,
    });
    const original = measure.measureTick;
    const measurement = vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
      if (args[2]?.probe === false)
        throw Object.assign(new Error('final measurement cleanup unverified'), {
          code: 'STIM_CLAIM_UNAVAILABLE',
          remedy: 'Inspect fixture child.',
          reportCleanup: true,
        });
      return original(...args);
    });
    let running: Promise<boolean> | undefined;
    try {
      process.exitCode = undefined;
      running = runStimd({ mode: 'on', tickMs: 60_000, attached: { handover: true } });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
      const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
      assert(handler);
      handler('SIGTERM');
      await expect(running).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      expect(releaseEngine).toHaveBeenCalled();
    } finally {
      measurement.mockRestore();
      follower.mockRestore();
      ownEngine.mockRestore();
      process.exitCode = oldExit;
      await running?.catch(() => {});
    }
  }, 20_000);

  const stopInProcess = (before: Set<NodeJS.SignalsListener | ((...args: never[]) => unknown)>) => {
    for (const listener of process.listeners('SIGTERM')) if (!before.has(listener)) listener('SIGTERM');
  };

  const daemonEvents = () =>
    existsSync(daemonNdjsonFile())
      ? readFileSync(daemonNdjsonFile(), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const logged: { event: string } = JSON.parse(line);
            return logged.event;
          })
      : [];

  test('a tick whose report child cleanup is unverified keeps stimd ticking and releases the retained claim once the child stops', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const retained = tryAcquireClaim({ root: join(home, 'fixture.lock'), mode: 'exclusive' }).acquired;
    assert(retained);
    let childGone = false;
    let ticks = 0;
    const passes = vi.spyOn(daemonPasses, 'runHomePasses').mockImplementation(async () => {
      ticks++;
      throw ticks === 1
        ? new WorkspaceProcessCleanupError(
            [retained],
            'Cannot verify cleanup for report child 85183; its process or descendants were left untouched.',
            'Inspect fixture child.',
            Object.assign(new Error('unverified'), {
              reportChild: { pid: 85183, processToken: null },
              reportResourceSettled: () => childGone,
            }),
          )
        : new Error('fixture tick stops here');
    });
    let running: Promise<boolean> | undefined;
    try {
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
      await vi.waitFor(() => expect(daemonEvents()).toContain('daemon_cleanup_unverified'), {
        timeout: 10_000,
        interval: 20,
      });
      expect(daemonEvents()).not.toContain('daemon_exited');
      expect(existsSync(stimdRecordFile())).toBe(true);
      expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      expect(readClaimSet(retained.root).live).toHaveLength(1);

      childGone = true;
      passes.mockImplementation(async ({ signal }) => {
        await new Promise((done) => signal?.addEventListener('abort', done, { once: true }));
        throw new Error('aborted');
      });
      void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
      await vi.waitFor(() => expect(daemonEvents()).toContain('daemon_cleanup_settled'), {
        timeout: 10_000,
        interval: 20,
      });
      expect(readClaimSet(retained.root).live).toEqual([]);

      const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
      assert(handler);
      handler('SIGTERM');
      await running;
      expect(readClaimSet(stimdClaimRoot())).toMatchObject({ live: [], unresolved: [] });
      expect(readClaimSet(daemonClaimRoot())).toMatchObject({ live: [], unresolved: [] });
    } finally {
      stopInProcess(before);
      await running?.catch(() => {});
      passes.mockRestore();
      releaseClaim(retained);
    }
  }, 20_000);

  test.each([
    ['one child that fails on two ticks is logged once', [0, 0], 1],
    ['two different children are each logged', [0, 1], 2],
  ])(
    'a stimd stopped while report children it could not verify still run releases its engine claim: %s',
    async (_name, order, logged) => {
      const before = new Set(process.listeners('SIGTERM'));
      const sleepers = [0, 1].map(() => spawnChild('sleep', ['30'], { detached: true, stdio: 'ignore' }));
      const exits = sleepers.map((sleeper) => new Promise((done) => sleeper.once('exit', done)));
      const children = sleepers.map((sleeper) => {
        assert(sleeper.pid);
        const captured = captureProcessIdentity(sleeper.pid);
        assert(captured.ok);
        return { pid: sleeper.pid, processToken: captured.token };
      });
      const root = join(home, 'engine');
      const build = 'aaaaaaaaaaaa';
      mkdirSync(root, { recursive: true });
      const ownEngine = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build });
      let ticks = 0;
      const passes = vi.spyOn(daemonPasses, 'runHomePasses').mockImplementation(async () => {
        const reportChild = children[order[Math.min(ticks, order.length - 1)] ?? 0];
        ticks++;
        throw Object.assign(new Error(`Cannot verify cleanup for report child ${reportChild?.pid}.`), {
          code: 'STIM_CLAIM_UNAVAILABLE',
          remedy: 'Inspect fixture child.',
          reportCleanup: true,
          reportChild,
          reportResourceSettled: () => false,
        });
      });
      let running: Promise<boolean> | undefined;
      try {
        running = runStimd({ mode: 'on', tickMs: 60_000 });
        await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
        for (const tick of order.keys()) {
          await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
          await vi.waitFor(() => expect(ticks).toBeGreaterThan(tick), { timeout: 10_000, interval: 20 });
        }
        await vi.waitFor(
          () => expect(daemonEvents().filter((event) => event === 'daemon_cleanup_unverified')).toHaveLength(logged),
          { timeout: 10_000, interval: 20 },
        );
        expect(daemonEvents()).not.toContain('daemon_exited');
        expect(readClaimSet(buildClaimRoot(root, build)).live).toHaveLength(1);
        stopInProcess(before);
        await running;
        expect(readClaimSet(buildClaimRoot(root, build))).toMatchObject({ live: [], unresolved: [] });
        expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
        expect(readClaimSet(daemonClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      } finally {
        stopInProcess(before);
        await running?.catch(() => {});
        passes.mockRestore();
        ownEngine.mockRestore();
        for (const sleeper of sleepers) sleeper.kill('SIGKILL');
        await Promise.all(exits);
      }
    },
    20_000,
  );

  test('a tick whose unverified cleanup names no child ends stimd as before', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const passes = vi.spyOn(daemonPasses, 'runHomePasses').mockRejectedValue(
      Object.assign(new Error('No ownership claim protects fingerprint evaluation.'), {
        code: 'STIM_CLAIM_UNAVAILABLE',
        remedy: 'Run stim doctor.',
        reportCleanup: true,
      }),
    );
    let running: Promise<boolean> | undefined;
    try {
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
      await running.catch(() => {});
      expect(daemonEvents()).toContain('daemon_exited');
      expect(daemonEvents()).not.toContain('daemon_cleanup_unverified');
      expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
    } finally {
      stopInProcess(before);
      await running?.catch(() => {});
      passes.mockRestore();
    }
  }, 20_000);

  test('a stimd that dies while a child cleanup is unverified leaves its home recoverable: a new stimd starts, and the claim guarding the child still refuses its work', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const sleeper = spawnChild('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = new Promise((done) => sleeper.once('exit', done));
    const ender = spawnChild('sleep', ['30'], { stdio: 'ignore' });
    const enderExited = new Promise((done) => ender.once('exit', done));
    assert(sleeper.pid && ender.pid);
    const childIdentity = captureProcessIdentity(sleeper.pid);
    const deadIdentity = captureProcessIdentity(ender.pid);
    assert(childIdentity.ok && deadIdentity.ok);
    const child = { pid: sleeper.pid, processToken: childIdentity.token };
    const dead = { pid: ender.pid, processToken: deadIdentity.token };
    ender.kill('SIGKILL');
    await enderExited;
    const guardRoot = join(home, 'native-run.lock');
    const guard = tryAcquireClaim({ root: guardRoot, mode: 'exclusive' }).acquired;
    assert(guard);
    setClaimChild(guard, child);
    const passes = vi
      .spyOn(daemonPasses, 'runHomePasses')
      .mockRejectedValue(
        new WorkspaceProcessCleanupError(
          [guard],
          `Cannot verify cleanup for report child ${child.pid}.`,
          'Inspect fixture child.',
          Object.assign(new Error('unverified'), { reportChild: child, reportResourceSettled: () => false }),
        ),
      );
    const ownedBy = (claimRoot: string, owner: typeof dead) => {
      for (const holder of readClaimSet(claimRoot).live) {
        const record: Record<string, unknown> = JSON.parse(readFileSync(holder.path, 'utf8'));
        writeFileSync(holder.path, JSON.stringify({ ...record, owner }));
      }
    };
    let running: Promise<boolean> | undefined;
    try {
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
      await vi.waitFor(() => expect(daemonEvents()).toContain('daemon_cleanup_unverified'), {
        timeout: 10_000,
        interval: 20,
      });
      expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      expect(readClaimSet(daemonClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
      stopInProcess(before);
      await running;
      passes.mockRestore();
      for (const claimRoot of [stimdClaimRoot(), daemonClaimRoot(), guardRoot]) ownedBy(claimRoot, dead);

      expect(readClaimSet(stimdClaimRoot()).unresolved).toEqual([]);
      expect(readClaimSet(daemonClaimRoot()).unresolved).toEqual([]);
      const restarted = new Set(process.listeners('SIGTERM'));
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      expect(tryAcquireClaim({ root: guardRoot, mode: 'exclusive' })).toMatchObject({ held: { child } });
      stopInProcess(restarted);
      await running;
    } finally {
      stopInProcess(before);
      await running?.catch(() => {});
      passes.mockRestore();
      sleeper.kill('SIGKILL');
      await exited;
    }
  }, 20_000);

  test('a start refuses once and names every unresolved home, daemon and engine claim, and starts once each records an exited child', async () => {
    const started = new Set(process.listeners('SIGTERM'));
    let running: Promise<boolean> | undefined;
    const sleeper = spawnChild('sleep', ['30'], { stdio: 'ignore' });
    assert(sleeper.pid);
    const captured = captureProcessIdentity(sleeper.pid);
    assert(captured.ok);
    sleeper.kill('SIGKILL');
    await new Promise((done) => sleeper.once('exit', done));
    const gone = { pid: sleeper.pid, processToken: captured.token };
    const root = join(home, 'engine');
    const build = 'aaaaaaaaaaaa';
    const otherHome = join(home, 'other-home');
    const engine = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build });
    try {
      const pending = [stimdClaimRoot(), daemonClaimRoot(), buildClaimRoot(root, build)].map((claimRoot) => {
        const held = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', details: { home: otherHome } }).acquired;
        assert(held);
        markClaimChildPending(held);
        const record: Record<string, unknown> = JSON.parse(readFileSync(held.path, 'utf8'));
        writeFileSync(held.path, JSON.stringify({ ...record, owner: gone }));
        return held.path;
      });
      const foreign = join(daemonClaimRoot(), 'shared');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'stray'), '');
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      const refusal = await Promise.race([
        running.then(
          () => null,
          (error: { code: string; message: string; remedy: string }) => error,
        ),
        new Promise<null>((done) => setTimeout(() => done(null), 5000)),
      ]);
      expect(refusal?.code).toBe('STIM_CLAIM_UNAVAILABLE');
      expect(refusal?.message).toContain(`for the Stim home ${otherHome}`);
      expect(refusal?.remedy).toContain(otherHome);
      for (const path of pending) {
        expect(refusal?.message).toContain(path);
        expect(refusal?.remedy).toContain(path);
      }
      expect(refusal?.message).toContain(foreign);
      rmSync(foreign, { recursive: true });

      for (const path of pending)
        writeFileSync(`${path.slice(0, -'.claim'.length)}.child`, JSON.stringify({ record: gone }));
      const before = new Set(process.listeners('SIGTERM'));
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
      assert(handler);
      handler('SIGTERM');
      await running;
      expect(existsSync(stimdRecordFile())).toBe(false);
    } finally {
      stopInProcess(started);
      await running?.catch(() => {});
      engine.mockRestore();
    }
  }, 20_000);

  test('a command that meets a stuck shared engine claim refuses with every claim, its home and the remove command', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-engine-refusal-')));
    const root = join(scratch, 'engine');
    const build = 'cccccccccccc';
    const selected = join(root, build);
    const pkg = fileURLToPath(new URL('../..', import.meta.url));
    mkdirSync(join(selected, 'dist'), { recursive: true });
    cpSync(join(pkg, 'dist'), join(selected, 'dist'), { recursive: true });
    cpSync(join(pkg, 'package.json'), join(selected, 'package.json'));
    fs.symlinkSync(join(pkg, 'node_modules'), join(selected, 'node_modules'), 'junction');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: build, version: 'test' }));
    const otherHome = join(scratch, 'other-home');
    const held = tryAcquireClaim({
      root: buildClaimRoot(root, build),
      mode: 'shared',
      details: { home: otherHome },
    }).acquired;
    assert(held);
    markClaimChildPending(held);
    writeFileSync(held.path, readFileSync(held.path, 'utf8').replace(/"processToken":"[^"]*"/, '"processToken":"x"'));
    const executor = getExecutor();
    const children: ChildProcess[] = [];
    setExecutor({
      ...executor,
      spawn: (_file, args = [], options) => {
        const child = executor.spawn(process.execPath, [join(selected, 'dist', 'cli.mjs'), ...args.slice(1)], options);
        children.push(child);
        return child;
      },
    });
    const cli = Symbol.for('stim.cli');
    Reflect.set(globalThis, cli, true);
    try {
      const env = { ...process.env, STIM_HOME: home, STIM_ENGINE_ROOT: root, STIM_DAEMON: 'on', XDG_RUNTIME_DIR: '' };
      const refusal = await ensureStimd(env, 'linux').then(
        () => null,
        (error: { code: string; message: string; remedy: string }) => error,
      );
      expect(refusal?.code).toBe('STIM_CLAIM_UNAVAILABLE');
      expect(refusal?.message).toContain(held.path);
      expect(refusal?.message).toContain(`for the Stim home ${otherHome}`);
      expect(refusal?.remedy).toContain(claimRemoveCommand(held.path));
      expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, cli);
      resetExecutor();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((done) => child.once('exit', done));
          child.kill('SIGKILL');
          await exited;
        }
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  test.each(['passes', 'measure'])(
    'a %s thread cleanup the thread watches keeps stimd up until the thread finds the child stopped, then stimd releases its claims as usual',
    async (worker) => {
      const before = new Set(process.listeners('SIGTERM'));
      let stopped = false;
      let failed = false;
      const settle = vi.fn<() => void>();
      const actual = await vi.importActual<typeof stimdThreads>('../stimd/threads.ts');
      const lane = vi.spyOn(stimdThreads, 'createPassesLane').mockImplementation(actual.createPassesLane);
      const threads = vi.spyOn(stimdThreads, 'createThreadTable').mockReturnValue({
        run: async (name) => {
          if (name !== worker) return [];
          if (failed) return [];
          failed = true;
          throw Object.assign(new Error('Report child 4242 did not close within the cleanup budget.'), {
            code: 'STIM_CLAIM_UNAVAILABLE',
            remedy: 'Inspect fixture child.',
            reportCleanup: true,
            reportChild: { pid: 4242, processToken: 'fixture' },
            cleanupSettled: () => stopped,
          });
        },
        abort: () => {},
        settle,
        close: async () => {},
      });
      let running: Promise<boolean> | undefined;
      try {
        running = runStimd({ mode: 'on', tickMs: 60_000 });
        await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
        void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
        await vi.waitFor(() => expect(daemonEvents()).toContain('daemon_cleanup_unverified'), {
          timeout: 10_000,
          interval: 20,
        });
        void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
        await vi.waitFor(() => expect(settle).toHaveBeenCalled(), { timeout: 10_000, interval: 20 });
        expect(daemonEvents()).not.toContain('daemon_exited');
        expect(daemonEvents()).not.toContain('daemon_cleanup_settled');
        const waiting = daemonStatus();
        expect(waiting.unverified).toEqual([
          {
            since: expect.any(String),
            child: 4242,
            message: 'Report child 4242 did not close within the cleanup budget.',
            remedy: expect.stringMatching(/^Inspect fixture child\. The wait ends once child 4242 .*`kill \d+`/),
          },
        ]);
        expect(daemonFindings(waiting, { serving: () => [] })).toContainEqual(
          expect.objectContaining({ fix: waiting.unverified?.[0]?.remedy }),
        );
        stopped = true;
        void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
        await vi.waitFor(() => expect(daemonEvents()).toContain('daemon_cleanup_settled'), {
          timeout: 10_000,
          interval: 20,
        });
        expect(daemonStatus().unverified).toBeUndefined();
        stopInProcess(before);
        await running;
        expect(readClaimSet(stimdClaimRoot())).toMatchObject({ live: [], unresolved: [] });
        expect(readClaimSet(daemonClaimRoot())).toMatchObject({ live: [], unresolved: [] });
      } finally {
        stopInProcess(before);
        await running?.catch(() => {});
        threads.mockRestore();
        lane.mockRestore();
      }
    },
    30_000,
  );

  test('stopping stimd while it waits for a child is safe: its claims stay complete, the boot is not abnormal, and the next stimd starts', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const threads = vi.spyOn(stimdThreads, 'createThreadTable').mockReturnValue({
      run: async (name) => {
        if (name !== 'measure') return [];
        throw Object.assign(new Error('Report child 4242 did not close within the cleanup budget.'), {
          code: 'STIM_CLAIM_UNAVAILABLE',
          remedy: 'Inspect fixture child.',
          reportCleanup: true,
          reportChild: { pid: 4242, processToken: 'fixture' },
          cleanupSettled: () => false,
        });
      },
      abort: () => {},
      settle: () => {},
      close: async () => {},
    });
    let running: Promise<boolean> | undefined;
    try {
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' }).catch(() => false);
      await vi.waitFor(() => expect(daemonEvents()).toContain('daemon_cleanup_unverified'), {
        timeout: 10_000,
        interval: 20,
      });
      stopInProcess(before);
      await running;
      for (const claimRoot of [stimdClaimRoot(), daemonClaimRoot()])
        expect(readClaimSet(claimRoot)).toMatchObject({ live: [{ childDeclared: false }], unresolved: [] });
      const [own] = readClaimSet(stimdClaimRoot()).live;
      expect(parseBoots(own?.details.boots).some((boot) => boot.abnormal)).toBe(false);
      threads.mockRestore();
      const gone = goneClaimOwner();
      for (const claimRoot of [stimdClaimRoot(), daemonClaimRoot()])
        for (const holder of readClaimSet(claimRoot).live) {
          const record: Record<string, unknown> = JSON.parse(readFileSync(holder.path, 'utf8'));
          writeFileSync(holder.path, JSON.stringify({ ...record, owner: gone }));
        }
      const starts = () => daemonEvents().filter((event) => event === 'daemon_started').length;
      const startedBefore = starts();
      const restarted = new Set(process.listeners('SIGTERM'));
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(starts()).toBe(startedBefore + 1), {
        timeout: 10_000,
        interval: 20,
      });
      stopInProcess(restarted);
      await running;
    } finally {
      stopInProcess(before);
      threads.mockRestore();
      await running?.catch(() => {});
    }
  }, 30_000);

  test.each(['passes', 'measure'])(
    'a %s cleanup refusal that names no child ends stimd, leaves every stimd claim recoverable, and the next stimd starts',
    async (worker) => {
      const before = new Set(process.listeners('SIGTERM'));
      const oldExit = process.exitCode;
      const root = join(home, 'engine');
      const build = 'aaaaaaaaaaaa';
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: build, version: '1' }));
      const engine = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build });
      const failure = new WorkspaceProcessCleanupError(
        [],
        'fixture background cleanup unverified',
        'Inspect fixture child.',
      );
      const threads = vi.spyOn(stimdThreads, 'createThreadTable').mockReturnValue({
        run: async (name) => {
          if (worker === 'measure' && name === 'measure') throw failure;
          return [];
        },
        abort: () => {},
        settle: () => {},
        close: async () => {},
      });
      const lane = vi.spyOn(stimdThreads, 'createPassesLane').mockImplementation((_threads, _log, onFailure) => ({
        start: () => {
          if (worker === 'passes') queueMicrotask(() => onFailure?.(failure));
        },
        running: () => false,
        take: () => [],
        settled: async () => {},
      }));
      let running: Promise<boolean> | undefined;
      try {
        process.exitCode = undefined;
        running = runStimd({ mode: 'on', tickMs: 60_000 });
        await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
        void requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
        await running;
        expect(readClaimSet(stimdClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
        expect(readClaimSet(daemonClaimRoot()).live).toMatchObject([{ childDeclared: false }]);
        expect(readClaimSet(buildClaimRoot(root, build))).toMatchObject({ live: [], unresolved: [] });
        lane.mockRestore();
        threads.mockRestore();
        const gone = goneClaimOwner();
        for (const claimRoot of [stimdClaimRoot(), daemonClaimRoot()])
          for (const holder of readClaimSet(claimRoot).live) {
            const record: Record<string, unknown> = JSON.parse(readFileSync(holder.path, 'utf8'));
            writeFileSync(holder.path, JSON.stringify({ ...record, owner: gone }));
          }
        const restarted = new Set(process.listeners('SIGTERM'));
        running = runStimd({ mode: 'on', tickMs: 60_000 });
        await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
        expect(readClaimSet(buildClaimRoot(root, build)).live).toHaveLength(1);
        stopInProcess(restarted);
        await running;
      } finally {
        stopInProcess(before);
        lane.mockRestore();
        threads.mockRestore();
        engine.mockRestore();
        process.exitCode = oldExit;
        await running?.catch(() => {});
      }
    },
    20_000,
  );

  test('publishes an existing Metro claim build when the engine follower starts', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    const project = join(home, 'project');
    mkdirSync(project);
    upsertProject(project, { metroPort: 8181 });
    const metro = tryAcquireClaim({
      root: join(workspaceDir(project), 'metro.claim'),
      mode: 'exclusive',
      details: { engineDir: 'bbbbbbbbbbbb' },
    }).acquired;
    assert(metro);
    const record = vi.fn<(pinned: boolean, engineDirs: string[]) => void>();
    const follow = vi.spyOn(engineFollow, 'followEngine').mockReturnValue({
      engine: { root: join(home, 'engine'), build: 'aaaaaaaaaaaa' },
      record,
      admit: async () => null,
      check: async () => null,
      release: () => {},
    });
    let running: Promise<boolean> | undefined;
    try {
      running = runStimd({ mode: 'on', tickMs: 60_000 });
      await vi.waitFor(() => expect(record).toHaveBeenCalled(), { timeout: 10_000, interval: 20 });
      expect(record.mock.calls[0]).toEqual([false, ['bbbbbbbbbbbb']]);
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000, interval: 20 });
      const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
      assert(handler);
      handler('SIGTERM');
      await running;
    } finally {
      follow.mockRestore();
      releaseClaim(metro);
      await running?.catch(() => {});
    }
  }, 20_000);

  test('only a persistent daemon can enforce deferred simulator shutdown', async () => {
    const attached = getExecutor().spawn(
      process.execPath,
      ['--experimental-strip-types', entry, '__stimd', '--attached'],
      {
        env: { ...process.env, STIM_DAEMON: 'on' },
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    const attachedExited = new Promise<number | null>((done) => attached.once('exit', (code) => done(code)));
    daemons.push({ child: attached, exited: attachedExited });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).pid).toBe(attached.pid), {
      timeout: 10_000,
      interval: 20,
    });
    expect(await ensurePersistentStimd({ ...process.env, STIM_DAEMON: 'on' })).toBe(false);
    attached.stdin?.end();
    await attachedExited;

    const persistent = getExecutor().spawn(
      process.execPath,
      ['--experimental-strip-types', entry, '__stimd', '--mode', 'report'],
      {
        env: { ...process.env, STIM_DAEMON: 'on' },
        stdio: 'ignore',
      },
    );
    const persistentExited = new Promise<number | null>((done) => persistent.once('exit', (code) => done(code)));
    daemons.push({ child: persistent, exited: persistentExited });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).pid).toBe(persistent.pid), {
      timeout: 10_000,
      interval: 20,
    });
    expect(await ensurePersistentStimd({ ...process.env, STIM_DAEMON: 'on' })).toBe(false);
    persistent.kill('SIGTERM');
    await persistentExited;

    const acting = getExecutor().spawn(
      process.execPath,
      ['--experimental-strip-types', entry, '__stimd', '--mode', 'on'],
      {
        env: { ...process.env, STIM_DAEMON: 'on' },
        stdio: 'ignore',
      },
    );
    const actingExited = new Promise<number | null>((done) => acting.once('exit', (code) => done(code)));
    daemons.push({ child: acting, exited: actingExited });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).pid).toBe(acting.pid), {
      timeout: 10_000,
      interval: 20,
    });
    expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).build).toBe(stimdBuildId());
    expect(await ensurePersistentStimd({ ...process.env, STIM_DAEMON: 'on' })).toBe(true);
  }, 30_000);

  test('the built stimd answers a first frame of its own build, refuses another build, holds the daemon claim shared and removes its record on SIGTERM', async () => {
    const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
    const build = stimBuildId(dist);
    assert(build);
    const child = getExecutor().spawn(process.execPath, [join(dist, 'cli.mjs'), '__stimd', '--mode', 'report'], {
      env: { ...process.env },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    daemons.push({ child, exited });
    await listening();
    const record = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    expect(record).toEqual({ format: 1, pid: child.pid, socket: stimdSocket(), build, version: expect.any(String) });
    expect(fs.statSync(stimdSocket()).mode & 0o777).toBe(0o600);
    const ask = (first: Record<string, unknown>) =>
      new Promise<string[]>((done) => {
        const socket = connect(record.socket);
        const received = lines(socket);
        socket.once('connect', () => socket.write(`${JSON.stringify(first)}\n${JSON.stringify({ op: 'hello' })}\n`));
        socket.once('close', () => done(received.map((line) => JSON.parse(line).op)));
      });
    expect(await ask({ kind: 'cli', build })).toEqual(['hello', 'hello']);
    expect(await ask({ kind: 'cli', build: 'f'.repeat(12) })).toEqual(['engine-changed']);
    expect(await ask({ op: 'hello' })).toEqual(['error']);
    const taker = tryAcquireClaim({ root: daemonClaimRoot(), mode: 'exclusive', label: 'stim-daemon' });
    if (taker.pending) releaseClaim(taker.pending);
    expect(taker.acquired).toBeUndefined();
    expect(taker.waitingFor?.map((holder) => [holder.owner.pid, holder.mode]) ?? taker.held?.owner.pid).toEqual([
      [child.pid, 'shared'],
    ]);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(stimdRecordFile())).toBe(false);
    expect(existsSync(stimdSocket())).toBe(false);
    expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
  }, 20_000);

  test('a tick request is answered when a tick finishes, and the snapshot carries the pressure level', async () => {
    startDaemonProcess();
    await listening();
    await expect(requestDaemonTick({ STIM_DAEMON: 'on' })).resolves.toBe(true);
    expect(readDaemonSnapshot()).toMatchObject({
      pressure: { level: expect.stringMatching(/^(normal|high|critical)$/) },
      actions: expect.any(Array),
      waiting: [],
    });
  }, 20_000);

  test('stopping stimd stops the active dependency walk before it exits', async () => {
    const [, linked] = idleWorkspaces();
    assert(linked);
    const tree = join(realpathSync(linked), 'node_modules');
    mkdirSync(tree);
    normalMeasurement();
    const helper = vi.spyOn(clonefile, 'privateSizeHelper').mockResolvedValue(null);
    const maintenance = vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();
    const build = vi
      .spyOn(spawnEntry, 'stimBuild')
      .mockReturnValue({ installed: false, digest: null, version: '1.40.0' });
    const real = getExecutor();
    let child: ChildProcess | undefined;
    let walk: Promise<string> | undefined;
    setExecutor({
      ...real,
      runFileAsync(file, args, options) {
        if (file !== 'nice' || args.at(-1) !== tree) return real.runFileAsync(file, args, options);
        walk = real.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
          ...options,
          onSpawn(spawned) {
            options.onSpawn?.(spawned);
            child = spawned;
          },
        });
        return walk;
      },
    });
    onTestFinished(() => {
      resetExecutor();
      helper.mockRestore();
      maintenance.mockRestore();
      build.mockRestore();
    });

    const running = runStimd({ mode: 'report' });
    try {
      await listening();
      await expect(requestDaemonTick({ STIM_DAEMON: 'report' })).resolves.toBe(true);
      await vi.waitFor(() => expect(child?.pid).toBeGreaterThan(1), { timeout: 10_000 });
      assert(child);
      expect(readClaimSet(diskUsageWalkClaims()).live[0]?.child?.pid).toBe(child.pid);
      await stopStimd();
      await running;
      expect(child.signalCode).toBe('SIGKILL');
      expect(readClaimSet(diskUsageWalkClaims()).live).toEqual([]);
      expect(readDiskUsage(tree)).toBeNull();
    } finally {
      child?.kill('SIGKILL');
      await walk?.catch(() => {});
      if (existsSync(stimdRecordFile())) await stopStimd();
      await running;
    }
  }, 25_000);

  test('exits after two ticks with nothing running in its home, releasing its claim and removing its socket', async () => {
    const measureTick = measure.measureTick;
    const normal = vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
      const measured = await measureTick(...args);
      return {
        ...measured,
        measurement: {
          ...measured.measurement,
          disk: [{ volume: '/', freeMb: 500_000 }],
          memory: { level: 'normal', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        },
      };
    });
    onTestFinished(() => normal.mockRestore());
    await runStimd({ tickMs: 50 });
    expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
    expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
    expect(existsSync(stimdSocket())).toBe(false);
    expect(existsSync(stimdRecordFile())).toBe(false);
    expect(daemonLog().match(/"event":"daemon_tick"/g)).toHaveLength(2);
    expect(readDaemonSnapshot()).toMatchObject({ mode: 'on', intervalMs: 250, workspaces: [] });
  }, 20_000);

  test('exits when its run directory is removed from a home that remains', async () => {
    normalMeasurement();
    const running = runStimd({ mode: 'on', tickMs: 60_000, homeWatchMs: 50 });
    await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000 });
    rmSync(dirname(stimdRecordFile()), { recursive: true });
    await running;
    expect(daemonLog()).toContain('its run directory was removed');
  }, 20_000);

  function normalMeasurement(level: 'normal' | 'warning' = 'normal'): void {
    const measureTick = measure.measureTick;
    const normal = vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
      const measured = await measureTick(...args);
      return {
        ...measured,
        measurement: {
          ...measured.measurement,
          disk: [{ volume: '/', freeMb: 500_000 }],
          memory: { level, availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        },
      };
    });
    onTestFinished(() => normal.mockRestore());
  }

  function daemonRecords<T>(event: string): T[] {
    return daemonLog()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === event);
  }

  const loopDelays = () =>
    daemonRecords<{ eventLoopDelay: { maxMs: number } }>('daemon_tick').map((tick) => tick.eventLoopDelay.maxMs);
  const maintenanceMs = () =>
    daemonRecords<{ phases: { maintenanceMs: number } }>('daemon_maintenance')[0]?.phases.maintenanceMs;

  test.skipIf(process.platform !== 'darwin')(
    "under memory pressure, the tick's maintenance pass names memory culprits from a slow top without blocking the event loop",
    async () => {
      normalMeasurement('warning');
      const real = getExecutor();
      const slowTop = ['-e', `setTimeout(() => process.stdout.write('PID MEM COMMAND\\n123 80G fseventsd\\n'), 600)`];
      setExecutor({
        ...real,
        runFileQuietAsync: (file, args, options) =>
          file === '/usr/bin/top'
            ? real.runFileQuietAsync(process.execPath, slowTop, options)
            : real.runFileQuietAsync(file, args, options),
      });
      process.env.STIM_DAEMON = 'report';
      onTestFinished(() => {
        resetExecutor();
        delete process.env.STIM_DAEMON;
      });
      await runStimd({ tickMs: 50 });
      expect(readFileSync(gcLogFile(), 'utf8')).toContain('fseventsd (pid 123) uses 80.0G');
      expect(maintenanceMs()).toBeGreaterThanOrEqual(600);
      expect(Math.max(...loopDelays())).toBeLessThan(500);
    },
    20_000,
  );

  let sims: { udid: string; name: string; state: 'Booted' | 'Shutdown' }[] = [];

  function toolOutput(file: string, args: readonly string[]): string {
    const name = file.split('/').at(-1);
    if (name === 'xcrun' && args.includes('list'))
      return JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': sims.map((sim) => ({
            ...sim,
            isAvailable: true,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
            dataPathSize: 1,
          })),
        },
      });
    if (name === 'xcrun' && args[1] === 'shutdown') {
      sims = sims.map((sim) => (sim.udid === args[2] ? { ...sim, state: 'Shutdown' } : sim));
      return '';
    }
    if (name === 'sysctl') return '1\n';
    if (name === 'adb' && args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice\n';
    if (name === 'adb') return 'stim-other\nOK\n';
    if (name === 'vm_stat')
      return 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 1.\nPages speculative: 1.\n';
    return '';
  }

  function asyncOnlyTools(): { sync: string[]; async: string[] } {
    sims = [{ udid: 'UDID-1', name: 'stim-app (iPhone 16 18.0)', state: 'Shutdown' }];
    const real = getExecutor();
    const calls: { sync: string[]; async: string[] } = { sync: [], async: [] };
    const refuse = (file: string, args: readonly string[] = []): never => {
      calls.sync.push([file, ...args].join(' '));
      throw new Error(`synchronous ${file} in a daemon tick`);
    };
    setExecutor({
      ...real,
      run: (command: string) => refuse(command),
      runQuiet: (command: string) => refuse(command),
      runFile: (file: string, args: string[]) => refuse(file, args),
      runFileQuiet: (file: string, args: string[]) => refuse(file, args),
      spawn: (file: string, args: readonly string[] = []) => refuse(file, args),
      runFileAsync: async (file: string, args: string[], options) => {
        calls.async.push([file, ...args].join(' '));
        return file === 'git' ? real.runFileAsync(file, args, options) : toolOutput(file, args);
      },
      runFileQuietAsync: async (file: string, args: string[], options) => {
        calls.async.push([file, ...args].join(' '));
        return file === 'git' ? real.runFileQuietAsync(file, args, options) : toolOutput(file, args);
      },
    });
    onTestFinished(() => resetExecutor());
    return calls;
  }

  function syncListings(): () => string[] {
    const listed = vi.spyOn(fs, 'readdirSync');
    syncBuiltinESMExports();
    onTestFinished(() => {
      listed.mockRestore();
      syncBuiltinESMExports();
    });
    return () => listed.mock.calls.map(([path]) => String(path));
  }

  function idleWorkspaces(): string[] {
    const git = (cwd: string, ...args: string[]) =>
      getExecutor().runFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, timeoutMs: 10_000 });
    const repo = join(home, 'repo');
    const linked = join(home, 'linked');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    for (const root of [repo, linked]) {
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');
      ensureWorkspaceStorage(root);
      upsertProject(root, {
        platforms: { ios: { deviceUdid: 'UDID-1', owned: true }, android: { avdName: 'stim-app', owned: true } },
      });
      recordWorkspaceUse(root, new Date(Date.now() - 30 * 86_400_000));
    }
    return [repo, linked];
  }

  test('a tick with every maintenance check due, the dormant stage due and disk pressure high starts no child process synchronously and lists no directory synchronously', async () => {
    const roots = idleWorkspaces();
    for (const root of roots) {
      mkdirSync(macosDir(root), { recursive: true });
      mkdirSync(join(root, 'node_modules'));
    }
    const config = loadConfig();
    assert(config);
    saveConfig({ ...config, idle: { dormantDays: 0.000_001 } });
    process.env.STIM_DAEMON = 'on';
    process.env.STIM_DISK_MIN_FREE_GB = '100000000';
    onTestFinished(() => {
      delete process.env.STIM_DAEMON;
      delete process.env.STIM_DISK_MIN_FREE_GB;
    });
    vi.spyOn(maintenanceMeasure, 'sizeScanDeferred').mockReturnValue(false);
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const calls = asyncOnlyTools();
    const listed = syncListings();

    const passes = await runHomePasses({ act: true, log: () => {} });
    const lane = createMaintenanceLane(() => {});
    lane.start(passes, true);
    await lane.settled();

    expect(passes.pressure.level).not.toBe('normal');
    expect(readMaintenanceState()?.lastPass?.trigger).toBe('daemon');
    expect(calls.sync).toEqual([]);
    expect(listed().filter((path) => path === tmpdir() || roots.includes(path))).toEqual([]);
  }, 60_000);

  test.skipIf(process.platform !== 'darwin')(
    'a tick that idles a workspace with an owned booted simulator, then re-checks it for a waiting run, starts no child process and lists no project directory synchronously',
    async () => {
      const root = join(home, 'booted');
      mkdirSync(root);
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');
      ensureWorkspaceStorage(root);
      upsertProject(root, {
        platforms: {
          ios: { deviceUdid: 'UDID-B', owned: true },
          android: { avdName: 'stim-app', owned: true, consolePort: 5554 },
        },
      });
      recordCreatedDevice('ios', 'UDID-B');
      recordWorkspaceUse(root, new Date(Date.now() - 30 * 86_400_000));
      const waiting = join(home, 'waiting');
      mkdirSync(waiting);
      const ticket = takeWaitTicket('boot', { platform: 'ios', key: 'new', root: waiting, displayName: 'waiting' }, []);
      process.env.STIM_DAEMON = 'on';
      process.env.STIM_MAX_DEVICES = '1';
      onTestFinished(() => {
        releaseClaim(ticket);
        delete process.env.STIM_DAEMON;
        delete process.env.STIM_MAX_DEVICES;
      });
      vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const calls = asyncOnlyTools();
      const listed = syncListings();
      sims = [{ udid: 'UDID-B', name: 'stim-booted (iPhone 16 18.0)', state: 'Booted' }];

      const passes = await runHomePasses({ act: true, log: () => {} });
      const reclaimed = await reclaimForBootWaiters({
        devices: passes.measured.devices,
        sims: passes.measured.sims,
        act: true,
        log: () => {},
        operation: passes.operation,
      });

      expect(calls.sync).toEqual([]);
      expect(listed().filter((path) => path === root)).toEqual([]);
      expect(passes.workspaces).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
      expect(sims).toEqual([expect.objectContaining({ udid: 'UDID-B', state: 'Shutdown' })]);
      expect(reclaimed).toMatchObject({
        target: 'UDID-B',
        outcome: 'kept',
        detail: expect.stringContaining('no longer idle'),
      });
    },
    60_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    "a tick's maintenance pass takes memory pressure and simulator sizes from the tick's measurement instead of reading them again",
    async () => {
      idleWorkspaces();
      process.env.STIM_DAEMON = 'on';
      onTestFinished(() => {
        delete process.env.STIM_DAEMON;
      });
      vi.spyOn(maintenanceMeasure, 'sizeScanDeferred').mockReturnValue(false);
      vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const measureTick = measure.measureTick;
      vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
        const measured = await measureTick(...args);
        return {
          ...measured,
          sims: measured.sims?.map((sim) => ({ ...sim, dataPathSize: 4096 })) ?? null,
          measurement: {
            ...measured.measurement,
            memory: { level: 'warning', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
          },
        };
      });
      const calls = asyncOnlyTools();

      const lane = createMaintenanceLane(() => {});
      lane.start(await runHomePasses({ act: false, log: () => {} }), false);
      await lane.settled();

      const state = readMaintenanceState();
      expect(state?.pressure?.memory.level).toBe('warning');
      expect(state?.sizes).toContainEqual(
        expect.objectContaining({
          category: 'owned-devices',
          name: 'owned simulator stim-app (iPhone 16 18.0)',
          bytes: 4096,
        }),
      );
      expect(calls.async.filter((call) => call.includes('kern.memorystatus_vm_pressure_level'))).toHaveLength(1);
    },
    60_000,
  );

  test('a tick that fails hands the timers back: the daemon releases its claim and exits instead of holding it idle', async () => {
    writeFileSync(join(home, 'config.json'), '{ not json');
    await runStimd({ tickMs: 50 });
    expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
    expect(existsSync(stimdSocket())).toBe(false);
  }, 20_000);

  test('a command starts the daemon in the mode it resolved, with its locations, CI and non-sensitive setting overrides only', async () => {
    const spawned: { args: readonly string[]; options: SpawnOptions | undefined }[] = [];
    setExecutor({
      ...getExecutor(),
      spawn(_file, args = [], options) {
        spawned.push({ args, options });
        throw new Error('not started in this test');
      },
    });
    onTestFinished(() => resetExecutor());
    const kept = {
      PATH: '/usr/bin:/bin',
      CI: '1',
      STIM_HOME: home,
      STIM_DAEMON: 'report',
      STIM_DISK_MIN_FREE_GB: '12',
      STIM_MAINTENANCE_IDLE_STOP_HOURS: '2',
      AGENT_DEVICE_CLAIMS_DIR: '/claims',
      ANDROID_SDK_HOME: '/android',
      ANDROID_ADB_SERVER_PORT: '5038',
      GRADLE_USER_HOME: '/gradle',
      XDG_CONFIG_HOME: '/config',
      XDG_CACHE_HOME: '/cache',
    };
    const dropped = {
      API_TOKEN: 'secret',
      NODE_OPTIONS: '--inspect',
      GRADLE_ENTERPRISE_ACCESS_KEY: 'secret',
      GRADLE_OPTS: '-Dorg.gradle.project.signingPassword=secret',
      XDG_RUNTIME_DIR: '/run',
      STIM_ASC_KEY_PATH: '/keys/AuthKey.p8',
    };

    expect(await ensureStimd({ ...kept, ...dropped }, 'linux')).toBe(false);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args.slice(1)).toEqual(['__stimd', '--mode', 'report']);
    expect(spawned[0]?.options?.env).toEqual(kept);
  });

  describe('a Linux command starts the daemon as a transient user service so a runner that kills the call cannot reach it', () => {
    const systemdEnv = () => ({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      STIM_HOME: home,
      STIM_DAEMON: 'on',
      XDG_RUNTIME_DIR: '/run/user/1000',
      API_TOKEN: 'secret',
    });

    function mockExecutor(runFile: (file: string, args: string[]) => string) {
      const spawned: (readonly string[])[] = [];
      setExecutor({
        ...getExecutor(),
        findExecutable: (name: string) => (name === 'systemd-run' ? '/usr/bin/systemd-run' : null),
        runFile,
        spawn(_file, args = []) {
          spawned.push(args);
          return spawnChild(process.execPath, ['-e', ''], { stdio: 'ignore' });
        },
      });
      onTestFinished(() => resetExecutor());
      return spawned;
    }

    test('systemd-run carries the daemon command and its environment, and no daemon is spawned as a child', async () => {
      const runs: { file: string; args: string[] }[] = [];
      let service: Promise<boolean> | undefined;
      const spawned = mockExecutor((file, args) => {
        runs.push({ file, args });
        setTimeout(() => (service = runStimd({ tickMs: 60_000, mode: 'on' })), 300);
        return '';
      });

      expect(await ensureStimd(systemdEnv(), 'linux')).toBe(true);

      expect(spawned).toEqual([]);
      expect(runs).toHaveLength(1);
      const [run] = runs;
      assert(run);
      const { file, args } = run;
      expect(file).toBe('/usr/bin/systemd-run');
      expect(args).toEqual(
        expect.arrayContaining([
          '--user',
          '--quiet',
          '--collect',
          '--property=KillMode=process',
          `--working-directory=${join(home, 'run')}`,
        ]),
      );
      expect(args.filter((arg) => arg.startsWith('--setenv='))).toEqual(
        expect.arrayContaining(['--setenv=PATH=/usr/bin', '--setenv=HOME=/home/agent', `--setenv=STIM_HOME=${home}`]),
      );
      expect(args.join(' ')).not.toContain('API_TOKEN');
      expect(args.join(' ')).not.toContain('XDG_RUNTIME_DIR');
      expect(args.slice(args.indexOf('--') + 1)).toEqual([
        process.execPath,
        expect.stringMatching(/cli\.mjs$|bin[\\/]cli\.ts$/),
        '__stimd',
        '--mode',
        'on',
      ]);
      expect(args.find((arg) => arg.startsWith('--unit='))).toMatch(/^--unit=stimd-[0-9a-f]{8}-[0-9a-f]{6}$/);

      await stopStimd();
      await service;
    }, 20_000);

    test('a manager that does not answer leaves the daemon a detached child, as before', async () => {
      const spawned = mockExecutor(() => {
        throw new Error('Failed to connect to bus');
      });

      expect(await ensureStimd(systemdEnv(), 'linux')).toBe(false);

      expect(spawned).toHaveLength(1);
    });

    test.each([
      ['another platform', 'freebsd', '/run/user/1000'],
      ['no user runtime directory', 'linux', undefined],
    ] as const)('%s uses no service', async (_name, platform, runtime) => {
      let runs = 0;
      const spawned = mockExecutor(() => {
        runs++;
        return '';
      });

      expect(await ensureStimd({ ...systemdEnv(), XDG_RUNTIME_DIR: runtime }, platform)).toBe(false);

      expect(runs).toBe(0);
      expect(spawned).toHaveLength(1);
    });
  });

  test('a command counts the home as held only once the daemon it started takes the claim', async () => {
    const env = { ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' };
    setExecutor({ ...getExecutor(), spawn: () => spawnChild(process.execPath, ['-e', ''], { stdio: 'ignore' }) });
    try {
      expect(await ensureStimd(env, 'linux')).toBe(false);
    } finally {
      resetExecutor();
    }

    expect(await ensureStimd(env, 'linux')).toBe(true);
    const [holder] = readClaimSet(stimdClaimRoot()).live;
    assert(holder);
    process.kill(holder.owner.pid, 'SIGTERM');
    await vi.waitFor(() => expect(readClaimSet(daemonClaimRoot()).live).toEqual([]), { timeout: 10_000, interval: 50 });
  }, 20_000);

  test('a stim-daemon from an older Stim that holds the daemon claim exclusively is refused with its pid and the remedy, and not signalled', async () => {
    const record = join(home, 'legacy.log');
    const legacy = spawnChild(process.execPath, ['--input-type=module', '-e', LEGACY_DAEMON, record], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env },
      stdio: 'ignore',
    });
    daemons.push({
      child: legacy,
      exited: new Promise<number | null>((done) => legacy.once('exit', (code) => done(code))),
    });
    await vi.waitFor(() => expect(readFileSync(record, 'utf8')).toContain('listening'), {
      timeout: 10_000,
      interval: 20,
    });
    assert(legacy.pid);
    const successor = startDaemonProcess();
    expect(await successor.exited).toBe(0);

    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['listening']);
    expect(readClaimSet(daemonClaimRoot()).live.map((claim) => [claim.owner.pid, claim.mode])).toEqual([
      [legacy.pid, 'exclusive'],
    ]);
    const refusal = daemonLog()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((logged) => logged.event === 'stimd_claim_held');
    expect(refusal?.msg).toContain(`stim-daemon pid ${legacy.pid} from an older stim`);
    expect(refusal?.msg).toContain(`kill ${legacy.pid}`);
  }, 60_000);

  test('a daemon signalled right after its tick exits at once instead of sleeping through its wait', async () => {
    normalMeasurement();
    const before = new Set(process.listeners('SIGTERM'));
    const create = ndjson.createNdjsonWriter;
    let signal: (() => void) | null = null;
    const spy = vi.spyOn(ndjson, 'createNdjsonWriter').mockImplementation((...args) => {
      const writer = create(...args);
      return {
        ...writer,
        write(record: unknown) {
          const written = writer.write(record);
          if (typeof record === 'object' && record !== null && 'event' in record && record.event === 'daemon_tick')
            signal?.();
          return written;
        },
      };
    });
    onTestFinished(() => spy.mockRestore());
    const run = runStimd({ tickMs: 60_000 });
    await listening();
    const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
    assert(handler);
    signal = () => handler('SIGTERM');
    expect(await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' })).toBe(true);
    const started = Date.now();
    await run;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(daemonLog()).toContain('exiting: SIGTERM');
  }, 90_000);

  test('a daemon started in report mode stays in report mode', async () => {
    await runStimd({ tickMs: 50, mode: 'report' });
    expect(readDaemonSnapshot()).toMatchObject({ mode: 'report' });
  }, 20_000);

  test('daemon.mode turned off in config after the daemon started stops it on its next tick', async () => {
    const run = runStimd({ tickMs: 1500, mode: 'on' });
    await listening();
    saveConfig({ version: 2, projects: {}, repos: {}, daemon: { mode: 'off' } });
    await run;
    expect(daemonLog()).toContain('exiting: daemon.mode is off');
    expect(daemonLog()).not.toContain('"event":"daemon_tick"');
  }, 20_000);
});

test('on win32 a command starts stimd through the hidden launcher, which passes it no handle', async () => {
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => spawnChild(process.execPath, ['-e', '']));
  setExecutor({ ...getExecutor(), spawn });
  onTestFinished(() => resetExecutor());

  await ensureStimd({ ...process.env, STIM_HOME: home, STIM_DAEMON: 'on', Path: 'C:\\tools' }, 'win32');

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledWith(
    'powershell.exe',
    expect.any(Array),
    expect.objectContaining({
      windowsHide: true,
      detached: false,
      stdio: 'ignore',
      env: expect.objectContaining({ Path: 'C:\\tools' }),
    }),
  );
  expect(spawn.mock.calls.at(0)?.[2]?.env?.STIM_WINDOWS_LAUNCH_ARGS).toMatch(
    /"__stimd" "--mode" "on" "--log-file" ".*stimd\.log"$/,
  );
}, 20_000);
