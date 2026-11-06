import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  daemonClaimRoot,
  daemonDir,
  daemonNdjsonFile,
  daemonSnapshotFile,
  isJsonObject,
  readJsonObject,
  stimdClaimRoot,
  stimdRecordFile,
  stimdRunDir,
  stimdSocket,
  macosAppState,
  readMacosRecord,
  readDaemonSnapshot,
  readMaintenanceState,
  type DaemonMode,
  type DaemonRecentAction,
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
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { stimBuild } from '../spawn-entry.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { readWebRecord, webFacts } from '../web/state.ts';
import type { Config } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { relaunchWithLogFile } from '../detached-entry.ts';
import { LAUNCHD_LABEL_ENV, launchdLabelPrefix, stimdBuildId } from '../daemon/client.ts';
import { getExecutor } from '../exec.ts';
import { configuredDaemonMode, daemonMode, parseDaemonMode, stricterDaemonMode } from '../daemon/mode.ts';
import { ownedHere } from '../daemon/idle.ts';
import type { TickMeasurement } from '../daemon/measure.ts';
import { listWaiting } from '../engine/wait-queue.ts';
import { runHomePasses, type HomePasses } from '../daemon/passes.ts';
import { reclaimForBootWaiters } from '../daemon/reclaim.ts';
import { bootedParkedPending } from '../daemon/booted-parked.ts';
import { pendingDormant } from '../daemon/stages.ts';
// compat C22 until removal-minor
import { takeOverLegacyDaemon } from './legacy-daemon-takeover.ts';
// compat end
import { listenPipe } from './pipe-win32.ts';
import { createPassesLane, createThreadTable } from './threads.ts';

const TICK_MS = 60_000;
const DEPENDENCY_SCAN_MS = 10 * 60_000;
const SLOW_TICKS = 5;
const CLAIM_TRIES = 30;
const CLAIM_RETRY_MS = 100;
const EMPTY_TICKS_BEFORE_EXIT = 2;
const RECENT_ACTIONS = 20;
const WAKE_GRACE_MS = 2000;
const RECORD_FORMAT = 1;
const LAUNCHCTL_TIMEOUT_MS = 5000;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Resource = 'build' | 'boot';

const RESOURCES: readonly Resource[] = ['build', 'boot'];
const OPS: Record<Resource, { wait: string; waiting: string; released: string; changed: string }> = {
  build: { wait: 'slot.wait', waiting: 'slot.waiting', released: 'slot.released', changed: 'slot.changed' },
  boot: { wait: 'boot.wait', waiting: 'boot.waiting', released: 'boot.released', changed: 'boot.changed' },
};

async function takeClaim(
  root: string,
  mode: 'exclusive' | 'shared',
  label: string,
  details: Record<string, unknown>,
  beforeRetry: () => Promise<unknown> = async () => {},
): Promise<ClaimHandle | null> {
  for (let tries = 0; ; tries++) {
    const attempt = tryAcquireClaim({ root, mode, label, details });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) return attempt.acquired;
    if (tries >= CLAIM_TRIES) return null;
    await beforeRetry();
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
 * Binds stimd's CLI socket while it holds the stimd claim. Node cannot read a Unix socket peer's uid, so the kernel's
 * check stands in for it: connecting needs write access to a 0600 socket in a 0700 directory this user owns.
 */
async function listen(path: string, server: Server): Promise<void> {
  if (process.platform === 'win32') return listenPipe(path, server);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = lstatSync(dir);
  if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid()))
    throw new Error(`${dir} is not a directory this user owns, so stimd does not put its socket there.`);
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

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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
  if (bootedParkedPending()) return 'a parked simulator is kept booted';
  const ownsIos = Object.values(config?.projects ?? {}).some((project) =>
    projectDeviceSlots(project).some(({ platforms }) => platforms.ios?.owned === true),
  );
  if (ownsIos && measured.sims === null) return `its simulators cannot be listed (${measured.simsError})`;
  return null;
}

/**
 * Work the daemon still has to do in a quiet home, which keeps it alive at the slow cadence: a workspace the dormant
 * stage will take, until its due time plus one slow tick, and, while maintenance acts and removes finished worktrees,
 * a finished worktree the last worktree check kept only for its grace period, until a later check removes it or keeps
 * it for another reason.
 */
async function pendingWork(
  config: Config | null,
  measured: TickMeasurement,
  slowTickMs: number,
  act: boolean,
): Promise<string | null> {
  const dormant = await pendingDormant(config, { simsFailed: measured.sims === null }, { graceMs: slowTickMs });
  if (dormant) return `${dormant} is not dormant yet`;
  const settings = resolveMaintenanceSettings(config);
  const removal =
    act && settings.mode === 'on' && settings.removeFinishedWorktrees ? readMaintenanceState()?.nextRemoval : undefined;
  if (!removal) return null;
  const at = new Date(removal.at).toISOString();
  return removal.at > Date.now()
    ? `the finished worktree ${removal.target} becomes removable at ${at}`
    : `the finished worktree ${removal.target}, removable since ${at}, waits for the next worktree check`;
}

/**
 * One resident stimd per Stim home: holds the claim at `run/stimd` exclusively and the daemon claim at `daemon/claim`
 * shared, after stopping a stim-daemon from Stim 1.40 to 1.42 that holds that one exclusively; serves the CLI socket,
 * whose address it writes to `run/stimd.json`; and ticks every minute while something runs in the home or the pressure
 * level is above normal, every 5 minutes otherwise, and on demand, each tick measuring once, running the activity,
 * dormant and pressure passes and writing `snapshot.json`, then, unless it exits, starting the slow passes on the passes
 * thread unless the last ones still run. A command's contact brings it back to the minute. It exits after two ticks in a
 * row with nothing running, no work pending (`pendingWork`), no slow pass running and no contact, when `daemon.mode`
 * turns off, or when a tick throws, releasing its claims so each supervisor's own idle timer takes over. During
 * shutdown it cancels the dependency size scan and waits for its cleanup and for any slow pass already running.
 */
export async function runStimd({
  tickMs = TICK_MS,
  slowTickMs = tickMs * SLOW_TICKS,
  mode: startMode = daemonMode({}),
}: {
  tickMs?: number;
  /** The tick interval while nothing runs in the home and the pressure level is normal: 5 minutes. */
  slowTickMs?: number;
  /** The mode the starting command resolved; a later `daemon.mode` change in config can only make it stricter. */
  mode?: DaemonMode;
} = {}): Promise<void> {
  const identity = stimBuild();
  const build = stimdBuildId();
  const configAtStart = configuredDaemonMode();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  const log = (level: Level, event: string, msg: string, fields: Record<string, unknown> = {}) =>
    writer.write({ src: 'stimd', level, event, msg, ...fields });
  const path = stimdSocket();
  const details = { socket: path, mode: startMode, build, version: identity.version };
  const own = await takeClaim(stimdClaimRoot(), 'exclusive', 'stimd', details);
  if (!own) {
    log('debug', 'stimd_claim_held', 'another stimd holds this Stim home; exiting');
    writer.close();
    return;
  }
  // compat C22 until removal-minor
  let stopped: number | null = null;
  const takeOver = async () => {
    stopped = (await takeOverLegacyDaemon()) ?? stopped;
  };
  await takeOver();
  // compat end
  const claim = await takeClaim(daemonClaimRoot(), 'shared', 'stimd', details, takeOver);
  if (stopped !== null) log('info', 'stimd_takeover', `stopped stim-daemon pid ${stopped}, from an older Stim`);
  if (!claim) {
    releaseClaim(own);
    log('warn', 'stimd_claim_held', 'a stim-daemon from an older Stim still holds the daemon claim; exiting');
    writer.close();
    return;
  }
  const threads = createThreadTable(log);
  const lane = createPassesLane(threads, log);
  let dependencyScanAt = -Infinity;
  let dependencyWork: Promise<void> | undefined;
  const loopDelay = monitorEventLoopDelay();
  loopDelay.enable();
  const waiters: Record<Resource, Socket[]> = { build: [], boot: [] };
  const wokenAt = new WeakMap<Socket, number>();
  let tickReplies: Socket[] = [];
  let lastSnapshot: DaemonSnapshot | null = null;
  let recent: DaemonRecentAction[] = readDaemonSnapshot()?.recent ?? [];
  let lastContact = Date.now();
  let closing = false;
  let tickRequested = false;
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
    socket.setEncoding('utf8');
    let buffer = '';
    let framed = false;
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
        const reply = (fields: Record<string, unknown>) => socket.write(`${JSON.stringify(fields)}\n`);
        if (!framed) {
          // compat C26 permanent
          if (message.kind !== 'cli' && message.kind !== 'api') {
            reply({ op: 'error', code: 'unknown-kind', message: 'the first frame names no client kind' });
            socket.end();
            return;
          }
          if (message.build !== build) {
            reply({ op: 'engine-changed', build, version: identity.version, pid: process.pid });
            socket.end();
            return;
          }
          // compat end
          framed = true;
          lastContact = Date.now();
          reply({ op: 'hello', kind: 'stimd', pid: process.pid, build, version: identity.version });
          continue;
        }
        lastContact = Date.now();
        const { op } = message;
        if (op === 'hello') {
          hasten?.();
          socket.end(`${JSON.stringify({ op: 'hello', pid: process.pid, build, version: identity.version })}\n`);
        } else if (op === 'presence.publish') {
          socket.end(`${JSON.stringify({ op: 'presence', forwarded: false })}\n`);
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
            reply({ op: OPS[resource].waiting, position: list.indexOf(socket) + 1 });
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
    if (dependencyWork) log('debug', 'daemon_dependency_scan_cancelled', 'stopping the dependency size scan');
    threads.abort('measure');
    loopDelay.disable();
    interrupt?.();
    server.close();
    for (const waiter of [...waiters.build, ...waiters.boot, ...tickReplies]) waiter.destroy();
    for (const socket of open) socket.end().unref();
    if (bound && process.platform !== 'win32') rmSync(path, { force: true });
    if (readJsonObject(stimdRecordFile())?.pid === process.pid) rmSync(stimdRecordFile(), { force: true });
    releaseClaim(claim);
    releaseClaim(own);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    log(level, 'daemon_exited', `exiting: ${why}`);
    void Promise.all([lane.settled(), dependencyWork])
      .then(() => threads.close())
      .then(() => writer.close());
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    await listen(path, server);
    bound = true;
    writeAtomic(stimdRecordFile(), {
      format: RECORD_FORMAT,
      pid: process.pid,
      socket: path,
      build,
      version: identity.version,
    });
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
  let emptyTicks = 0;
  let interval = tickMs;
  const kept = new Map<string, string>();
  for (;;) {
    if (!tickRequested && !closing) {
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
      if (!closing && !dependencyWork && Date.now() - dependencyScanAt >= DEPENDENCY_SCAN_MS) {
        dependencyScanAt = Date.now();
        dependencyWork = threads
          .run('measure', { cwd: process.cwd() })
          .then(() => undefined)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== 'aborted') log('warn', 'daemon_dependency_scan_failed', message);
          })
          .finally(() => {
            dependencyWork = undefined;
          });
      }
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
          : await pendingWork(config, measured, slowTickMs, mode === 'on');
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
      writeAtomic(daemonSnapshotFile(), lastSnapshot);
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
    if (ticked && !closing) lane.start(ticked, mode === 'on');
  }
  await Promise.all([lane.settled(), dependencyWork]);
  await threads.close();
}

/** The `__stimd` entry: `argv` is what follows it. */
export async function runStimdEntry(argv: readonly string[]): Promise<void> {
  if (relaunchWithLogFile(['__stimd', ...argv])) return;
  process.title = 'stimd';
  const label = process.env[LAUNCHD_LABEL_ENV];
  delete process.env[LAUNCHD_LABEL_ENV];
  if (label) removeExitedJobs(label);
  const at = argv.indexOf('--mode');
  try {
    await runStimd({ mode: parseDaemonMode(at >= 0 ? argv[at + 1] : undefined) ?? daemonMode({}) });
  } catch (error) {
    const message =
      isClaimRefusal(error) || isClaimUnavailable(error)
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error);
    try {
      const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
      writer.write({ src: 'stimd', level: 'error', event: 'daemon_failed', msg: message });
      writer.close();
    } catch {}
    process.exitCode = 1;
  }
  if (label)
    try {
      getExecutor().runFile('launchctl', ['remove', label], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
    } catch {}
}

/** Removes the jobs of this home's earlier stimds that exited without removing their own, such as after a crash. */
function removeExitedJobs(own: string): void {
  try {
    const executor = getExecutor();
    for (const line of executor.runFile('launchctl', ['list'], { timeoutMs: LAUNCHCTL_TIMEOUT_MS }).split('\n')) {
      const [pid, , label] = line.split('\t');
      if (pid === '-' && label?.startsWith(launchdLabelPrefix()) && label !== own)
        executor.runFile('launchctl', ['remove', label], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
    }
  } catch {}
}
