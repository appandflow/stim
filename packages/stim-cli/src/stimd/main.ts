import { createMetroTickets, handleMetroTicketRequest } from './metro/tickets.ts';
import { createLeaseTickets, handleLeaseRequest } from './lease-tickets.ts';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  DEFAULT_SERVER_PORT,
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
  readHostedSessions,
  readHostedAppMetadata,
  type HostedDeviceSession,
  type DaemonMode,
  type DaemonRecentAction,
  type DaemonSnapshot,
} from '@stim-cli/core/state';
import {
  ClaimUnavailableError,
  claimFailure,
  claimRemoveCommand,
  markClaimChildPending,
  isClaimRefusal,
  isClaimUnavailable,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  updateClaimDetails,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { stimBuild } from '../spawn-entry.ts';
import { resolveSupervisorTarget } from '../stimd/metro/ownership.ts';
import { readWebRecord, webFacts } from '../web/state.ts';
import { getConfigDir, loadConfig, type Config } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { relaunchWithLogFile } from '../detached-entry.ts';
import {
  LAUNCHD_LABEL_ENV,
  SANDBOX_BLOCKED,
  launchStimd,
  launchdLabelPrefix,
  serveThroughStimd,
  isSandboxBlocked,
  stimdBuildId,
  stimdLive,
  waitForStimdHello,
  type NetAnswer,
} from '../daemon/client.ts';
import { getExecutor } from '../exec.ts';
import { configuredDaemonMode, daemonMode, parseDaemonMode, stricterDaemonMode } from '../daemon/mode.ts';
import { ownedHere } from '../daemon/idle.ts';
import { measureTick, type TickMeasurement } from '../daemon/measure.ts';
import { listWaiting } from '../engine/wait-queue.ts';
import { runHomePasses, type HomePasses } from '../daemon/passes.ts';
import { reclaimForBootWaiters } from '../daemon/reclaim.ts';
import { bootedParkedPending } from '../daemon/booted-parked.ts';
import { pendingDormant } from '../daemon/stages.ts';
// compat C22 until removal-minor
import { takeOverLegacyDaemon } from './legacy-daemon-takeover.ts';
// compat end
import { listenPipe } from './pipe-win32.ts';
import {
  adoptMetroChildren,
  openMetroChildren,
  metroCleanupPending,
  metroEngineDirs,
  stopMetroTicks,
  closeMetroChildren,
  ensureMetro,
  ensureTunnel,
  metroChildrenRun,
  metroOpFlags,
  setMetroInvocation,
  metroTick,
} from './metro/children.ts';
import { invocation, traceInvocation, withInvocation, type Invocation } from './forwarded.ts';
import { createPassesLane, createThreadTable } from './threads.ts';
import { createStreams } from './logs/streams.ts';
import { handleLogRequest } from './logs/protocol.ts';
import { writeDesktopKey } from './desktop-key.ts';
import { createNetThread, type NetOptions } from './net.ts';
import { followEngine } from './engine-follow.ts';
import { takeLock } from '../engine-store/locks.ts';
import { createStatusSnapshots } from './status-snapshot.ts';
import { crashLooping, holdCrashLoop, keptBoots, parseBoots, type Boot } from './crash-hold.ts';
import { ASKED_MS, autoUpdateOn, checkForUpdate, DAILY_MS, lastUpdateCheck, updateDue } from './auto-update.ts';
import { ownStoreEngine, requireCurrentEngine } from '../daemon/engine-switch.ts';
import { readRecords } from '../engine-store/store.ts';
// compat C25 until removal-minor
import { stopForeignSupervisors } from './foreign-supervisors.ts';
// compat end
import {
  ATTACHED_ARG,
  attachedExitWaitMs,
  KILL_GRACE_MS,
  endAttached,
  NO_HANDOVER_ARG,
  readoptJournal,
  SANDBOX_EXIT,
  stimdLifetime,
} from './attached.ts';

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
const SUCCESSOR_BIND_MS = 10_000;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Resource = 'build' | 'boot';

const RESOURCES: readonly Resource[] = ['build', 'boot'];
/** What `stim serve` and a service unit ask the net thread to serve from stimd's boot. */
export type ServeOptions = Omit<NetOptions, 'desktopKey' | 'script' | 'owner'>;

const OPS: Record<Resource, { wait: string; waiting: string; released: string; changed: string }> = {
  build: { wait: 'slot.wait', waiting: 'slot.waiting', released: 'slot.released', changed: 'slot.changed' },
  boot: { wait: 'boot.wait', waiting: 'boot.waiting', released: 'boot.released', changed: 'boot.changed' },
};

/** Marks this stimd's boot abnormal in its home claim, which then outlives it; set while `runStimd` holds that claim. */
let markAbnormal: (() => void) | null = null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const reportNet = (answer: NetAnswer | null): void =>
  answer?.listening ? undefined : console.error(`stimd: ${answer?.message ?? 'stimd did not answer'}`);

async function takeClaim(
  root: string,
  mode: 'exclusive' | 'shared',
  label: string,
  details: Record<string, unknown>,
  beforeRetry: () => Promise<unknown> = async () => {},
  retries = CLAIM_TRIES,
): Promise<ClaimHandle | null> {
  for (let tries = 0; ; tries++) {
    const attempt = tryAcquireClaim({ root, mode, label, details });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) return attempt.acquired;
    if (tries >= retries) return null;
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
function homeAlive(config: Config | null, measured: TickMeasurement, active = false): string | null {
  if (active) return 'a command is running';
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

function keepsServingWhenOff(attached: boolean, active: boolean, network: boolean, restarting: boolean): boolean {
  return attached || active || network || restarting || metroChildrenRun();
}

function attachedReply(attached: boolean, instance?: string): { attached?: true; instance?: string } {
  return attached ? { attached: true, ...(instance ? { instance } : {}) } : {};
}

function markDaemonFailure(level: Level, attached: boolean, mark: (() => void) | null): void {
  if (level !== 'error') return;
  mark?.();
  if (attached) process.exitCode = 1;
}

function refreshRetention(retention: ReturnType<typeof followEngine>): string | null {
  try {
    retention?.record(true, workspaceEngineDirs(loadConfig()));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function handleNetStop(
  serve: ServeOptions | undefined,
  closing: boolean,
  attached: boolean,
  end: (why: string, level: Level) => void,
  shutdown: (why: string, level: Level) => void,
  tick: () => void,
): void {
  if (!serve || closing) return tick();
  const why = 'the net thread `stim serve` started exited';
  if (attached) end(why, 'warn');
  else shutdown(why, 'warn');
}

function refusesSealedOperation(sealed: boolean, op: unknown): boolean {
  return (
    sealed &&
    [
      'op.begin',
      'net.ensure',
      'metro.ensure',
      'tunnel.ensure',
      'logs.start',
      'metro.prepare',
      'lease.prepare',
      'lease.acquire',
    ].includes(String(op))
  );
}

function endingForeground(ending: string | null, attached: boolean, error: unknown): boolean {
  return Boolean(ending || (attached && isUnverifiedCleanup(error)));
}

function handleForegroundError(
  error: unknown,
  ending: string | null,
  attached: boolean,
  end: (why: string, level: Level) => void,
  shutdown: (why: string, level: Level) => void,
): unknown {
  if (endingForeground(ending, attached, error)) {
    end('foreground cleanup could not be verified', 'error');
    return isClaimUnavailable(error) ? error : undefined;
  }
  shutdown(
    `the tick failed, so each supervisor's own idle timer takes over: ${error instanceof Error ? error.message : String(error)}`,
    'error',
  );
  return isUnverifiedCleanup(error) ? error : undefined;
}

function createNetAndLogsClose(
  net: ReturnType<typeof createNetThread>,
  logs: ReturnType<typeof createStreams>,
): () => Promise<void> {
  let netAndLogsClose: Promise<void> | undefined;
  return (): Promise<void> => {
    netAndLogsClose ??= (async () => {
      let netFailure: unknown;
      try {
        await net.close();
      } catch (error) {
        netFailure = error;
      }
      try {
        await logs.close();
      } catch (error) {
        if (logs.running())
          throw Object.assign(new ClaimUnavailableError(`device log cleanup could not be verified: ${String(error)}`), {
            reportCleanup: true,
            remedy: 'Inspect the device log claim and verify its process tree has stopped.',
          });
        throw error;
      }
      if (netFailure) throw netFailure;
    })();
    return netAndLogsClose;
  };
}

function attachedCleanupError(
  initial: unknown,
  background: unknown,
  results: PromiseSettledResult<unknown>[],
): unknown {
  const errors = [
    initial,
    background,
    ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
  ];
  return errors.find(isUnverifiedCleanup) ?? errors.find(Boolean);
}

function countIdleTicks(idle: boolean, streamsRunning: boolean, previous: number): number {
  return idle && !streamsRunning ? previous + 1 : 0;
}

function resolveForeground(): void {}

async function waitForeground(done: Promise<void> | undefined, failure: () => unknown): Promise<void> {
  await done;
  const error = failure();
  if (error) throw error;
}

function isUnverifiedCleanup(error: unknown): boolean {
  return isClaimUnavailable(error) && 'reportCleanup' in error;
}

function retainUnverifiedForeground(
  error: unknown,
  home: ClaimHandle,
  retention: ReturnType<typeof followEngine>,
): unknown {
  if (!isClaimUnavailable(error)) return undefined;
  if (!('reportCleanup' in error)) return error;
  if ('retentionFailure' in error) return error;
  markClaimChildPending(home);
  const enginePath = retention?.retainUnknown();
  const paths = [home.path, ...(enginePath ? [enginePath] : [])];
  error.message += ` Stimd ownership remains held at ${paths.join(', ')}.`;
  return Object.assign(error, {
    retentionFailure: true,
    remedy: `${error.remedy} After verifying the child and descendants have stopped, remove these claims: ${paths.map(claimRemoveCommand).join('; ')}`,
  });
}

async function retainAttachedEngine(attached: boolean, log: Parameters<typeof followEngine>[0], cleanup: () => void) {
  if (!attached) return null;
  const engine = ownStoreEngine();
  if (!engine) return null;
  let lock: Awaited<ReturnType<typeof takeLock>> = null;
  try {
    for (const until = Date.now() + 10_000; !lock && Date.now() < until;) {
      lock = await takeLock(engine.root, '.lock.sock');
      if (!lock) await new Promise((done) => setTimeout(done, 50));
    }
  } catch (error) {
    cleanup();
    if (
      error instanceof Error &&
      'socketPath' in error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    )
      throw Object.assign(new Error(error.message), { code: SANDBOX_BLOCKED, engineLock: true });
    throw error;
  }
  if (!lock) {
    cleanup();
    throw Object.assign(
      new ClaimUnavailableError('could not lock the attached Stim engine store', {
        claimPath: join(engine.root, 'claims', engine.build),
      }),
      { retentionFailure: true },
    );
  }
  try {
    requireCurrentEngine(engine);
    const retention = followEngine(log, true);
    if (!retention)
      throw new ClaimUnavailableError('could not retain the attached Stim engine', {
        claimPath: join(engine.root, 'claims', engine.build),
      });
    retention.record(true, workspaceEngineDirs(loadConfig()));
    return retention;
  } catch (error) {
    cleanup();
    if (isClaimRefusal(error) || isClaimUnavailable(error)) Object.assign(error, { retentionFailure: true });
    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * One resident stimd per Stim home, which returns false when another holds the home: holds the claim at `run/stimd` exclusively and the daemon claim at `daemon/claim`
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
  serve,
  desktopKey,
  onNet,
  afterSwitch = false,
  service = serve !== undefined,
  attached,
}: {
  tickMs?: number;
  /** The tick interval while nothing runs in the home and the pressure level is normal: 5 minutes. */
  slowTickMs?: number;
  /** The mode the starting command resolved; a later `daemon.mode` change in config can only make it stricter. */
  mode?: DaemonMode;
  /** Starts the net thread at boot with these options, for `stim serve` and a service unit. */
  serve?: ServeOptions;
  /** The Desktop key to write to `run/desktop.key` instead of a new one: the key a Stim Desktop gave on stdin. */
  desktopKey?: string;
  /** Gets the net thread's first answer to `serve`. */
  onNet?: (answer: Awaited<ReturnType<ReturnType<typeof createNetThread>['ensure']>>) => void;
  /** Started by a stimd of the previous build after an engine switch: stops that build's supervisors when idle. */
  afterSwitch?: boolean;
  /** Whether a service unit or `stim serve` runs this stimd, which turns `engine.autoUpdate`'s `auto` on. */
  service?: boolean;
  /**
   * Bound to the process that started it (`hostStimd`): it neither follows the engine nor exits idle or under
   * `daemon.mode` off, and ends when its stdin closes or on a signal, through `endAttached`.
   */
  attached?: { handover: boolean };
} = {}): Promise<boolean> {
  const identity = stimBuild();
  const build = stimdBuildId();
  const configAtStart = configuredDaemonMode();
  const effectiveMode = () => {
    const configured = configuredDaemonMode();
    return configured === configAtStart ? startMode : stricterDaemonMode(startMode, configured ?? 'on');
  };
  const started = performance.now();
  const startedAt = new Date().toISOString();
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  const log = (level: Level, event: string, msg: string, fields: Record<string, unknown> = {}) =>
    writer.write({ src: 'stimd', level, event, msg, ...fields });
  const path = stimdSocket();
  const bootAt = Date.now();
  const leftover = readClaimSet(stimdClaimRoot()).dead;
  const boots: Boot[] = keptBoots(
    [...leftover.flatMap((holder) => parseBoots(holder.details.boots)), { at: bootAt, build }],
    bootAt,
  );
  const updateCheckedAt = Math.max(0, ...leftover.map((holder) => Number(holder.details.updateCheckedAt) || 0));
  const details = {
    socket: path,
    mode: startMode,
    build,
    version: identity.version,
    boots,
    updateCheckedAt,
    ...attachedReply(attached !== undefined),
  };
  const lifetime = stimdLifetime(attached !== undefined, identity.version);
  const instance = randomUUID();
  let own = await takeClaim(stimdClaimRoot(), 'exclusive', 'stimd', details, undefined, lifetime.retries(CLAIM_TRIES));
  if (!own) {
    log('debug', 'stimd_claim_held', 'another stimd holds this Stim home; exiting');
    writer.close();
    const answer = attached ? await waitForStimdHello() : null;
    if (answer)
      await new Promise<void>((done) =>
        process.stdout.write(`${JSON.stringify({ op: `attached-${answer}` })}\n`, () => done()),
      );
    return false;
  }
  const homeClaim = own;
  let keepOwn = false;
  markAbnormal = () => {
    if (!own || keepOwn) return;
    keepOwn = true;
    const marked = boots.map((boot) =>
      boot.at === bootAt && boot.build === build ? { ...boot, abnormal: true } : boot,
    );
    own = updateClaimDetails(own, { ...details, boots: marked }) ?? own;
  };
  const store = lifetime.detachedOnly(ownStoreEngine);
  if (store && crashLooping(boots, build)) {
    const held = await holdCrashLoop(store, identity.version, getConfigDir());
    if ('rolledBack' in held || 'moved' in held) {
      const current = readRecords(store.root).current;
      log(
        'error',
        'engine_rolled_back',
        `${identity.version} crashed 3 times in 10 minutes; the engine runs ${current?.version}`,
      );
      releaseClaim(own);
      markAbnormal = null;
      if (current)
        launchStimd(process.env, startMode, process.platform, join(store.root, current.dir, 'dist', 'cli.mjs'), [
          '--after-switch',
          ...serveArgs(serve ?? null, service),
        ]);
      writer.close();
      return false;
    }
    const message =
      'staged' in held
        ? `engine ${identity.version} crashes; going back to the previous build waits for other homes' stimds to drain`
        : held.stop;
    console.error(`stimd: ${message}`);
    log('error', 'engine_crash_hold', message);
    let checked = updateCheckedAt;
    if (
      autoUpdateOn(loadConfig()?.engine?.autoUpdate, readRecords(store.root).state.installedBy, service) &&
      updateDue(checked, Date.now(), ASKED_MS)
    ) {
      const line = await checkForUpdate(store, 'crash hold').catch((error: unknown) => String(error));
      log('info', 'engine_update_check', `crash hold: ${line}`);
      checked = Date.now();
    }
    own = updateClaimDetails(own, { ...details, updateCheckedAt: checked }) ?? own;
    markAbnormal = null;
    process.exitCode = 1;
    writer.close();
    return true;
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
    return false;
  }
  readoptJournal(log);
  const follower = lifetime.detachedOnly(() => followEngine(log));
  follower?.record(false, workspaceEngineDirs(loadConfig()));
  const retention = await retainAttachedEngine(attached !== undefined, log, () => {
    releaseClaim(claim);
    releaseClaim(own);
    writer.close();
  });
  process.title = 'stimd';
  const key = writeDesktopKey(desktopKey);
  const script = realpathSync(process.argv[1] ?? '');
  const net = createNetThread(
    log,
    () => {
      lastContact = Date.now();
      if (restartingNet) return;
      handleNetStop(serve, closing, attached !== undefined, requestEnd, shutdown, requestTick);
    },
    (why) => maybeUpdate(why, ASKED_MS),
  );
  let restartingNet = false;
  let updating: Promise<void> | null = null;
  const maybeUpdate = (why: string, everyMs: number) => {
    if (!follower || updating || closing) return;
    try {
      const on = autoUpdateOn(
        loadConfig()?.engine?.autoUpdate,
        readRecords(follower.engine.root).state.installedBy,
        service,
      );
      if (!on || !updateDue(lastUpdateCheck(follower.engine.root), Date.now(), everyMs)) return;
    } catch {
      return;
    }
    const engine = follower.engine;
    updating = checkForUpdate(engine, why)
      .then(
        (line) => log('info', 'engine_update_check', `${why}: ${line}`),
        (error: unknown) =>
          log('warn', 'engine_update_failed', `${why}: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        updating = null;
        void checkEngine();
      })
      .then(() => undefined);
  };
  const netOptions = (fields: Partial<NetOptions>): NetOptions => ({
    port: DEFAULT_SERVER_PORT,
    extraEnv: [],
    pathPrepend: [],
    loopbackOnly: false,
    shareOnly: false,
    attached: attached !== undefined,
    ...fields,
    desktopKey: key,
    script,
  });
  const logs = createStreams((message) => log('warn', 'device_logs', message));
  const threads = createThreadTable(log);
  let backgroundFailure: unknown;
  const lane = createPassesLane(threads, log, (error) => {
    failBackground(error, 'background cleanup could not be verified');
  });
  const statuses = createStatusSnapshots(log, join(daemonDir(), 'status-cwds.json'));
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
  const ops = new Map<Socket, 'pinned' | 'waiting'>();
  const hasOffWork = () =>
    Boolean(
      logs.running() ||
      keepsServingWhenOff(lifetime.keepsServingWhenOff, ops.size > 0, Boolean(net.running()), restartingNet),
    );
  const opContexts = new Map<Socket, Invocation & { workspace: string }>();
  const opControllers = new Map<Socket, AbortController>();
  const opTokens = new Map<string, Socket>();
  const leaseTickets = createLeaseTickets((message) => log('warn', 'device_lease_release_failed', message));
  const metroTickets = createMetroTickets(log);
  const socketTokens = new WeakMap<Socket, string>();
  const opCommands = new WeakMap<Socket, string>();
  let ending: string | null = null;
  let endingLevel: Level = 'info';
  let attachedEnding: Promise<void> | undefined;
  let shutdownDone: Promise<void> | undefined;
  let writerDone: Promise<void> | undefined;
  const foregroundAbort = new AbortController();
  let foregroundDone: Promise<void> | undefined;
  let foregroundFailure: unknown;
  let admissionRevision = 0;
  let sealed = false;
  let attachedWatchdog: NodeJS.Timeout | undefined;
  const maintenanceAllowed = () => !closing && !ending;
  let engineDirs: string[] = [];
  try {
    if (follower) engineDirs = workspaceEngineDirs(loadConfig());
  } catch {}
  let netServes: ServeOptions | null = serve ?? null;
  let switchedTo: { build: string; version: string } | null = null;
  let foreignLeft = afterSwitch;
  let heldSwitch = false;
  const hasActiveCommands = () => ops.size > 0;
  const pinned = (): boolean =>
    Boolean(backgroundFailure) ||
    metroCleanupPending() ||
    [...ops.values()].includes('pinned') ||
    listBuildSlots().some((slot) => slot.alive && slot.client !== null) ||
    (net.running() !== null && readHostedSessions().some(hostedNativeWork));
  const enginePinned = (): boolean => pinned() || logs.running();
  const failBackground = (error: unknown, why: string) => {
    backgroundFailure = error;
    keepOwn = true;
    markClaimChildPending(homeClaim);
    try {
      (retention ?? follower)?.record(true, [...engineDirs, ...metroEngineDirs()]);
    } finally {
      retainUnverifiedForeground(error, homeClaim, retention ?? follower);
    }
    if (attached) requestEnd(why, 'error');
    else shutdown(why, 'error');
  };
  const checkEngine = async (): Promise<void> => {
    if (!follower || switchedTo || closing) return;
    let next: Awaited<ReturnType<typeof follower.check>>;
    try {
      follower.record(enginePinned(), [...engineDirs, ...metroEngineDirs()], logs.running());
      next = await follower.check(enginePinned);
    } catch (error) {
      log('warn', 'engine_check_failed', error instanceof Error ? error.message : String(error));
      return;
    }
    if (!next || switchedTo || closing) return;
    if (!enginePinned()) await relaunch(next, follower.engine.root);
    else if (!heldSwitch) {
      heldSwitch = true;
      log(
        'warn',
        'engine_switch_pinned',
        `the engine switched to ${next.version} under pinned work; relaunching after it`,
      );
    }
  };
  const relaunch = async (next: { build: string; version: string }, root: string) => {
    switchedTo = next;
    const changed = `${JSON.stringify({ op: 'engine-changed', ...next, pid: process.pid })}\n`;
    for (const list of [waiters.build, waiters.boot, tickReplies]) list.length = 0;
    for (const socket of open) socket.end(changed);
    const running = net.running();
    const carried = running && netServes ? { ...netServes, shareOnly: running.shareOnly } : null;
    const why = `the engine switched to ${next.version} (${next.build})`;
    shutdown(why);
    await net.close();
    launchStimd(process.env, startMode, process.platform, join(root, next.build, 'dist', 'cli.mjs'), [
      '--after-switch',
      ...serveArgs(carried, service),
    ]);
    for (const deadline = Date.now() + SUCCESSOR_BIND_MS; Date.now() < deadline;) {
      const record = readJsonObject(stimdRecordFile());
      if (record?.build === next.build && record.pid !== process.pid) return;
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const server = createServer((socket) => {
    open.add(socket);
    void checkEngine();
    socket.once('close', () => open.delete(socket));
    let buffer = Buffer.alloc(0);
    let framed = false;
    let kind: unknown;
    socket.on('error', () => drop(socket));
    socket.on('close', () => {
      drop(socket);
      opContexts.delete(socket);
      const token = socketTokens.get(socket);
      if (token) opTokens.delete(token);
      opControllers.get(socket)?.abort();
      leaseTickets.drop(socket);
      metroTickets.drop(socket);
      opControllers.delete(socket);
      if (ops.delete(socket)) void checkEngine();
    });
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
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
          if (message.kind !== 'cli' && message.kind !== 'api' && message.kind !== 'desktop') {
            reply({ op: 'error', code: 'unknown-kind', message: 'the first frame names no client kind' });
            socket.end();
            return;
          }
          if (switchedTo || (message.kind !== 'desktop' && message.build !== build)) {
            reply({ op: 'engine-changed', build, ...lifetime.refusal, pid: process.pid, ...switchedTo });
            socket.end();
            return;
          }
          // compat end
          framed = true;
          kind = message.kind;
          if (kind === 'desktop') maybeUpdate('Stim Desktop connected', ASKED_MS);
          lastContact = Date.now();
          reply({ op: 'hello', kind: 'stimd', pid: process.pid, build, version: identity.version });
          continue;
        }
        lastContact = Date.now();
        const { op } = message;
        if (refusesSealedOperation(sealed, op)) {
          socket.end(
            `${JSON.stringify({ op: 'error', code: 'daemon-ending', message: 'The Stim daemon is ending.' })}\n`,
          );
          continue;
        }
        if (
          handleLogRequest({
            message,
            socket,
            streams: logs,
            operations: opContexts,
            controllers: opControllers,
            tokens: opTokens,
            attached: attached !== undefined,
          })
        )
          continue;
        if (
          handleMetroTicketRequest({
            message,
            socket,
            tickets: metroTickets,
            operations: opContexts,
            controllers: opControllers,
            tokens: opTokens,
          })
        )
          continue;
        if (
          handleLeaseRequest({
            message,
            socket,
            tickets: leaseTickets,
            operations: opContexts,
            controllers: opControllers,
            tokens: opTokens,
          })
        )
          continue;
        if (op === 'hello') {
          hasten?.();
          socket.end(
            `${JSON.stringify({ op: 'hello', pid: process.pid, build, version: identity.version, mode: effectiveMode(), ...attachedReply(attached !== undefined) })}\n`,
          );
        } else if (op === 'presence.publish') {
          socket.end(`${JSON.stringify({ op: 'presence', forwarded: net.presence(message.params) })}\n`);
        } else if (op === 'net.ensure') {
          admissionRevision++;
          const params = isJsonObject(message.params) ? message.params : {};
          const share = params.share === true;
          const port = Number.isInteger(params.port) ? Number(params.port) : undefined;
          const options = netOptions({
            ...(port !== undefined && port >= 0 && port <= 65535 ? { port } : share ? { port: 0 } : {}),
            loopbackOnly: share || params.loopbackOnly === true,
            extraEnv: strings(params.extraEnv),
            pathPrepend: strings(params.pathPrepend),
            shareOnly: share,
            ...(kind === 'desktop' ? { owner: 'desktop' } : {}),
          });
          const running = net.running();
          const restart =
            kind === 'desktop' &&
            !service &&
            !pinned() &&
            running !== null &&
            (running.loopbackOnly !== options.loopbackOnly ||
              (port !== undefined && port !== 0 && running.port !== null && port !== running.port));
          if (!running || restart) netServes = options;
          const answer = restart
            ? (() => {
                log('info', 'net_restart', 'Stim Desktop asked for other net thread options; restarting it');
                restartingNet = true;
                return net.close().then(() => {
                  restartingNet = false;
                  return net.ensure(options);
                });
              })()
            : net.ensure(options);
          void answer.then((state) => {
            lastContact = Date.now();
            return reply({ op: 'net', ...state });
          });
        } else if (op === 'net.connect') {
          socket.off('data', onData);
          const head = buffer;
          buffer = Buffer.alloc(0);
          if (net.connect(socket, head)) {
            open.delete(socket);
            reply({ op: 'net.connected' });
          } else
            socket.end(`${JSON.stringify({ op: 'error', code: 'net-off', message: 'the net thread does not run' })}\n`);
          return;
        } else if (op === 'op.begin') {
          admissionRevision++;
          hasten?.();
          ops.set(socket, 'pinned');
          opControllers.set(socket, new AbortController());
          opCommands.set(socket, typeof message.command === 'string' ? message.command : 'a command');
          void (follower?.admit() ?? Promise.resolve(null))
            .catch((error: unknown) => {
              log('warn', 'engine_admit_failed', error instanceof Error ? error.message : String(error));
              return null;
            })
            .then((next) => {
              if (socket.destroyed) return undefined;
              if (!next) {
                const params = isJsonObject(message.params) ? message.params : {};
                const forwarded = isJsonObject(params.forwarded) ? params.forwarded : {};
                if (
                  typeof params.workspace === 'string' &&
                  typeof forwarded.cwd === 'string' &&
                  isJsonObject(forwarded.env)
                ) {
                  const env = Object.fromEntries(
                    Object.entries(forwarded.env).filter(
                      (entry): entry is [string, string] => typeof entry[1] === 'string',
                    ),
                  );
                  const context = invocation(forwarded.cwd, env);
                  if ('code' in context) {
                    ops.delete(socket);
                    void checkEngine();
                    socket.end(`${JSON.stringify({ op: 'error', ...context })}\n`);
                    return undefined;
                  }
                  opContexts.set(socket, { ...context, workspace: params.workspace });
                  const token = randomUUID();
                  opTokens.set(token, socket);
                  socketTokens.set(socket, token);
                  setMetroInvocation(params.workspace, { ...context, workspace: params.workspace });
                }
                reply({
                  op: 'op.begun',
                  ...metroOpFlags(message.params),
                  ...(socketTokens.has(socket) ? { opToken: socketTokens.get(socket) } : {}),
                  ...attachedReply(attached !== undefined, instance),
                });
                return undefined;
              }
              ops.delete(socket);
              socket.end(`${JSON.stringify({ op: 'engine-changed', ...next, pid: process.pid })}\n`);
              return checkEngine();
            });
        } else if (op === 'op.wait' || op === 'op.resume') {
          if (ops.has(socket)) ops.set(socket, op === 'op.wait' ? 'waiting' : 'pinned');
          void checkEngine();
        } else if (op === 'metro.ensure' || op === 'tunnel.ensure') {
          admissionRevision++;
          const context = opContexts.get(socket);
          if (ops.has(socket) && !context) {
            reply({ op: 'error', code: 'op-not-ready', message: 'the operation has no admitted workspace' });
            continue;
          }
          const fields = isJsonObject(message.params) ? message.params : {};
          let operationEnv: NodeJS.ProcessEnv | undefined;
          try {
            if (
              context &&
              typeof fields.root === 'string' &&
              realpathSync(fields.root) === realpathSync(context.workspace)
            )
              operationEnv = context.forwarded.env;
          } catch {}
          if (context && !operationEnv) {
            reply({
              op: 'error',
              code: 'bad-workspace',
              message: 'the request does not match the operation workspace',
            });
            continue;
          }
          const perform = () =>
            op === 'metro.ensure'
              ? ensureMetro(message.params, log, operationEnv, opControllers.get(socket)?.signal)
              : ensureTunnel(message.params, operationEnv);
          const controller = opControllers.get(socket);
          const ask =
            context && controller
              ? traceInvocation(context, `stimd.${op}`, () => withInvocation(context, controller.signal, perform))
              : perform();
          void ask
            .catch((error: unknown) => ({
              op: 'error',
              code: op,
              message: error instanceof Error ? error.message : String(error),
            }))
            .then((answer) => {
              if (ops.has(socket)) return reply(answer);
              return socket.end(`${JSON.stringify(answer)}\n`);
            });
        } else if (op === 'snapshot') socket.end(`${JSON.stringify({ op: 'snapshot', snapshot: lastSnapshot })}\n`);
        else if (op === 'status') void statuses.answer(message.params).then((answer) => socket.end(`${answer}\n`));
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
    };
    socket.on('data', onData);
  });
  let bound = false;
  const waitMs = attachedExitWaitMs();
  const closeNetAndLogs = createNetAndLogsClose(net, logs);
  let attachedCleanup: Promise<void> | undefined;
  const closeAttachedWork = (why: string, initial?: unknown): Promise<void> => {
    attachedCleanup ??= (async () => {
      const results = await Promise.allSettled([
        waitForeground(foregroundDone, () => foregroundFailure),
        lane.settled(),
        dependencyWork,
        closeMetroChildren(),
        closeNetAndLogs(),
      ]);
      const error = attachedCleanupError(initial, backgroundFailure, results);
      if (error) {
        const retained = retainUnverifiedForeground(error, homeClaim, retention) ?? error;
        shutdown('attached cleanup could not be verified', 'error', true);
        await shutdownDone;
        throw retained;
      }
      shutdown(why, endingLevel);
      await shutdownDone;
    })();
    return attachedCleanup;
  };
  const finishAttached = () =>
    endAttached({
      inFlight: () => [...ops.keys()].map((socket) => opCommands.get(socket) ?? 'a command'),
      admissionRevision: () => admissionRevision,
      seal: () => {
        sealed = true;
      },
      alive: async (signal) =>
        net.running()
          ? 'the net thread serves'
          : metroChildrenRun()
            ? 'Metro or a tunnel is running'
            : homeAlive(loadConfig(), await measureTick(loadConfig(), Date.now(), { probe: false, signal })),
      waitMs,
      handover: attached?.handover ?? false,
      mode: effectiveMode,
      identity: { build, version: identity.version },
      successorArgs: () => {
        const running = net.running();
        const carried = running && netServes ? { ...netServes, shareOnly: running.shareOnly } : null;
        return serveArgs(carried, service);
      },
      release: (why) => closeAttachedWork(ending === 'stdin' ? why : `${why} (${ending})`),
      log,
    }).catch((error: unknown) => {
      sealed = true;
      return closeAttachedWork('attached cleanup failed', error);
    });
  const requestEnd = (why: string, level: Level = 'info') => {
    if (ending) return;
    ending = why;
    endingLevel = level;
    attachedWatchdog = setTimeout(() => process.exit(1), waitMs + KILL_GRACE_MS);
    attachedWatchdog.unref();
    foregroundAbort.abort();
    stopMetroTicks();
    interrupt?.();
    threads.abort('passes');
    threads.abort('measure');
    attachedEnding = finishAttached();
  };
  const onSignal = (signal: NodeJS.Signals) => (attached ? lifetime.signal(signal, requestEnd) : shutdown(signal));
  const shutdown = (why: string, level: Level = 'info', preserve = false) => {
    if (closing) return;
    closing = true;
    foregroundAbort.abort();
    markDaemonFailure(level, attached !== undefined, markAbnormal);
    if (dependencyWork) log('debug', 'daemon_dependency_scan_cancelled', 'stopping the dependency size scan');
    threads.abort('measure');
    statuses.close();
    loopDelay.disable();
    interrupt?.();
    server.close();
    for (const waiter of [...waiters.build, ...waiters.boot, ...tickReplies]) waiter.destroy();
    for (const socket of open) socket.end().unref();
    if (bound && process.platform !== 'win32') rmSync(path, { force: true });
    if (readJsonObject(stimdRecordFile())?.pid === process.pid) rmSync(stimdRecordFile(), { force: true });
    for (const signal of SIGNALS) process.off(signal, onSignal);
    log(level, 'daemon_exited', `exiting: ${why}`);
    let unverified = false;
    shutdownDone = Promise.allSettled([
      waitForeground(foregroundDone, () => foregroundFailure),
      lane.settled(),
      dependencyWork,
      closeMetroChildren(),
      closeNetAndLogs(),
    ])
      .then(async (results) => {
        const error = attachedCleanupError(undefined, backgroundFailure, results);
        if (isUnverifiedCleanup(error)) {
          unverified = true;
          keepOwn = true;
          retainUnverifiedForeground(error, homeClaim, retention ?? follower);
        }
        await threads.close();
        return undefined;
      })
      .catch(() => {})
      .then(() => {
        if (!unverified && !metroCleanupPending()) follower?.release();
        releaseClaim(claim);
        if (!keepOwn) releaseClaim(own);
        markAbnormal = null;
        if (!preserve && !unverified) retention?.release();
        return undefined;
      });
    writerDone = shutdownDone
      .then(() => attachedEnding)
      .catch(() => {})
      .then(async () => {
        await writer.close();
        return undefined;
      });
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
    shutdown(`cannot listen on ${path}: ${error instanceof Error ? error.message : String(error)}`, lifetime.failLevel);
    throw lifetime.listenFailed(error);
  }
  openMetroChildren((error) => {
    failBackground(error, 'Metro cleanup could not be verified');
    log('error', 'metro_cleanup_unverified', error instanceof Error ? error.message : String(error));
  });
  adoptMetroChildren(log);
  (retention ?? follower)?.record(Boolean(retention), [...workspaceEngineDirs(loadConfig()), ...metroEngineDirs()]);
  if (serve) void net.ensure(netOptions(serve)).then((answer) => onNet?.(answer));
  lifetime.serve(requestEnd, waitMs, instance);
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
    if (!maintenanceAllowed()) break;
    tickRequested = false;
    const mode = effectiveMode();
    const retentionError = refreshRetention(retention);
    if (retentionError) {
      shutdown(`the attached engine claim failed: ${retentionError}`, 'error');
      break;
    }
    void metroTick(mode === 'on', log).catch((error: unknown) => log('warn', 'metro_tick_failed', String(error)));
    if (mode === 'off') {
      if (hasOffWork()) {
        for (const socket of tickReplies.splice(0)) socket.destroy();
        continue;
      }
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
    let ticked: HomePasses;
    let settleForeground: () => void = resolveForeground;
    foregroundDone = new Promise<void>((done) => {
      settleForeground = done;
    });
    try {
      const passes = await runHomePasses({
        act: mode === 'on',
        log,
        memoryWarningSince: lastSnapshot?.pressure?.memoryWarningSince ?? null,
        signal: foregroundAbort.signal,
      });
      const { config, now, measured, workspaces, pressure, actions, operation } = passes;
      operation.signal.throwIfAborted();
      actions.push(...lane.take());
      if (maintenanceAllowed() && !dependencyWork && Date.now() - dependencyScanAt >= DEPENDENCY_SCAN_MS) {
        dependencyScanAt = Date.now();
        dependencyWork = threads
          .run('measure', { cwd: process.cwd() })
          .then(() => undefined)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (isUnverifiedCleanup(error)) {
              failBackground(error, 'dependency cleanup could not be verified');
            }
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
      operation.signal.throwIfAborted();
      phases = { ...passes.phases, reclaimMs: Math.round(performance.now() - reclaimStarted) };
      if (reclaimed) {
        actions.push(reclaimed);
        if (reclaimed.outcome === 'done') wakeOldest('boot');
      }
      const waiting = listWaiting();
      alive =
        waiters.build.length || waiters.boot.length || waiting.length
          ? 'a run waits for a build slot or a device boot'
          : net.running()
            ? 'the net thread serves'
            : homeAlive(config, measured, hasActiveCommands());
      pending = alive
        ? null
        : maintaining
          ? 'automatic maintenance runs'
          : updating
            ? 'an engine update check runs'
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
      engineDirs = workspaceEngineDirs(config);
      // compat C25 until removal-minor
      if (foreignLeft && follower) foreignLeft = (await stopForeignSupervisors(follower.engine.build)) > 0;
      // compat end
      await checkEngine();
      maybeUpdate('daily check', DAILY_MS);
    } catch (error) {
      for (const socket of replying) socket.destroy();
      foregroundFailure = handleForegroundError(error, ending, attached !== undefined, requestEnd, shutdown);
      break;
    } finally {
      settleForeground();
    }
    if (!maintenanceAllowed()) break;
    const idle = !alive && !pending && !wentDormant && Date.now() - contactSince >= tickMs;
    emptyTicks = countIdleTicks(idle, logs.running(), emptyTicks);
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
    if (emptyTicks >= lifetime.idleTicks(EMPTY_TICKS_BEFORE_EXIT)) {
      await checkEngine();
      shutdown('nothing runs in this Stim home');
      break;
    }
    if (maintenanceAllowed()) lane.start(ticked, mode === 'on');
  }
  try {
    await attachedEnding;
  } finally {
    await Promise.allSettled([lane.settled(), dependencyWork, net.close()]);
    await threads.close();
    await shutdownDone;
    await writerDone;
    clearTimeout(attachedWatchdog);
  }
  return true;
}

/** The builds this home's dev server supervisors and device log collectors run, from their recorded `engineDir`. */
function workspaceEngineDirs(config: Config | null): string[] {
  return Object.keys(config?.projects ?? {}).flatMap((path) => {
    const state = readWorkspaceState(path);
    const claims = readClaimSet(join(workspaceDir(path), 'metro.claim')).live.map((claim) => claim.details);
    return [state?.supervisor, ...Object.values(state?.collectors ?? {}), ...claims].flatMap((record) => {
      return isJsonObject(record) && typeof record.engineDir === 'string' ? [record.engineDir] : [];
    });
  });
}

/**
 * Whether a hosted session has native work in flight: it is being prepared, or an app is being received or installed
 * into it. A receipt that cannot be read counts as none.
 */
function hostedNativeWork(session: HostedDeviceSession): boolean {
  if (session.state === 'preparing') return true;
  if (!session.appAttempt) return false;
  try {
    return ['receiving', 'installing'].includes(readHostedAppMetadata(session.id, session.appAttempt).state);
  } catch {
    return false;
  }
}

/**
 * `serviceArguments`' inverse: the arguments a successor stimd takes to serve as this one's net thread did. A net thread
 * that only serves `stim share` is not carried over, and one no service unit or `stim serve` started is marked
 * `--carried`, so its successor does not count as a service.
 */
function serveArgs(serve: ServeOptions | null, service: boolean): string[] {
  if (!serve || serve.shareOnly) return [];
  return [
    ...(service ? [] : ['--carried']),
    '--service',
    ...(serve.loopbackOnly ? ['--loopback-only'] : []),
    '--port',
    String(serve.port),
    ...serve.extraEnv.flatMap((entry) => ['--env', entry]),
    ...serve.pathPrepend.flatMap((dir) => ['--path-prepend', dir]),
  ];
}

/**
 * The net thread options in a unit's arguments, `--service --port <n> [--env <key>]... [--path-prepend <dir>]...`, as
 * `stim service install` writes them after the `bin/stimd` shim; undefined without `--service`.
 */
export function serviceArguments(argv: readonly string[]): ServeOptions | undefined {
  if (!argv.includes('--service')) return undefined;
  const serve: ServeOptions = {
    port: DEFAULT_SERVER_PORT,
    extraEnv: [],
    pathPrepend: [],
    loopbackOnly: false,
    shareOnly: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1];
    if (value === undefined) break;
    if (argv[index] === '--loopback-only') serve.loopbackOnly = true;
    if (argv[index] === '--port') serve.port = /^\d+$/.test(value) ? Number(value) : serve.port;
    else if (argv[index] === '--env') serve.extraEnv.push(value);
    else if (argv[index] === '--path-prepend') serve.pathPrepend.push(value);
    else continue;
    index++;
  }
  return serve;
}

/** The `__stimd` entry: `argv` is what follows it. */
export async function runStimdEntry(argv: readonly string[]): Promise<void> {
  const serve = serviceArguments(argv);
  if (relaunchWithLogFile(['__stimd', ...argv])) return;
  const label = process.env[LAUNCHD_LABEL_ENV];
  delete process.env[LAUNCHD_LABEL_ENV];
  if (label) {
    removeExitedJobs(label);
    delete process.env.XPC_SERVICE_NAME;
  }
  const at = argv.indexOf('--mode');
  process.once('uncaughtException', (error) => {
    markAbnormal?.();
    console.error(error);
    process.exit(1);
  });
  process.once('exit', (code) => {
    if (code !== 0) markAbnormal?.();
  });
  try {
    const served = await runStimd({
      mode:
        parseDaemonMode(at >= 0 ? argv[at + 1] : undefined) ??
        daemonMode(argv.includes(ATTACHED_ARG) ? process.env : {}),
      serve,
      onNet: reportNet,
      afterSwitch: argv.includes('--after-switch'),
      service: serve !== undefined && !argv.includes('--carried'),
      ...(argv.includes(ATTACHED_ARG) ? { attached: { handover: !argv.includes(NO_HANDOVER_ARG) } } : {}),
    });
    if (serve && !served && stimdLive()) await serveThroughStimd(serve, reportNet);
  } catch (error) {
    const message =
      isClaimRefusal(error) || isClaimUnavailable(error)
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error);
    markAbnormal?.();
    try {
      const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
      writer.write({ src: 'stimd', level: 'error', event: 'daemon_failed', msg: message });
      writer.close();
    } catch {}
    if (
      argv.includes(ATTACHED_ARG) &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'STIM_ENGINE_SWITCHED' &&
      'version' in error
    )
      await new Promise<void>((done) =>
        process.stdout.write(`${JSON.stringify({ op: 'attached-switched', version: error.version })}\n`, () => done()),
      );
    if (
      argv.includes(ATTACHED_ARG) &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'STIM_ENGINE_UNAVAILABLE'
    )
      await new Promise<void>((done) =>
        process.stdout.write(`${JSON.stringify({ op: 'attached-engine-unavailable' })}\n`, () => done()),
      );
    if (argv.includes(ATTACHED_ARG) && error instanceof Error && 'retentionFailure' in error) {
      const refusal = claimFailure(error, null);
      if (refusal) console.error(`${refusal.code}: ${refusal.message}\n${refusal.remedy}`);
      if (refusal)
        await new Promise<void>((done) =>
          process.stdout.write(`${JSON.stringify({ op: 'attached-claim-refusal', refusal })}\n`, () => done()),
        );
    }
    if (argv.includes(ATTACHED_ARG) && isSandboxBlocked(error) && 'engineLock' in error)
      await new Promise<void>((done) =>
        process.stdout.write(`${JSON.stringify({ op: 'attached-blocked-lock' })}\n`, () => done()),
      );
    process.exitCode = isSandboxBlocked(error) ? SANDBOX_EXIT : 1;
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
