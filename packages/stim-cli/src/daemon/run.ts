import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  daemonClaimRoot,
  daemonDir,
  daemonHandoverClaimRoot,
  daemonNdjsonFile,
  daemonSnapshotFile,
  daemonSocket,
  isJsonObject,
  macosAppState,
  readMacosRecord,
  readDaemonSnapshot,
  type DaemonMode,
  type DaemonRecentAction,
  type DaemonSnapshot,
} from '@stim-cli/core/state';
import {
  isClaimRefusal,
  isClaimUnavailable,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { waitForProcessExit, type ProcessRecord } from '../process-identity.ts';
import { stimBuild } from '../spawn-entry.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { readWebRecord, webFacts } from '../web/state.ts';
import type { Config } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { askDaemon } from './client.ts';
import { scheduleDependencyMeasures } from './dependencies.ts';
import { configuredDaemonMode, daemonMode, parseDaemonMode, stricterDaemonMode } from './mode.ts';
import { ownedHere } from './idle.ts';
import type { TickMeasurement } from './measure.ts';
import { listWaiting } from '../engine/wait-queue.ts';
import { createMaintenanceLane, runHomePasses, type HomePasses } from './passes.ts';
import { reclaimForBootWaiters } from './reclaim.ts';
import { pendingDormant } from './stages.ts';

const TICK_MS = 60_000;
const SLOW_TICKS = 5;
const CLAIM_TRIES = 30;
const CLAIM_RETRY_MS = 100;
const EMPTY_TICKS_BEFORE_EXIT = 2;
const RECENT_ACTIONS = 20;
const WAKE_GRACE_MS = 2000;
const HANDOVER_REPLY_MS = 5000;
const HANDOVER_WAIT_MS = 10 * 60_000;
const HANDOVER_POLL_MS = 250;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Resource = 'build' | 'boot';

const RESOURCES: readonly Resource[] = ['build', 'boot'];
const OPS: Record<Resource, { wait: string; waiting: string; released: string; changed: string }> = {
  build: { wait: 'slot.wait', waiting: 'slot.waiting', released: 'slot.released', changed: 'slot.changed' },
  boot: { wait: 'boot.wait', waiting: 'boot.waiting', released: 'boot.released', changed: 'boot.changed' },
};

async function takeClaim(
  mode: DaemonMode,
  identity: Record<string, unknown>,
  retries: number,
): Promise<ClaimHandle | null> {
  for (let tries = 0; ; tries++) {
    const attempt = tryAcquireClaim({
      root: daemonClaimRoot(),
      mode: 'exclusive',
      label: 'stim-daemon',
      details: { socket: daemonSocket(), mode, ...identity },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) return attempt.acquired;
    if (tries >= retries) return null;
    await new Promise((done) => setTimeout(done, CLAIM_RETRY_MS));
  }
}

function daemonHolder(pid: number): ProcessRecord | null {
  try {
    return readClaimSet(daemonClaimRoot()).live.find((holder) => holder.owner.pid === pid)?.owner ?? null;
  } catch {
    return null;
  }
}

/**
 * Asks the running daemon `pid` to exit after its current tick and waits, up to ten minutes, for it to release its
 * claim. A daemon whose `hello` carries no `build` predates handovers and gets SIGTERM instead. It then releases its
 * claim at once, even in the middle of a pass that runs on until the process exits, so its process is returned for
 * the caller to outwait before its first tick. Signalled between a pass and its wait, it would sleep through that
 * wait, up to five minutes; the tick request sent just before the signal wakes it.
 */
async function takeOverFrom(
  pid: number,
  log: (level: Level, event: string, msg: string) => void,
): Promise<ProcessRecord | null> {
  const holder = daemonHolder(pid);
  const hello = holder ? await askDaemon('hello', HANDOVER_REPLY_MS) : null;
  if (!holder || hello?.pid !== pid) return null;
  let stopped: ProcessRecord | null = null;
  if ('build' in hello) {
    const reply = await askDaemon('handover', HANDOVER_REPLY_MS, { pid, build: hello.build });
    if (reply?.accepted === false) return null;
    log('info', 'daemon_handover', `asked stim-daemon pid ${pid} to exit after its tick`);
  } else {
    await new Promise<void>((done) => {
      const socket = connect(daemonSocket());
      socket.once('error', () => done());
      socket.once('connect', () => socket.end(`${JSON.stringify({ op: 'tick' })}\n`, () => done()));
    });
    if (!daemonHolder(pid)) return null;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return null;
    }
    stopped = holder;
    log('info', 'daemon_handover', `stopped stim-daemon pid ${pid}, which predates handovers`);
  }
  const deadline = Date.now() + HANDOVER_WAIT_MS;
  while (daemonHolder(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, HANDOVER_POLL_MS));
  return stopped;
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
 * Work the daemon still has to do in a quiet home, which keeps it alive at the slow cadence: a workspace the dormant
 * stage will take, until its due time plus one slow tick.
 */
async function pendingWork(
  config: Config | null,
  measured: TickMeasurement,
  slowTickMs: number,
): Promise<string | null> {
  const dormant = await pendingDormant(config, { simsFailed: measured.sims === null }, { graceMs: slowTickMs });
  return dormant ? `${dormant} is not dormant yet` : null;
}

/**
 * The per-home daemon: holds `$STIM_HOME/daemon/claim`, serves its socket, and ticks every minute while something
 * runs in the home or the pressure level is above normal, every 5 minutes otherwise, and on demand, each tick measuring
 * once, running the activity, dormant and pressure passes and writing `snapshot.json`, then, unless it exits, starting
 * the slow passes (`createMaintenanceLane`) unless the last ones still run. A command's contact brings it back to the minute. It exits
 * after two ticks in a row with nothing running, no work pending (`pendingWork`), no slow pass running and no contact,
 * when `daemon.mode` turns off, or when a tick throws, releasing its claim so each supervisor's own idle timer takes
 * over. Asked to hand over, by a daemon a command from a newer installed Stim build started, it exits at once between
 * ticks, or after the tick in progress. Once it is closing it starts no slow pass, and one still running finishes
 * before the process ends.
 */
export async function runDaemon({
  tickMs = TICK_MS,
  slowTickMs = tickMs * SLOW_TICKS,
  mode: startMode = daemonMode({}),
  replace,
}: {
  tickMs?: number;
  /** The tick interval while nothing runs in the home and the pressure level is normal: 5 minutes. */
  slowTickMs?: number;
  /** The mode the starting command resolved; a later `daemon.mode` change in config can only make it stricter. */
  mode?: DaemonMode;
  /** The pid of the running daemon this one asks to hand over before it takes the claim. */
  replace?: number;
} = {}): Promise<void> {
  const identity = stimBuild();
  const build = identity.digest;
  const configAtStart = configuredDaemonMode();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  const log = (level: Level, event: string, msg: string, fields: Record<string, unknown> = {}) =>
    writer.write({ src: 'daemon', level, event, msg, ...fields });
  let predecessor: ProcessRecord | null = null;
  let handoverClaim: ClaimHandle | undefined;
  if (replace !== undefined) {
    const attempt = tryAcquireClaim({
      root: daemonHandoverClaimRoot(),
      mode: 'exclusive',
      label: 'stim-daemon handover',
      details: { replace },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired) {
      log('debug', 'daemon_handover_held', 'another stim-daemon is taking over; exiting');
      writer.close();
      return;
    }
    handoverClaim = attempt.acquired;
    predecessor = await takeOverFrom(replace, log);
  }
  const claim = await takeClaim(
    startMode,
    { build, installed: identity.installed, version: identity.version },
    replace === undefined ? CLAIM_TRIES : 0,
  );
  releaseClaim(handoverClaim);
  if (!claim) {
    log('debug', 'daemon_claim_held', 'another stim-daemon holds the claim; exiting');
    writer.close();
    return;
  }
  const lane = createMaintenanceLane(log);
  const loopDelay = monitorEventLoopDelay();
  loopDelay.enable();
  const path = daemonSocket();
  const waiters: Record<Resource, Socket[]> = { build: [], boot: [] };
  const wokenAt = new WeakMap<Socket, number>();
  let tickReplies: Socket[] = [];
  let lastSnapshot: DaemonSnapshot | null = null;
  let recent: DaemonRecentAction[] = readDaemonSnapshot()?.recent ?? [];
  let lastContact = Date.now();
  let closing = false;
  let tickRequested = false;
  let handover = false;
  let interrupt: (() => void) | null = null;
  let hasten: (() => void) | null = null;
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
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
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
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          message = isJsonObject(parsed) ? parsed : {};
        } catch {
          socket.destroy();
          return;
        }
        if (closing) {
          socket.destroy();
          return;
        }
        const { op } = message;
        lastContact = Date.now();
        if (op === 'hello') {
          hasten?.();
          socket.end(`${JSON.stringify({ op: 'hello', pid: process.pid, build, version: identity.version })}\n`);
        } else if (op === 'handover') {
          const accepted = message.pid === process.pid && message.build === build;
          socket.end(`${JSON.stringify({ op: 'handover', accepted })}\n`);
          if (accepted) {
            handover = true;
            interrupt?.();
          }
        } else if (op === 'snapshot') socket.end(`${JSON.stringify({ op: 'snapshot', snapshot: lastSnapshot })}\n`);
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
    loopDelay.disable();
    interrupt?.();
    server.close();
    for (const waiter of [...waiters.build, ...waiters.boot, ...tickReplies]) waiter.destroy();
    for (const socket of open) socket.end().unref();
    if (bound) rmSync(path, { force: true });
    releaseClaim(claim);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    log(level, 'daemon_exited', `exiting: ${why}`);
    void lane.settled().then(() => writer.close());
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
    { build, version: identity.version },
  );
  if (predecessor && !(await waitForProcessExit(predecessor, HANDOVER_WAIT_MS)))
    log('warn', 'daemon_handover', `stim-daemon pid ${predecessor.pid} still runs; ticking anyway`);
  let emptyTicks = 0;
  let interval = tickMs;
  const kept = new Map<string, string>();
  for (;;) {
    if (!tickRequested && !handover && !closing) {
      await new Promise<void>((done) => {
        let timer = setTimeout(done, interval);
        interrupt = () => {
          clearTimeout(timer);
          done();
        };
        hasten = () => {
          if (interval <= tickMs) return;
          clearTimeout(timer);
          interval = tickMs;
          timer = setTimeout(done, tickMs);
        };
      });
    }
    interrupt = null;
    hasten = null;
    if (closing) break;
    if (handover) {
      shutdown('a stim-daemon from a newer installed Stim build takes over');
      break;
    }
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
    const maintaining = lane.running();
    let alive: string | null;
    let pending: string | null = null;
    let wentDormant = false;
    let phases: Record<string, number> = {};
    let ticked: HomePasses | null = null;
    try {
      const passes = await runHomePasses({
        act: mode === 'on',
        log,
        memoryWarningSince: lastSnapshot?.pressure?.memoryWarningSince ?? null,
      });
      const { config, now, measured, workspaces, pressure, actions, operation } = passes;
      actions.push(...lane.take());
      scheduleDependencyMeasures();
      const reclaimStarted = performance.now();
      const reclaimed = await reclaimForBootWaiters({
        devices: measured.devices,
        sims: measured.sims,
        act: mode === 'on',
        log,
        operation,
      });
      phases = { ...passes.phases, reclaimMs: Math.round(performance.now() - reclaimStarted) };
      if (reclaimed) {
        actions.push(reclaimed);
        if (reclaimed.outcome === 'done') wakeOldest('boot');
      }
      const waiting = listWaiting();
      alive =
        waiters.build.length || waiters.boot.length || waiting.length
          ? 'a run waits for a build slot or a device boot'
          : homeAlive(config, measured);
      pending = alive
        ? null
        : maintaining
          ? 'automatic maintenance runs'
          : await pendingWork(config, measured, slowTickMs);
      wentDormant = actions.some((action) => action.kind === 'dormant-stage' && action.outcome === 'done');
      interval = alive || pressure.level !== 'normal' ? tickMs : slowTickMs;
      for (const { path: workspace, outcome, detail } of workspaces) {
        if (outcome !== 'kept') kept.delete(workspace);
        else if (kept.get(workspace) !== detail) {
          kept.set(workspace, detail);
          log('info', 'workspace_kept', `${workspace}: ${detail}`, { workspace });
        }
      }
      const tickAt = new Date(now).toISOString();
      const taken = [
        ...workspaces.flatMap((entry) =>
          (entry.outcome === 'idle' || entry.outcome === 'would-idle') &&
          !actions.some((action) => action.kind === 'idle-stage' && action.target === entry.path)
            ? [
                {
                  rung: 1,
                  kind: 'idle-stage',
                  target: entry.path,
                  workspace: entry.path,
                  outcome: entry.outcome === 'idle' ? ('done' as const) : ('would' as const),
                  bytes: entry.freedBytes ?? 0,
                  detail: entry.detail,
                },
              ]
            : [],
        ),
        ...actions,
      ].filter((action) => action.outcome !== 'kept');
      recent = [...recent, ...taken.map((action) => Object.assign(action, { at: tickAt }))].slice(-RECENT_ACTIONS);
      lastSnapshot = {
        version: 1,
        pid: process.pid,
        startedAt,
        mode,
        tickAt,
        tickMs: Math.round(performance.now() - tickStarted),
        intervalMs: interval,
        measurement: measured.measurement,
        workspaces,
        pressure,
        actions,
        recent,
        waiting,
      };
      writeSnapshot(lastSnapshot);
      for (const socket of replying) socket.end(`${JSON.stringify({ op: 'ticked', level: pressure.level })}\n`);
      ticked = passes;
    } catch (error) {
      for (const socket of replying) socket.destroy();
      shutdown(
        `the tick failed, so each supervisor's own idle timer takes over: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      break;
    }
    if (closing) break;
    const idle = !alive && !pending && !wentDormant && Date.now() - contactSince >= tickMs;
    emptyTicks = idle ? emptyTicks + 1 : 0;
    const tookMs = Math.round(performance.now() - tickStarted);
    await new Promise((done) => setTimeout(done, 0));
    log(
      'debug',
      'daemon_tick',
      `tick ${tookMs}ms; ${alive ?? (pending ? `nothing running; ${pending}, next tick in ${Math.round(interval / 60_000)} minutes` : 'nothing running')}`,
      {
        tickMs: tookMs,
        phases,
        eventLoopDelay: {
          maxMs: Math.round(loopDelay.max / 1e6),
          p99Ms: Math.round(loopDelay.percentile(99) / 1e6),
        },
      },
    );
    loopDelay.reset();
    if (emptyTicks >= EMPTY_TICKS_BEFORE_EXIT) {
      shutdown('nothing runs in this Stim home');
      break;
    }
    if (ticked && !handover && !closing) lane.start(ticked, mode === 'on');
  }
  await lane.settled();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.title = 'stim-daemon';
  const at = process.argv.indexOf('--mode');
  const replaceAt = process.argv.indexOf('--replace');
  const replace = replaceAt > 0 ? Number(process.argv[replaceAt + 1]) : Number.NaN;
  runDaemon({
    mode: parseDaemonMode(at > 0 ? process.argv[at + 1] : undefined) ?? daemonMode({}),
    ...(Number.isInteger(replace) && replace > 0 ? { replace } : {}),
  }).catch((error: unknown) => {
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
  });
}
