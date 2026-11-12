import { runDirRemoved } from './run-dir.ts';
import { createMetroTickets, handleMetroTicketRequest } from './metro/tickets.ts';
import { createLeaseTickets, handleLeaseRequest } from './lease-tickets.ts';
import { randomUUID } from 'node:crypto';
import type { StimContext } from '@stim-cli/core';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  stimBuildId,
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
  processGroupAlive,
  isClaimRefusal,
  isClaimUnavailable,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  updateClaimDetails,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { reportChildOf, WorkspaceProcessCleanupError } from '../engine/workspace-process-error.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { spawnEntry, stimBuild } from '../spawn-entry.ts';
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
  stimdEnv,
  stimdLive,
  unresolvedStimdStartClaims,
  unresolvedDaemonClaimsError,
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
import { listenPipe } from './pipe-win32.ts';
import {
  adoptMetroChildren,
  openMetroChildren,
  metroCleanupPending,
  metroEngineDirs,
  stopMetroTicks,
  closeMetroChildren,
  ensureMetro,
  stopManagedMetro,
  ensureTunnel,
  metroChildrenRun,
  metroRootsEndingWithStimd,
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
const HOME_WATCH_MS = 15_000;
const HOME_WATCH_MISSES = 2;
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
  retries = CLAIM_TRIES,
): Promise<ClaimHandle | null> {
  for (let tries = 0; ; tries++) {
    const attempt = tryAcquireClaim({ root, mode, label, details });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) return attempt.acquired;
    if (tries >= retries) return null;
    await new Promise((done) => setTimeout(done, CLAIM_RETRY_MS));
  }
}

/** Why stimd cannot start while a stim-daemon from Stim 1.40 to 1.42 holds the daemon claim exclusively. */
// @ref LLP 0015#an-older-stim-daemons-claim-is-refused-not-taken-over -- stimd never signals a pid read from a claim
export function daemonClaimRefusal(): string {
  const pid = readClaimSet(daemonClaimRoot()).live.find((holder) => holder.mode === 'exclusive')?.owner.pid;
  return pid === undefined
    ? "a stim-daemon from an older stim holds this home's daemon claim, so stimd cannot start. Run stim doctor, which names it."
    : `stim-daemon pid ${pid} from an older stim holds this home's daemon claim, so stimd cannot start. Stop it with \`kill ${pid}\`; it also exits on its own after its workspaces stop. If a project pins stim 1.40-1.42: npm i -D stim@latest there; for npx: npx stim@latest`;
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
function homeAlive(
  config: Config | null,
  measured: TickMeasurement,
  active = false,
  unverified: string | null = null,
): string | null {
  if (unverified) return unverified;
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
  operation: StimContext,
): Promise<string | null> {
  const dormant = await pendingDormant(
    config,
    { simsFailed: measured.sims === null },
    { graceMs: slowTickMs, operation },
  );
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

const ownDist = () => dirname(fileURLToPath(import.meta.url));

/** The identity and modification time of this stimd's `dist` directory, which a package update changes. */
function distStamp(): string {
  try {
    const { ino, mtimeMs } = statSync(ownDist());
    return `${ino}:${mtimeMs}`;
  } catch {
    return '';
  }
}

/** The build and version this stimd's own installation holds now, which an update in place changes under it. */
function installedNow(): { build: string; version: string } | null {
  const dir = ownDist();
  const installed = stimBuildId(dir);
  if (!installed) return null;
  const version = readJsonObject(join(dir, '..', 'package.json'))?.version;
  return { build: installed, version: typeof version === 'string' ? version : installed };
}

function markDaemonFailure(level: Level, attached: boolean, mark: (() => void) | null): void {
  if (level !== 'error') return;
  if (attached) process.exitCode = 1;
  else mark?.();
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
  handingOver: () => boolean,
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
        await logs.close({ handover: handingOver() });
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

function resumeLogStreams(
  logs: ReturnType<typeof createStreams>,
  log: (level: Level, event: string, msg: string) => void,
  attached: boolean,
): void {
  if (attached) return;
  try {
    logs.resume(Object.keys(loadConfig()?.projects ?? {}), stimdEnv(process.env, process.platform));
  } catch (error) {
    log(
      'warn',
      'device_log_resume_failed',
      `the config cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function refuseUnresolvedDaemonClaims(writer: { close: () => unknown }): void {
  const blocking = unresolvedStimdStartClaims();
  if (!blocking.some((claim) => claim.path.endsWith('.claim'))) return;
  writer.close();
  const refusal = unresolvedDaemonClaimsError(blocking);
  throw Object.assign(refusal, { retentionFailure: true, remedy: refusal.remedy.replace(/ and retry\.$/, '') });
}

function logKeptWorkspaces(
  kept: Map<string, string>,
  workspaces: HomePasses['workspaces'],
  log: (level: Level, event: string, msg: string, fields?: Record<string, unknown>) => void,
): void {
  for (const { path: workspace, outcome, detail } of workspaces) {
    if (outcome !== 'kept') kept.delete(workspace);
    else if (kept.get(workspace) !== detail) {
      kept.set(workspace, detail);
      log('info', 'workspace_kept', `${workspace}: ${detail}`, { workspace });
    }
  }
}

const MAX_CONTAINED_CLEANUPS = 8;

function childKey(error: unknown): string | null {
  const child = reportChildOf(error);
  return child ? `${child.pid}:${child.processToken ?? ''}` : null;
}

/**
 * The children whose cleanup a tick or a Metro or tunnel stop could not verify. Each keeps stimd up until a later tick
 * finds it stopped, which releases the claims its failure retained once no other unverified child holds them. Only a
 * refusal that names one child and how to check it is contained, each child once and at most `MAX_CONTAINED_CLEANUPS`
 * of them; any other unverified cleanup ends stimd.
 */
function createCleanupWatch(log: (level: Level, event: string, msg: string) => void) {
  let unsettled: { error: ClaimUnavailableError; settled: () => boolean; claims: readonly ClaimHandle[] }[] = [];
  return {
    contain(error: unknown, ending: boolean): boolean {
      if (ending || !isUnverifiedCleanup(error)) return false;
      const key = childKey(error);
      const settled = cleanupCheck(error);
      if (!key || !settled) return false;
      if (unsettled.some((entry) => childKey(entry.error) === key)) return true;
      if (unsettled.length >= MAX_CONTAINED_CLEANUPS) return false;
      unsettled.push({
        error,
        settled,
        claims: error instanceof WorkspaceProcessCleanupError ? error.claims : [],
      });
      log(
        'error',
        'daemon_cleanup_unverified',
        `stimd goes on and stays up until the child has stopped: ${error.message} ${error.remedy ?? ''}`.trim(),
      );
      return true;
    },
    settle(): void {
      const stopped = unsettled.filter((entry) => entry.settled());
      unsettled = unsettled.filter((entry) => !stopped.includes(entry));
      const stillHeld = new Set(unsettled.flatMap((entry) => entry.claims.map((held) => held.path)));
      for (const entry of stopped) {
        const released = entry.claims
          .filter((held) => !stillHeld.has(held.path) && releaseClaim(held))
          .map((held) => held.path);
        log(
          'info',
          'daemon_cleanup_settled',
          `a child whose cleanup was not verified has stopped${released.length ? `; released ${released.join(', ')}` : ''}`,
        );
      }
    },
    pending: () => unsettled.length > 0,
    reason: () => (unsettled.length > 0 ? 'a child whose cleanup was not verified may still run' : null),
    errors: () => unsettled.map((entry) => entry.error),
  };
}

/** How a later tick learns that a child whose cleanup was not verified has stopped, or null when nothing can tell. */
function cleanupCheck(error: object): (() => boolean) | null {
  for (const key of ['cleanupSettled', 'reportResourceSettled']) {
    const check: unknown = Reflect.get(error, key);
    if (typeof check === 'function') return () => check() === true;
  }
  const child = reportChildOf(error);
  return child && process.platform !== 'win32' ? () => !processGroupAlive(child.pid) : null;
}

function isUnverifiedCleanup(error: unknown): error is ClaimUnavailableError {
  return isClaimUnavailable(error) && 'reportCleanup' in error;
}

async function retainAttachedEngine(
  attached: boolean,
  log: Parameters<typeof followEngine>[0],
  cleanup: () => void,
  signal?: AbortSignal,
) {
  if (!attached) return null;
  const engine = ownStoreEngine();
  if (!engine) return null;
  let lock: Awaited<ReturnType<typeof takeLock>> = null;
  try {
    for (const until = Date.now() + 10_000; !lock && Date.now() < until;) {
      signal?.throwIfAborted();
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
  let retention: ReturnType<typeof followEngine> = null;
  try {
    signal?.throwIfAborted();
    requireCurrentEngine(engine);
    retention = followEngine(log, true);
    if (!retention)
      throw new ClaimUnavailableError('could not retain the attached Stim engine', {
        claimPath: join(engine.root, 'claims', engine.build),
      });
    retention.record(true, workspaceEngineDirs(loadConfig()));
    return retention;
  } catch (error) {
    retention?.release();
    cleanup();
    if (isClaimRefusal(error) || isClaimUnavailable(error)) Object.assign(error, { retentionFailure: true });
    throw error;
  } finally {
    await lock.release();
  }
}

interface StimdStartup {
  cleanup?: (error: unknown) => Promise<void>;
  signal: AbortSignal;
  finish?: () => void;
}

interface RunStimdOptions {
  tickMs?: number;
  /** The tick interval while nothing runs in the home and the pressure level is normal: 5 minutes. */
  slowTickMs?: number;
  /** How often a detached stimd checks that its `run/` directory still exists: 15 seconds, and it stops after two misses. */
  homeWatchMs?: number;
  /** The mode the starting command resolved; a later `daemon.mode` change in config can only make it stricter. */
  mode?: DaemonMode;
  /** Starts the net thread at boot with these options, for `stim serve` and a service unit. */
  serve?: ServeOptions;
  /** The Desktop key to write to `run/desktop.key` instead of a new one: the key a Stim Desktop gave on stdin. */
  desktopKey?: string;
  /** Gets the net thread's first answer to `serve`. */
  onNet?: (answer: Awaited<ReturnType<ReturnType<typeof createNetThread>['ensure']>>) => void;
  /** Whether a service unit or `stim serve` runs this stimd, which turns `engine.autoUpdate`'s `auto` on. */
  service?: boolean;
  /**
   * Bound to the process that started it (`hostStimd`): it neither follows the engine nor exits idle or under
   * `daemon.mode` off, and ends when its stdin closes or on a signal, through `endAttached`.
   */
  attached?: { handover: boolean };
}

/**
 * One resident stimd per Stim home, which returns false when another holds the home: holds the claim at `run/stimd` exclusively and the daemon claim at `daemon/claim`
 * shared, which a stim-daemon from Stim 1.40 to 1.42 holding it exclusively refuses; serves the CLI socket,
 * whose address it writes to `run/stimd.json`; and ticks every minute while something runs in the home or the pressure
 * level is above normal, every 5 minutes otherwise, and on demand, each tick measuring once, running the activity,
 * dormant and pressure passes and writing `snapshot.json`, then, unless it exits, starting the slow passes on the passes
 * thread unless the last ones still run. A command's contact brings it back to the minute. It exits after two ticks in a
 * row with nothing running, no work pending (`pendingWork`), no slow pass running and no contact, when `daemon.mode`
 * turns off, or when a tick throws, releasing its claims so each supervisor's own idle timer takes over. A tick that
 * cannot verify a child's cleanup does not end it: stimd logs `daemon_cleanup_unverified`, stays up and checks the child
 * again each tick, and releases the claims that child held once it has stopped. During shutdown it cancels the
 * dependency size scan and waits for its cleanup and for any slow pass already running.
 */
export async function runStimd(options: RunStimdOptions = {}): Promise<boolean> {
  const controller = new AbortController();
  const startup: StimdStartup = { signal: controller.signal };
  if (options.attached) {
    const abort = () => controller.abort();
    process.stdin.once('end', abort).once('error', abort);
    process.stdin.resume();
    startup.finish = () => process.stdin.off('end', abort).off('error', abort);
  }
  try {
    return await runStimdInner(options, startup);
  } catch (error) {
    await startup.cleanup?.(error);
    throw error;
  } finally {
    startup.finish?.();
  }
}

async function runStimdInner(
  {
    tickMs = TICK_MS,
    slowTickMs = tickMs * SLOW_TICKS,
    homeWatchMs = HOME_WATCH_MS,
    mode: startMode = daemonMode({}),
    serve,
    desktopKey,
    onNet,
    service = serve !== undefined,
    attached,
  }: RunStimdOptions,
  startup: StimdStartup,
): Promise<boolean> {
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
  refuseUnresolvedDaemonClaims(writer);
  let own = await takeClaim(stimdClaimRoot(), 'exclusive', 'stimd', details, lifetime.retries(CLAIM_TRIES));
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
  let keepOwn = false;
  let startupClaim: ClaimHandle | null = null;
  let startupFollower: ReturnType<typeof followEngine> = null;
  let startupRetention: ReturnType<typeof followEngine> = null;
  startup.cleanup = async (error) => {
    startupRetention?.release();
    startupFollower?.release();
    if (isUnverifiedCleanup(error)) keepOwn = true;
    else {
      releaseClaim(startupClaim);
      releaseClaim(own);
    }
    markAbnormal = null;
    await writer.close();
  };
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
        launchStimd(
          process.env,
          startMode,
          process.platform,
          join(store.root, current.dir, 'dist', 'cli.mjs'),
          serveArgs(serve ?? null, service),
        );
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
  startup.signal.throwIfAborted();
  const claim = await takeClaim(daemonClaimRoot(), 'shared', 'stimd', details);
  startupClaim = claim;
  startup.signal.throwIfAborted();
  if (!claim) {
    releaseClaim(own);
    log('warn', 'stimd_claim_held', daemonClaimRefusal());
    writer.close();
    return false;
  }
  let keepDaemon = false;
  readoptJournal(log);
  const follower = lifetime.detachedOnly(() => followEngine(log));
  startupFollower = follower;
  follower?.record(false, workspaceEngineDirs(loadConfig()));
  const retention = await retainAttachedEngine(
    attached !== undefined,
    log,
    () => {
      releaseClaim(claim);
      releaseClaim(own);
      writer.close();
    },
    startup.signal,
  );
  startupRetention = retention;
  startup.signal.throwIfAborted();
  process.title = 'stimd';
  const key = writeDesktopKey(desktopKey);
  const script = realpathSync(process.argv[1] ?? '');
  const net = createNetThread(
    log,
    (failure) => {
      lastContact = Date.now();
      if (failure) {
        failBackground(failure, 'net cleanup could not be verified');
        return;
      }
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
  const logs = createStreams((message) => log('warn', 'device_logs', message), log);
  const threads = createThreadTable(log);
  let backgroundFailure: unknown;
  const cleanups = createCleanupWatch(log);
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
  const logsRunning = () => logs.running() || logs.ownedRunning();
  const hasOffWork = () =>
    Boolean(
      cleanups.pending() ||
      logs.running() ||
      logs.ownedRunning() ||
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
  let relaunchDone: Promise<void> | undefined;
  let handingOver = false;
  const foregroundAbort = new AbortController();
  let foregroundDone: Promise<void> | undefined;
  let foregroundFailure: unknown;
  let admissionRevision = 0;
  let sealed = false;
  let attachedWatchdog: NodeJS.Timeout | undefined;
  const maintenanceAllowed = () => !closing && !ending;
  const endingNow = () => attached !== undefined || !maintenanceAllowed();
  let engineDirs: string[] = [];
  try {
    if (follower) engineDirs = workspaceEngineDirs(loadConfig());
  } catch {}
  let netServes: ServeOptions | null = serve ?? null;
  let switchedTo: { build: string; version: string } | null = null;
  let updatedInPlace: { build: string; version: string } | null = null;
  const checkedClients = new Map<string, string>();
  const noteClientBuild = (client: unknown) => {
    if (follower || attached || service || updatedInPlace || typeof client !== 'string') return;
    const stamp = distStamp();
    if (checkedClients.get(client) === stamp) return;
    checkedClients.set(client, stamp);
    const now = installedNow();
    if (now?.build !== client) return;
    updatedInPlace = now;
    log(
      'info',
      'stimd_install_updated',
      `this stimd's installation now holds ${now.version} (${now.build}); restarting on it once the commands it serves end`,
    );
  };
  let heldSwitch = false;
  const hasActiveCommands = () => ops.size > 0;
  const pinned = (): boolean =>
    Boolean(backgroundFailure) ||
    cleanups.pending() ||
    metroCleanupPending() ||
    metroRootsEndingWithStimd().length > 0 ||
    [...ops.values()].includes('pinned') ||
    listBuildSlots().some((slot) => slot.alive && slot.client !== null) ||
    (net.running() !== null && readHostedSessions().some(hostedNativeWork));
  const enginePinned = (): boolean => pinned() || logs.holdsRelaunch();
  const failBackground = (error: unknown, why: string) => {
    backgroundFailure = error;
    keepOwn = true;
    keepDaemon = true;
    (retention ?? follower)?.record(true, [...engineDirs, ...metroEngineDirs()]);
    if (attached) requestEnd(why, 'error');
    else shutdown(why, 'error');
  };
  const refuseClient = (socket: Socket, message: Record<string, unknown>) => {
    if (message.kind !== 'desktop') noteClientBuild(message.build);
    const handover =
      updatedInPlace?.build === message.build
        ? {
            handover: true,
            ...(logs.holdsRelaunch()
              ? { heldBy: 'logs', workspaces: logs.heldRoots() }
              : net.running()?.shareOnly
                ? { heldBy: 'shares' }
                : metroRootsEndingWithStimd().length > 0
                  ? { heldBy: 'dev-servers', workspaces: metroRootsEndingWithStimd() }
                  : {}),
          }
        : {};
    socket.end(
      `${JSON.stringify({ op: 'engine-changed', build, ...lifetime.refusal, pid: process.pid, ...handover, ...switchedTo })}\n`,
    );
    void checkEngine();
  };
  const checkEngine = async (): Promise<void> => {
    if (
      !follower &&
      updatedInPlace &&
      !switchedTo &&
      !closing &&
      !hasActiveCommands() &&
      !enginePinned() &&
      !net.running()?.shareOnly
    ) {
      relaunchDone = relaunch(updatedInPlace, spawnEntry('cli'));
      void relaunchDone.catch(() => {});
    }
    if (!follower || switchedTo || closing) return;
    let next: Awaited<ReturnType<typeof follower.check>>;
    try {
      follower.record(enginePinned(), [...engineDirs, ...metroEngineDirs()], logs.holdsRelaunch());
      next = await follower.check(enginePinned);
    } catch (error) {
      log('warn', 'engine_check_failed', error instanceof Error ? error.message : String(error));
      return;
    }
    if (!next || switchedTo || closing) return;
    if (!enginePinned()) {
      relaunchDone = relaunch(next, join(follower.engine.root, next.build, 'dist', 'cli.mjs'));
      void relaunchDone.catch(() => {});
    } else if (!heldSwitch) {
      heldSwitch = true;
      log(
        'warn',
        'engine_switch_pinned',
        `the engine switched to ${next.version} under pinned work; relaunching after it`,
      );
    }
  };
  const relaunch = async (next: { build: string; version: string }, entry: string) => {
    switchedTo = next;
    const changed = `${JSON.stringify({ op: 'engine-changed', ...next, pid: process.pid })}\n`;
    for (const list of [waiters.build, waiters.boot, tickReplies]) list.length = 0;
    for (const socket of open) socket.end(changed);
    const running = net.running();
    const carried = running && netServes ? { ...netServes, shareOnly: running.shareOnly } : null;
    const why = `the engine switched to ${next.version} (${next.build})`;
    handingOver = true;
    shutdown(why);
    await shutdownDone;
    if (keepOwn) return;
    launchStimd(process.env, startMode, process.platform, entry, serveArgs(carried, service));
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
    // eslint-disable-next-line complexity -- this handler dispatches the existing daemon operations.
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
            refuseClient(socket, message);
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
          void answer.then(
            (state) => {
              lastContact = Date.now();
              return reply({ op: 'net', ...state });
            },
            (error: unknown) => reply({ op: 'net', listening: false, message: String(error) }),
          );
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
        } else if (op === 'logs.observe' || op === 'logs.observe-web' || op === 'logs.drain') {
          const root = isJsonObject(message.params) ? message.params.root : undefined;
          const params = isJsonObject(message.params) ? message.params : {};
          if (
            typeof root !== 'string' ||
            (op === 'logs.observe-web' &&
              (typeof params.pid !== 'number' ||
                !Number.isSafeInteger(params.pid) ||
                params.pid <= 0 ||
                typeof params.token !== 'string'))
          )
            socket.destroy();
          else {
            const request =
              op === 'logs.observe'
                ? logs.ownedSync(root)
                : op === 'logs.observe-web'
                  ? logs.ownedObserveWeb(root, params.pid as number, params.token as string)
                  : logs.ownedDrain(root);
            void request.then((error) =>
              socket.end(
                `${JSON.stringify({ op: op === 'logs.observe' ? 'logs.observed' : op === 'logs.observe-web' ? 'logs.web-observed' : 'logs.drained', error })}\n`,
              ),
            );
          }
        } else if (op === 'metro.ensure' || op === 'tunnel.ensure' || op === 'metro.stop') {
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
              : op === 'metro.stop'
                ? stopManagedMetro(message.params, log)
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
  const closeNetAndLogs = createNetAndLogsClose(net, logs, () => handingOver);
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
        if (isUnverifiedCleanup(error)) {
          keepOwn = true;
          keepDaemon = true;
        }
        shutdown('attached cleanup could not be verified', 'error');
        await shutdownDone;
        throw isUnverifiedCleanup(error) ? Object.assign(error, { retentionFailure: true }) : error;
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
          : logs.ownedRunning()
            ? 'owned app logs are being observed'
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
    retention?.record(true, [...workspaceEngineDirs(loadConfig()), ...metroEngineDirs()]);
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
  const shutdown = (why: string, level: Level = 'info') => {
    if (closing) return;
    closing = true;
    foregroundAbort.abort();
    markDaemonFailure(level, attached !== undefined, markAbnormal);
    if (dependencyWork) log('debug', 'daemon_dependency_scan_cancelled', 'stopping the dependency size scan');
    threads.abort('passes');
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
    shutdownDone = Promise.allSettled([
      waitForeground(foregroundDone, () => foregroundFailure),
      lane.settled(),
      dependencyWork,
      closeMetroChildren(),
      closeNetAndLogs(),
    ])
      .then(async (results) => {
        cleanups.settle();
        const unverified = [
          backgroundFailure,
          ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
          ...cleanups.errors(),
        ].some(isUnverifiedCleanup);
        if (unverified) {
          keepOwn = true;
          keepDaemon = true;
        }
        await threads.close();
        return undefined;
      })
      .catch(() => {})
      .then(() => {
        follower?.release();
        if (!keepDaemon) releaseClaim(claim);
        if (!keepOwn) releaseClaim(own);
        markAbnormal = null;
        retention?.release();
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
  startup.cleanup = async (error) => {
    if (isUnverifiedCleanup(error)) backgroundFailure = error;
    shutdown('daemon startup failed', lifetime.failLevel);
    await shutdownDone;
    await writerDone;
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    await listen(path, server);
    bound = true;
    startup.signal.throwIfAborted();
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
    if (cleanups.contain(error, endingNow())) return true;
    failBackground(error, 'Metro cleanup could not be verified');
    log('error', 'metro_cleanup_unverified', error instanceof Error ? error.message : String(error));
    return false;
  });
  adoptMetroChildren(log);
  resumeLogStreams(logs, log, attached !== undefined);
  (retention ?? follower)?.record(Boolean(retention), [...workspaceEngineDirs(loadConfig()), ...metroEngineDirs()]);
  if (serve) void net.ensure(netOptions(serve)).then((answer) => onNet?.(answer));
  startup.signal.throwIfAborted();
  await logs.ownedSync();
  startup.signal.throwIfAborted();
  lifetime.serve(requestEnd, waitMs, instance);
  startup.finish?.();
  startup.finish = undefined;
  startup.cleanup = undefined;
  log(
    'info',
    'daemon_started',
    `pid ${process.pid} listening on ${path} after ${Math.round(performance.now() - started)}ms`,
    { build, version: identity.version },
  );
  let emptyTicks = 0;
  let interval = tickMs;
  const kept = new Map<string, string>();
  const syncOwned = () => {
    if (!closing) void logs.ownedSync();
  };
  let runDirMisses = 0;
  const homeWatch = attached
    ? undefined
    : setInterval(() => {
        runDirMisses = runDirRemoved(stimdRunDir()) ? runDirMisses + 1 : 0;
        if (!closing && runDirMisses >= HOME_WATCH_MISSES) shutdown('its run directory was removed');
      }, homeWatchMs);
  homeWatch?.unref();
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
    cleanups.settle();
    const mode = effectiveMode();
    const retentionError = refreshRetention(retention);
    if (retentionError) {
      shutdown(`the attached engine claim failed: ${retentionError}`, 'error');
      break;
    }
    void metroTick(mode, log).catch((error: unknown) => log('warn', 'metro_tick_failed', String(error)));
    if (mode === 'off') {
      await logs.ownedSync();
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
      syncOwned();
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
            : homeAlive(config, measured, hasActiveCommands(), cleanups.reason());
      pending = alive
        ? null
        : maintaining
          ? 'automatic maintenance runs'
          : updating
            ? 'an engine update check runs'
            : await pendingWork(config, measured, slowTickMs, mode === 'on', operation);
      wentDormant = actions.some((action) => action.kind === 'dormant-stage' && action.outcome === 'done');
      interval = alive || pressure.level !== 'normal' ? tickMs : slowTickMs;
      logKeptWorkspaces(kept, workspaces, log);
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
      await checkEngine();
      maybeUpdate('daily check', DAILY_MS);
    } catch (error) {
      for (const socket of replying) socket.destroy();
      if (cleanups.contain(error, endingNow())) {
        interval = tickMs;
        continue;
      }
      foregroundFailure = handleForegroundError(error, ending, attached !== undefined, requestEnd, shutdown);
      break;
    } finally {
      settleForeground();
    }
    if (!maintenanceAllowed()) break;
    const idle = !alive && !pending && !wentDormant && Date.now() - contactSince >= tickMs;
    emptyTicks = countIdleTicks(idle, logsRunning(), emptyTicks);
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
    await relaunchDone;
    await writerDone;
    clearInterval(homeWatch);
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
      service: serve !== undefined && !argv.includes('--carried'),
      ...(argv.includes(ATTACHED_ARG) ? { attached: { handover: !argv.includes(NO_HANDOVER_ARG) } } : {}),
    });
    if (serve && !served && stimdLive()) await serveThroughStimd(serve, reportNet);
  } catch (error) {
    const message =
      isClaimRefusal(error) || isClaimUnavailable(error)
        ? `${error.message}${'remedy' in error && typeof error.remedy === 'string' ? ` ${error.remedy}` : ''}`
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
