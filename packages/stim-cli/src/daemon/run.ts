import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  daemonClaimRoot,
  daemonDir,
  daemonNdjsonFile,
  daemonSnapshotFile,
  daemonSocket,
  isJsonObject,
  macosAppState,
  readMacosRecord,
  type DaemonMode,
  type DaemonSnapshot,
} from '@stim-cli/core/state';
import {
  isClaimRefusal,
  isClaimUnavailable,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { readWebRecord, webFacts } from '../web/state.ts';
import type { Config } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { configuredDaemonMode, daemonMode, parseDaemonMode, stricterDaemonMode } from './client.ts';
import { ownedHere } from './idle.ts';
import type { TickMeasurement } from './measure.ts';
import { listWaiting } from '../engine/wait-queue.ts';
import { runHomePasses } from './passes.ts';
import { reclaimForBootWaiters } from './reclaim.ts';

const TICK_MS = 60_000;
const CLAIM_TRIES = 30;
const CLAIM_RETRY_MS = 100;
const EMPTY_TICKS_BEFORE_EXIT = 2;
const WAKE_GRACE_MS = 2000;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Resource = 'build' | 'boot';

const RESOURCES: readonly Resource[] = ['build', 'boot'];
const OPS: Record<Resource, { wait: string; waiting: string; released: string; changed: string }> = {
  build: { wait: 'slot.wait', waiting: 'slot.waiting', released: 'slot.released', changed: 'slot.changed' },
  boot: { wait: 'boot.wait', waiting: 'boot.waiting', released: 'boot.released', changed: 'boot.changed' },
};

async function takeClaim(): Promise<ClaimHandle | null> {
  for (let tries = 0; ; tries++) {
    const attempt = tryAcquireClaim({
      root: daemonClaimRoot(),
      mode: 'exclusive',
      label: 'stim-daemon',
      details: { socket: daemonSocket() },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) return attempt.acquired;
    if (tries >= CLAIM_TRIES) return null;
    await new Promise((done) => setTimeout(done, CLAIM_RETRY_MS));
  }
}

function answers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      done(true);
    });
    probe.once('error', () => done(false));
  });
}

/**
 * Binds the daemon's socket while it holds the daemon claim. Node cannot read a Unix socket peer's uid, so the
 * kernel's check stands in for it: connecting needs write access to a 0600 socket in a 0700 directory this user owns.
 */
async function listen(path: string, server: Server): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = lstatSync(dir);
  if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid()))
    throw new Error(`${dir} is not a directory this user owns, so the daemon does not put its socket there.`);
  chmodSync(dir, 0o700);
  if (existsSync(path)) {
    if (await answers(path)) throw new Error(`another process answers on ${path}`);
    rmSync(path, { force: true });
  }
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
      done();
    });
  });
  chmodSync(path, 0o600);
}

function writeSnapshot(snapshot: DaemonSnapshot): void {
  const file = daemonSnapshotFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * What keeps the daemon running: a dev server, a build, a held build slot, a booted owned device, an owned Chrome or
 * a macOS app. Owned simulators that could not be listed keep it running.
 */
function homeAlive(config: Config | null, measured: TickMeasurement): string | null {
  for (const [path, project] of Object.entries(config?.projects ?? {})) {
    const supervisor = resolveSupervisorTarget({
      state: readWorkspaceState(path)?.supervisor,
      record: project.supervisor,
      reservedPort: project.metroPort,
    });
    if (supervisor.status === 'ours' || supervisor.status === 'unverified') return `${path} runs a dev server`;
    if (workspaceBuildInProgress(path)) return `${path} is building`;
    const browser = webFacts(readWebRecord(path));
    if (browser && browser.status !== 'stopped') return `${path} has an owned Chrome`;
    const macos = macosAppState(readMacosRecord(path));
    if (macos && macos.state !== 'stopped') return `${path} has a macOS app`;
  }
  if (listBuildSlots().some((slot) => slot.alive || slot.unresolved)) return 'a build slot is held';
  const owned = measured.devices.filter(ownedHere);
  if (owned.length) return `${owned.length} owned device(s) running`;
  const ownsIos = Object.values(config?.projects ?? {}).some((project) =>
    projectDeviceSlots(project).some(({ platforms }) => platforms.ios?.owned === true),
  );
  if (ownsIos && measured.sims === null) return `its simulators cannot be listed (${measured.simsError})`;
  return null;
}

/**
 * The per-home daemon: holds `$STIM_HOME/daemon/claim`, serves its socket, and ticks every minute and on demand, each
 * tick measuring once, running the activity pass and automatic maintenance, and writing `snapshot.json`. It exits
 * after two ticks in a row with nothing running in the home and no contact, when `daemon.mode` turns off, or when a
 * tick throws, releasing its claim so each supervisor's own idle timer takes over.
 */
export async function runDaemon({
  tickMs = TICK_MS,
  mode: startMode = daemonMode({}),
}: {
  tickMs?: number;
  /** The mode the starting command resolved; a later `daemon.mode` change in config can only make it stricter. */
  mode?: DaemonMode;
} = {}): Promise<void> {
  const configAtStart = configuredDaemonMode();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  const log = (level: Level, event: string, msg: string, fields: Record<string, unknown> = {}) =>
    writer.write({ src: 'daemon', level, event, msg, ...fields });
  const claim = await takeClaim();
  if (!claim) {
    log('debug', 'daemon_claim_held', 'another stim-daemon holds the claim; exiting');
    writer.close();
    return;
  }
  const path = daemonSocket();
  const waiters: Record<Resource, Socket[]> = { build: [], boot: [] };
  const wokenAt = new WeakMap<Socket, number>();
  let tickReplies: Socket[] = [];
  let lastSnapshot: DaemonSnapshot | null = null;
  let lastContact = Date.now();
  let closing = false;
  let tickRequested = false;
  let interrupt: (() => void) | null = null;
  const requestTick = () => {
    tickRequested = true;
    interrupt?.();
  };
  const drop = (socket: Socket) => {
    for (const list of Object.values(waiters)) {
      const at = list.indexOf(socket);
      if (at >= 0) list.splice(at, 1);
    }
    tickReplies = tickReplies.filter((entry) => entry !== socket);
  };
  const wakeOldest = (resource: Resource) => {
    const now = Date.now();
    const next = waiters[resource].find((waiter) => now - (wokenAt.get(waiter) ?? 0) >= WAKE_GRACE_MS);
    if (!next) return;
    wokenAt.set(next, now);
    next.write(`${JSON.stringify({ op: OPS[resource].changed })}\n`);
  };
  const server = createServer((socket) => {
    lastContact = Date.now();
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => drop(socket));
    socket.on('close', () => drop(socket));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let op: unknown;
        try {
          const message: unknown = JSON.parse(line);
          op = isJsonObject(message) ? message.op : undefined;
        } catch {
          socket.destroy();
          return;
        }
        lastContact = Date.now();
        if (op === 'hello') socket.end(`${JSON.stringify({ op: 'hello', pid: process.pid })}\n`);
        else if (op === 'snapshot') socket.end(`${JSON.stringify({ op: 'snapshot', snapshot: lastSnapshot })}\n`);
        else if (op === 'tick') {
          if (!tickReplies.includes(socket)) tickReplies.push(socket);
          requestTick();
        } else {
          const resource = RESOURCES.find((entry) => op === OPS[entry].wait || op === OPS[entry].released);
          if (!resource) {
            socket.destroy();
            return;
          }
          if (op === OPS[resource].wait) {
            const list = waiters[resource];
            if (!list.includes(socket)) list.push(socket);
            socket.write(`${JSON.stringify({ op: OPS[resource].waiting, position: list.indexOf(socket) + 1 })}\n`);
          } else {
            socket.end();
            wakeOldest(resource);
          }
          requestTick();
        }
      }
    });
  });
  let bound = false;
  const onSignal = (signal: NodeJS.Signals) => shutdown(signal);
  const shutdown = (why: string, level: Level = 'info') => {
    if (closing) return;
    closing = true;
    interrupt?.();
    server.close();
    for (const waiter of [...waiters.build, ...waiters.boot, ...tickReplies]) waiter.destroy();
    if (bound) rmSync(path, { force: true });
    releaseClaim(claim);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    log(level, 'daemon_exited', `exiting: ${why}`);
    writer.close();
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    await listen(path, server);
    bound = true;
  } catch (error) {
    shutdown(`cannot listen on ${path}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    throw error;
  }
  log(
    'info',
    'daemon_started',
    `pid ${process.pid} listening on ${path} after ${Math.round(performance.now() - started)}ms`,
  );
  let emptyTicks = 0;
  const kept = new Map<string, string>();
  for (;;) {
    if (!tickRequested) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, tickMs);
        interrupt = () => {
          clearTimeout(timer);
          done();
        };
      });
    }
    interrupt = null;
    if (closing) break;
    tickRequested = false;
    const configured = configuredDaemonMode();
    const mode = configured === configAtStart ? startMode : stricterDaemonMode(startMode, configured ?? 'on');
    if (mode === 'off') {
      shutdown('daemon.mode is off');
      break;
    }
    const tickStarted = performance.now();
    const contactSince = lastContact;
    const replying = tickReplies;
    tickReplies = [];
    let alive: string | null;
    try {
      const { config, now, measured, workspaces, pressure, actions } = await runHomePasses({
        act: mode === 'on',
        trigger: 'daemon',
        log,
        memoryWarningSince: lastSnapshot?.pressure?.memoryWarningSince ?? null,
      });
      const reclaimed = await reclaimForBootWaiters({
        devices: measured.devices,
        sims: measured.sims,
        act: mode === 'on',
        log,
      });
      if (reclaimed) {
        actions.push(reclaimed);
        if (reclaimed.outcome === 'done') wakeOldest('boot');
      }
      const waiting = listWaiting();
      alive =
        waiters.build.length || waiters.boot.length || waiting.length
          ? 'a run waits for a build slot or a device boot'
          : homeAlive(config, measured);
      for (const { path: workspace, outcome, detail } of workspaces) {
        if (outcome !== 'kept') kept.delete(workspace);
        else if (kept.get(workspace) !== detail) {
          kept.set(workspace, detail);
          log('info', 'workspace_kept', `${workspace}: ${detail}`, { workspace });
        }
      }
      lastSnapshot = {
        version: 1,
        pid: process.pid,
        startedAt,
        mode,
        tickAt: new Date(now).toISOString(),
        tickMs: Math.round(performance.now() - tickStarted),
        intervalMs: tickMs,
        measurement: measured.measurement,
        workspaces,
        pressure,
        actions,
        waiting,
      };
      writeSnapshot(lastSnapshot);
      for (const socket of replying) socket.end(`${JSON.stringify({ op: 'ticked', level: pressure.level })}\n`);
    } catch (error) {
      for (const socket of replying) socket.destroy();
      shutdown(
        `the tick failed, so each supervisor's own idle timer takes over: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      break;
    }
    if (closing) break;
    const idle = !alive && Date.now() - contactSince >= tickMs;
    emptyTicks = idle ? emptyTicks + 1 : 0;
    log('debug', 'daemon_tick', `tick ${Math.round(performance.now() - tickStarted)}ms; ${alive ?? 'nothing running'}`);
    if (emptyTicks >= EMPTY_TICKS_BEFORE_EXIT) {
      shutdown('nothing runs in this Stim home');
      break;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.title = 'stim-daemon';
  const at = process.argv.indexOf('--mode');
  runDaemon({ mode: parseDaemonMode(at > 0 ? process.argv[at + 1] : undefined) ?? daemonMode({}) }).catch(
    (error: unknown) => {
      const message =
        isClaimRefusal(error) || isClaimUnavailable(error)
          ? error.message
          : error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
      try {
        const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
        writer.write({ src: 'daemon', level: 'error', event: 'daemon_failed', msg: message });
        writer.close();
      } catch {}
      process.exitCode = 1;
    },
  );
}
