import { withInvocation, type Invocation } from '../forwarded.ts';
import { closeSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  DEV_SERVER_STOP_REQUEST_KEY,
  DEVICE_METRO_IDLE_STOP_REASON,
  IDLE_STOP_KEY,
  isJsonObject,
  readDevServerStopRequest,
  TUNNEL_MODES,
  type DaemonMode,
  readJsonObject,
  type DevServerStopRecord,
} from '@stim-cli/core/state';
import {
  markClaimChildPending,
  claimRemoveCommand,
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  updateClaimDetails,
  type ClaimHandle,
  type ClaimHolder,
} from '@stim-cli/core/ownership-claim';
import { getExecutor } from '../../exec.ts';
import {
  pidExists,
  recordForeignMetro,
  resolveProjectMetro,
  signalProcessTree,
  signalProcessTreeAsync,
} from '../../metro.ts';
import { createNdjsonWriter, type NdjsonRecord, type NdjsonWriter } from '../../ndjson.ts';
import { isMetroRunning } from '../../ports.ts';
import { inspectProcessIdentity } from '../../process-identity.ts';
import { resolveMetroSharedCache } from '../../optimizations.ts';
import { clearSupervisor, loadConfig, setSupervisor } from '../../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../../workspace/paths.ts';
import { detectIsExpo } from '../../workspace/project.ts';
import {
  idleMinutesSetting,
  metroPortSetting,
  resolveProjectSettings,
  runnableMetroCommand,
} from '../../workspace/settings.ts';
import {
  clearWorkspaceStateKeys,
  readWorkspaceState,
  withWorkspaceStateLock,
  writeWorkspaceState,
} from '../../workspace/workspace-state.ts';
import { shutDownIdleDevices } from '../../devices/idle-shutdown.ts';
import { workspaceDeviceLastUseAt } from '../../devices/activity.ts';
import { withIdleWorkspace } from '../../workspace/in-use.ts';
import { liveShareKeepReason } from '../../local-server.ts';
import { detectProviders, planMetroReach, PUBLIC_METRO_ENV } from '../../engine/metro-reach.ts';
import { ownStoreEngine } from '../../daemon/engine-switch.ts';
import type { ManagedProvider } from '../../engine/metro-reach.ts';
import { metroRequestAt } from '../passes/idle-stop.ts';
import {
  childRecords,
  openChildOutput,
  superviseChildServer,
  tailChildOutput,
  type ChildOutput,
  type ChildServerHandle,
  type OutputTail,
} from './child-server.ts';
import { workspaceIdleProbe } from './idle-stop.ts';
import { watchHostedMetro } from './hosted-metro.ts';
import { devServerStopLevel, devServerStopRecord, describeDevServerStop } from './stop-cause.ts';
import { trackMetroWatchRoots, type MetroWatchRoots, type MetroWatchState } from './watchman-roots.ts';
import { injectedDigest, injectedDir } from './injected.ts';
import { metroStoreRoot, registerMetroStore } from './metro-store.ts';
import { projectNodeLine, withProjectNode } from './project-node.ts';
import { startCommandServer } from './server-command.ts';
import { recordFromLine, repositoryRoot, startExpoServer } from './server-expo.ts';
import {
  clearExpoMetroTunnel,
  clearManagedMetroTunnel,
  clearWorkspaceSupervisor,
  MODE_BARE,
  MODE_COMMAND,
  MODE_EXPO,
  readMetroTunnel,
  type ManagedTunnelRecord,
} from './state.ts';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;
type Answer = Record<string, unknown>;

const HEARTBEAT_FRESH_MS = 3000;
const PROBE_MS = 500;
const READY_MS = 120_000;
const STOP_MS = 5000;
const SUCCESSOR_WAIT_MS = 10_000;
const IDLE_POINT_MS = 2 * 60_000;
const GROUPS = process.platform !== 'win32';

/** How a workspace's Metro starts, kept in its claim so that a restart or an adopting stimd starts it the same way. */
interface Launch {
  /** Expo's own tunnel (`expo start --tunnel`). */
  tunnel: boolean;
  /** The managed tunnel's origin, which Metro and Expo put in the URLs they serve. */
  publicOrigin: string | null;
}

interface MetroChild {
  root: string;
  launch: Launch;
  port: number;
  mode: string;
  digest: string | null;
  pid: number;
  processToken: string;
  startedAt: string;
  claim: ClaimHandle;
  writer: NdjsonWriter;
  /** The handle of a child this stimd spawned; null for one it adopted from an earlier stimd. */
  handle: ChildServerHandle | null;
  tail: OutputTail | null;
  /** Whether it answered once, after which a fresh heartbeat alone proves it runs. */
  ready: boolean;
  /** When an ensure last answered with it, which an idle stop decided earlier does not override. */
  ensuredAt: number;
  gone: boolean;
  stopping?: boolean;
  /** Ends the wait for the child's first answer, which a stop does before it queues. */
  readiness?: AbortController;
  /** Closes the hosted Metro links this child serves. */
  closeLinks: (() => Promise<void>) | null;
  roots: MetroWatchRoots | null;
  /** Whether its Metro requests reach `metro.ndjson`, without which no idle stop can tell it is unused. */
  observesRequests: boolean;
  /** Whether a stop could not verify that its process group exited. */
  unverified?: boolean;
}

interface TunnelChild {
  claim: ClaimHandle;
  pid: number;
  processToken: string;
  url: string;
  startedAt: string;
}

const invocations = new Map<string, Invocation & { workspace: string }>();

export function setMetroInvocation(root: string, context: Invocation & { workspace: string }): void {
  try {
    invocations.set(realpathSync(root), context);
  } catch {}
}

const children = new Map<string, MetroChild>();
const tunnels = new Map<string, TunnelChild>();
const busy = new Map<string, Promise<Answer>>();
const queued = new Map<string, number>();
let backgroundStopped = false;
let closingChildren = false;
let tickWork: Promise<void> | null = null;
let closeWork: Promise<void> | null = null;
let cleanupFailure: unknown;
let onCleanupFailure: ((error: unknown) => boolean) | undefined;

/**
 * Starts supervising. `onFailure` hears of a child whose cleanup could not be verified; when it answers true, stimd goes
 * on, the child's claim keeps guarding its workspace, and the next stop or tick checks that child again.
 */
export function openMetroChildren(onFailure?: (error: unknown) => boolean): void {
  backgroundStopped = false;
  closingChildren = false;
  closeWork = null;
  cleanupFailure = undefined;
  onCleanupFailure = onFailure;
}

export function metroCleanupPending(): boolean {
  return cleanupFailure !== undefined;
}

export function metroEngineDirs(): string[] {
  return [...children.values()].flatMap((child) =>
    typeof child.claim.details.engineDir === 'string' ? [child.claim.details.engineDir] : [],
  );
}

function failedCleanup(error: unknown): void {
  if (cleanupFailure !== undefined) return;
  cleanupFailure = error;
  if (onCleanupFailure?.(error) === true) cleanupFailure = undefined;
}

export function stopMetroTicks(): void {
  backgroundStopped = true;
}

const claimRoot = (root: string, kind: 'metro' | 'tunnel') => join(workspaceDir(root), `${kind}.claim`);
const heartbeatFile = (root: string) => join(workspaceDir(root), 'metro.heartbeat');
const outputFiles = (root: string): ChildOutput => ({
  stdout: join(workspaceLogsDir(root), 'metro.stdout.log'),
  stderr: join(workspaceLogsDir(root), 'metro.stderr.log'),
});

/** The child's `metro.ndjson` writer, which stamps its records with the child's injected digest. */
function metroWriter(root: string, digest: string | null): NdjsonWriter {
  // compat C6 permanent
  const fields = digest ? { inj: digest } : {};
  // compat end
  return createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES, fields });
}

function heartbeatFresh(child: MetroChild, now = Date.now()): boolean {
  if (child.mode === MODE_COMMAND) return false;
  const beat = readJsonObject(heartbeatFile(child.root));
  return (
    child.ready &&
    beat !== null &&
    beat.pid === child.pid &&
    beat.port === child.port &&
    now - Number(beat.at) < HEARTBEAT_FRESH_MS
  );
}

/** Whether the child still runs: its handle's exit state when this stimd spawned it, its identity when adopted. */
function running(child: MetroChild): boolean {
  if (child.gone) return false;
  if (child.handle) return child.handle.child.exitCode === null && child.handle.child.signalCode === null;
  return inspectProcessIdentity(child) === 'same';
}

function answer(child: MetroChild, state = 'running'): Answer {
  const own = injectedDigest();
  return {
    op: 'metro',
    state,
    pid: child.pid,
    port: child.port,
    mode: child.mode,
    // compat C6 permanent
    ...(child.digest !== own ? { foreign: true } : {}),
    // compat end
  };
}

function lastLine(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').at(-1)?.trim() ?? '';
  } catch {
    return '';
  }
}

function launchOf(details: Record<string, unknown>): Launch {
  return {
    tunnel: details.tunnel === true,
    publicOrigin: typeof details.publicOrigin === 'string' ? details.publicOrigin : null,
  };
}

/** The stop a command asked for with `requestDevServerStop`, else what `trigger` says, or null for neither. */
function stopRecord(
  child: MetroChild,
  trigger: Parameters<typeof devServerStopRecord>[0] | null,
): DevServerStopRecord | null {
  const request = readDevServerStopRequest(readWorkspaceState(child.root));
  const own = request?.processToken === child.processToken ? request : null;
  return own || trigger
    ? devServerStopRecord(trigger ?? { kind: 'signal', signal: 'SIGTERM' }, own, new Date().toISOString())
    : null;
}

/** Forgets a child that exited or was stopped: its record, its claim, its tail and its hosted links. */
function forget(
  child: MetroChild,
  msg: string,
  level: 'info' | 'warn' | 'error' = 'info',
  stop: DevServerStopRecord | null = null,
  roots: MetroWatchRoots | null = null,
): void {
  if (child.gone) return;
  child.gone = true;
  child.tail?.stop();
  void child.closeLinks?.();
  if (children.get(child.root) === child) children.delete(child.root);
  const identity = { pid: child.pid, processToken: child.processToken };
  try {
    withWorkspaceStateLock(child.root, () => {
      if (stop) writeWorkspaceState(child.root, { [IDLE_STOP_KEY]: stop });
      clearWorkspaceStateKeys(child.root, [DEV_SERVER_STOP_REQUEST_KEY]);
    });
  } catch {}
  try {
    clearWorkspaceSupervisor(child.root, identity);
    clearSupervisor(child.root, identity);
  } catch {}
  rmSync(heartbeatFile(child.root), { force: true });
  releaseClaim(child.claim);
  child.writer.write({ src: 'metro', level, event: 'supervisor_stopped', msg, ...(stop ? { stop } : {}) });
  if (!roots) {
    child.writer.close();
    return;
  }
  void roots
    .beforeClose()
    .then(() => roots.afterClose())
    .finally(() => child.writer.close());
}

/** Keeps what the child's watch root tracker knows in its claim, where a stimd that adopts the child reads it. */
function saveWatch(child: MetroChild, watch: MetroWatchState): void {
  if (child.gone) return;
  try {
    child.claim = updateClaimDetails(child.claim, { ...child.claim.details, watch }) ?? child.claim;
  } catch {}
}

const strings = (list: unknown) =>
  Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : null;

function watchOf(value: unknown): MetroWatchState {
  return isJsonObject(value)
    ? { before: strings(value.before), owned: strings(value.owned) ?? [] }
    : { before: null, owned: [] };
}

/** Forgets a child whose process tree exited without a stop from this stimd, with the cause it can name. */
function forgetExited(child: MetroChild, code: number | null, signal: string | null): void {
  const stop = stopRecord(child, { kind: 'server-exit', mode: child.mode, code, signal });
  forget(
    child,
    stop?.reason === 'requested'
      ? `the ${child.mode} dev server exited; ${describeDevServerStop(stop)}`
      : `${stop ? describeDevServerStop(stop) : `the ${child.mode} dev server exited`} (pid ${child.pid})`,
    stop ? devServerStopLevel(stop) : 'warn',
    stop,
    child.roots,
  );
}

/**
 * Settles a child that exited without a stop from this stimd. Windows has no process groups, and `taskkill /T` reaches
 * only a live tree: there the exit of a node this stimd spawned is its whole tree, but a `metro.command` wrapper such as
 * cmd or yarn can leave Metro running as an orphan, so its claim stays unresolved.
 */
function settleExited(child: MetroChild, code: number | null, signal: string | null): void {
  if (!GROUPS && child.mode === MODE_COMMAND)
    failedCleanup(unverifiedChild(child.claim, child, `Could not confirm the dev-server tree exited.`));
  else forgetExited(child, code, signal);
}

async function gone(alive: () => boolean, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; alive() && Date.now() < deadline;)
    await new Promise((done) => setTimeout(done, 50));
  return !alive();
}

/**
 * Where children lead their own process group and the child's identity is known, its claim keeps that child: it stays
 * held while any member of the group runs and frees once none does. Otherwise it records an unknown child.
 */
function unverifiedChild(
  claim: ClaimHandle,
  child: { pid: number; processToken?: string | null },
  reason: string,
): Error {
  const { pid, processToken } = child;
  const known = GROUPS && pid > 0 && processToken ? { pid, processToken } : null;
  if (known) setClaimChild(claim, known);
  else markClaimChildPending(claim);
  return Object.assign(new Error(`${reason} Claim remains at ${claim.path}.`), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    remedy: `Verify ${pid ? `pid ${pid} and its descendants have` : 'the dev-server process tree has'} stopped, then run ${claimRemoveCommand(claim.path)}.`,
    reportCleanup: true,
    ...(known ? { reportChild: known } : {}),
  });
}

async function stopChild(child: MetroChild, why: string): Promise<void> {
  if (child.stopping && cleanupFailure) throw cleanupFailure;
  child.stopping = true;
  await child.roots?.beforeClose();
  try {
    if (!GROUPS) {
      if (
        inspectProcessIdentity(child) !== 'same' ||
        !(await signalProcessTreeAsync(child.pid, 'SIGKILL', { platform: 'win32' }))
      )
        throw new Error(`Could not confirm shutdown of dev-server pid ${child.pid}.`);
      if (!(await gone(() => running(child), STOP_MS)))
        throw new Error(`Could not confirm shutdown of dev-server pid ${child.pid}.`);
    } else if (child.handle) await child.handle.close();
    else if (processGroupAlive(child.pid)) {
      const signal = (sig: NodeJS.Signals) => {
        if (inspectProcessIdentity(child) !== 'same')
          throw new Error(`Could not verify the dev-server process group for pid ${child.pid}.`);
        try {
          signalProcessTree(child.pid, sig, { group: true });
        } catch {}
      };
      signal('SIGTERM');
      if (!(await gone(() => processGroupAlive(child.pid), STOP_MS))) {
        signal('SIGKILL');
        if (!(await gone(() => processGroupAlive(child.pid), 1000)))
          throw new Error(`Could not confirm shutdown of dev-server pid ${child.pid}.`);
      }
    }
  } catch (error) {
    child.unverified = true;
    throw unverifiedChild(child.claim, child, error instanceof Error ? error.message : String(error));
  }
  await child.roots?.afterClose();
  const stop = stopRecord(child, null);
  forget(
    child,
    `stimd stopped the ${child.mode} dev server: ${stop ? describeDevServerStop(stop) : why}`,
    'info',
    stop,
  );
}

/** Runs `work` after every earlier piece of work on `key`, so no two ensure, restart or stop of one child overlap. */
function serialize(key: string, work: () => Promise<Answer>): Promise<Answer> {
  if (closingChildren) return Promise.resolve({ op: 'error', code: 'metro', message: 'The Stim daemon is ending.' });
  queued.set(key, (queued.get(key) ?? 0) + 1);
  const run = (busy.get(key) ?? Promise.resolve({}))
    .catch(() => ({}))
    .then(work)
    .catch((error: unknown) => {
      if (error instanceof Error && 'reportCleanup' in error) failedCleanup(error);
      return {
        op: 'error',
        code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'metro',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
          ? { remedy: error.remedy }
          : {}),
      };
    });
  busy.set(key, run);
  void run.finally(() => {
    if (busy.get(key) === run) busy.delete(key);
    const left = (queued.get(key) ?? 1) - 1;
    if (left > 0) queued.set(key, left);
    else queued.delete(key);
  });
  return run;
}

/**
 * Whether a stimd's Metro claim for `root` names `pid` as its child: one this stimd runs, one an exiting stimd still
 * holds, or, except on Windows where nothing is adopted, one a successor has yet to adopt.
 */
export function stimdRunsMetro(root: string, pid: number): boolean {
  return (
    children.get(root)?.pid === pid ||
    readClaimSet(claimRoot(root, 'metro')).live.some(
      (holder) => holder.child?.pid === pid && (GROUPS || inspectProcessIdentity(holder.owner) === 'same'),
    )
  );
}

/** Records a running child where `status`, `stop`, the idle stage, Desktop and `machine-usage` look for a dev server. */
function record(child: MetroChild, hmrUpdates: boolean): void {
  const entry = {
    pid: child.pid,
    processToken: child.processToken,
    port: child.port,
    mode: child.mode,
    startedAt: child.startedAt,
    ...(typeof child.claim.details.engineDir === 'string' ? { engineDir: child.claim.details.engineDir } : {}),
    ...(hmrUpdates ? { hmrUpdates } : {}),
  };
  writeWorkspaceState(child.root, { supervisor: entry });
  clearWorkspaceStateKeys(child.root, [IDLE_STOP_KEY]);
  setSupervisor(child.root, entry);
}

/** How a child's output lines become records: as the dev server of its mode writes them. */
function outputRecord(mode: string): (chunk: unknown, stream: 'stdout' | 'stderr') => NdjsonRecord | null {
  if (mode === MODE_COMMAND) return (chunk, stream) => recordFromLine(chunk, { stream, source: 'command' });
  if (mode === MODE_EXPO) return (chunk, stream) => recordFromLine(chunk, { stream });
  return (chunk, stream) => {
    const entry = recordFromLine(chunk, { stream });
    return entry?.raw ? { ...entry, event: `host_${stream}` } : entry;
  };
}

function spawnHost(
  root: string,
  port: number,
  output: { files: ChildOutput; fds: [number, number] },
  env: Record<string, string>,
  writer: NdjsonWriter,
  baseEnv: NodeJS.ProcessEnv,
  spawn: ReturnType<typeof getExecutor>['spawn'],
  resetCache: boolean,
): ChildServerHandle {
  const settings = resolveProjectSettings(root).settings;
  const storeRoot = resolveMetroSharedCache(settings) ? metroStoreRoot(root) : null;
  if (storeRoot) registerMetroStore(storeRoot);
  const node = withProjectNode(root, baseEnv, { top: repositoryRoot(root) ?? root });
  if (node.pinned)
    writer.write({
      src: 'metro',
      level: 'info',
      event: 'project_node',
      msg: `Metro runs on ${projectNodeLine(node.pinned)}`,
    });
  const args = [
    join(injectedDir() ?? '', 'metro-host.cjs'),
    '--root',
    root,
    '--port',
    String(port),
    '--logs-dir',
    workspaceLogsDir(root),
    '--heartbeat',
    heartbeatFile(root),
    ...(storeRoot ? ['--store-root', storeRoot] : []),
    ...(resetCache ? ['--reset-cache'] : []),
  ];
  const child = spawn('node', args, {
    cwd: root,
    stdio: ['ignore', ...output.fds],
    detached: GROUPS,
    env: { ...node.env, FORCE_COLOR: '0', ...env },
  });
  return superviseChildServer({
    mode: MODE_BARE,
    child,
    log: writer,
    toRecord: outputRecord(MODE_BARE),
    signal: (sig) => {
      try {
        return child.pid !== undefined && signalProcessTree(child.pid, sig, { group: GROUPS });
      } catch {
        return false;
      }
    },
    alive: GROUPS ? () => child.pid !== undefined && processGroupAlive(child.pid) : null,
    killTimeoutMs: STOP_MS,
    output: output.files,
  });
}

/** Opens the hosted Metro links (`device-host.metro.link`, reverse ports, agent relay) this workspace's sessions ask for. */
function serveLinks(child: MetroChild, log: Log): void {
  try {
    child.closeLinks = watchHostedMetro(child.root, child.port, child.processToken, (msg) =>
      child.writer.write({ src: 'metro', level: 'warn', event: 'hosted_metro_link_failed', msg }),
    );
  } catch (error) {
    log('warn', 'metro_links_failed', `${child.root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function start(
  root: string,
  port: number,
  log: Log,
  operationEnv: NodeJS.ProcessEnv | undefined,
  launch: Launch,
  resetCache: boolean,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  ensureWorkspaceStorage(root);
  const logsDir = workspaceLogsDir(root);
  mkdirSync(logsDir, { recursive: true });
  const settings = resolveProjectSettings(root).settings;
  const command = runnableMetroCommand(settings);
  const mode = command ? MODE_COMMAND : detectIsExpo(root) ? MODE_EXPO : MODE_BARE;
  const digest = injectedDigest();
  const details = { port, mode, digest, engineDir: ownStoreEngine()?.build ?? null, ...launch };
  const attempt = tryAcquireClaim({ root: claimRoot(root, 'metro'), mode: 'exclusive', label: 'Metro', details });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    return { op: 'error', code: 'metro-claimed', message: `another process holds ${claimRoot(root, 'metro')}` };
  const claim = attempt.acquired;
  rmSync(heartbeatFile(root), { force: true });
  const writer = metroWriter(root, digest);
  const baseEnv = operationEnv ?? invocations.get(root)?.forwarded.env ?? process.env;
  const env = {
    STIM_METRO_HEARTBEAT: heartbeatFile(root),
    STIM_METRO_PORT: String(port),
    ...(digest ? { STIM_INJECTED_DIGEST: digest } : {}),
    ...(launch.publicOrigin
      ? { [PUBLIC_METRO_ENV]: launch.publicOrigin, EXPO_PACKAGER_PROXY_URL: launch.publicOrigin }
      : {}),
  };
  clearExpoMetroTunnel(root);
  let token: string | undefined;
  const onTunnelUrl = (url: string) => {
    try {
      withWorkspaceStateLock(root, () => {
        if (token && readWorkspaceState(root)?.supervisor?.processToken === token)
          writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url } });
      });
    } catch (error) {
      log('warn', 'expo_tunnel_unrecorded', `${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
    writer.write({ src: 'metro', level: 'info', event: 'expo_tunnel_ready', msg: `Expo tunnel ready: ${url}` });
  };
  let created: MetroChild | undefined;
  let watched: MetroWatchState | undefined;
  const roots = trackMetroWatchRoots({
    workspaceRoot: root,
    writer,
    onChange: (watch) => (created ? saveWatch(created, watch) : (watched = watch)),
  });
  const output = openChildOutput(logsDir);
  let handle: ChildServerHandle;
  let spawned: ReturnType<ReturnType<typeof getExecutor>['spawn']> | undefined;
  const spawn: ReturnType<typeof getExecutor>['spawn'] = (...args) => {
    spawned = getExecutor().spawn(...args);
    return spawned;
  };
  try {
    markClaimChildPending(claim);
    handle = command
      ? await startCommandServer({
          root,
          port,
          logsDir,
          command,
          writer: writer,
          output,
          spawnFn: spawn,
          extraEnv: env,
          baseEnv,
        })
      : mode === MODE_EXPO
        ? await startExpoServer({
            root,
            port,
            logsDir,
            writer: writer,
            settings,
            output,
            extraEnv: env,
            spawnFn: spawn,
            baseEnv,
            tunnel: launch.tunnel,
            resetCache,
            onTunnelUrl,
          })
        : spawnHost(root, port, output, env, writer, baseEnv, spawn, resetCache);
  } catch (error) {
    if (spawned?.pid) {
      writer.close();
      throw unverifiedChild(claim, { pid: spawned.pid }, error instanceof Error ? error.message : String(error));
    }
    releaseClaim(claim);
    writer.close();
    return { op: 'error', code: 'metro-start', message: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const fd of output.fds) closeSync(fd);
  }
  const pid = handle.serverPid;
  const processToken = handle.processToken;
  if (!pid || !processToken) {
    try {
      if (pid && (!GROUPS || processGroupAlive(pid)))
        throw new Error('the dev server process identity could not be verified');
      await handle.close();
    } catch (error) {
      writer.close();
      throw unverifiedChild(claim, { pid: pid ?? 0 }, error instanceof Error ? error.message : String(error));
    }
    releaseClaim(claim);
    writer.close();
    return {
      op: 'error',
      code: 'metro-start',
      message: 'the dev server started but its process identity could not be read',
    };
  }
  setClaimChild(claim, { pid, processToken });
  if (GROUPS) handle.child.unref();
  const observesRequests = handle.observesRequests === true || mode === MODE_BARE;
  let observed = claim;
  try {
    observed = updateClaimDetails(claim, { ...claim.details, observesRequests }) ?? claim;
  } catch {}
  const child: MetroChild = {
    root,
    launch,
    port,
    mode,
    digest,
    pid,
    processToken,
    claim: observed,
    writer,
    handle,
    startedAt: new Date().toISOString(),
    tail: handle.tail ?? null,
    ready: false,
    ensuredAt: Date.now(),
    gone: false,
    closeLinks: null,
    roots,
    observesRequests,
  };
  children.set(root, child);
  created = child;
  if (watched) saveWatch(child, watched);
  token = processToken;
  record(child, observesRequests);
  recordForeignMetro(root, port, {});
  roots.started(pid);
  serveLinks(child, log);
  handle.onExit((info) => {
    if (child.stopping || (GROUPS && processGroupAlive(child.pid))) return;
    settleExited(child, info?.code ?? null, info?.signal ?? null);
  });
  writer.write({
    src: 'metro',
    level: 'info',
    event: 'supervisor_started',
    msg: `stimd started the ${mode} dev server pid ${pid} on port ${port} for ${root}`,
  });
  log('info', 'metro_started', `${root}: the ${mode} dev server pid ${pid} on port ${port}`);
  return awaitReady(child, output.files.stderr, signal);
}

/**
 * Waits up to `READY_MS` for a child this stimd just started to answer. A stop ends the wait at once. When the command
 * that asked for it ends first, a child that still does not answer stops, unless another request for the workspace is
 * queued behind this one and will use it.
 */
async function awaitReady(child: MetroChild, stderr: string, signal: AbortSignal | undefined): Promise<Answer> {
  const readiness = new AbortController();
  child.readiness = readiness;
  try {
    for (const deadline = Date.now() + READY_MS; Date.now() < deadline;) {
      if (readiness.signal.aborted)
        return { op: 'error', code: 'metro-stopping', message: 'a stop ended the dev server before it answered' };
      if (!running(child))
        return {
          op: 'error',
          code: 'metro-exited',
          message: lastLine(stderr) || 'the dev server exited before it answered',
        };
      if (await isMetroRunning(child.port, AbortSignal.timeout(PROBE_MS))) {
        child.ready = true;
        return answer(child, 'started');
      }
      if (signal?.aborted) {
        if ((queued.get(child.root) ?? 0) <= 1)
          await stopChild(child, 'the command that started it ended before it answered');
        return { op: 'error', code: 'cancelled', message: 'the operation ended before the dev server answered' };
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (signal) stopWhenOperationEnds(child, signal);
    return answer(child, 'starting');
  } finally {
    if (child.readiness === readiness) child.readiness = undefined;
  }
}

/** After `READY_MS`, a child that still does not answer stops when the requesting operation ends, as it does before. */
function stopWhenOperationEnds(child: MetroChild, signal: AbortSignal): void {
  const stop = () =>
    void serialize(child.root, async () => {
      if (children.get(child.root) !== child || child.ready || !running(child)) return answer(child, 'starting');
      if (await isMetroRunning(child.port, AbortSignal.timeout(PROBE_MS))) {
        child.ready = true;
        return answer(child, 'started');
      }
      if ((queued.get(child.root) ?? 0) <= 1)
        await stopChild(child, 'the command that started it ended before it answered');
      return answer(child, 'starting');
    });
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
}

async function ensure(
  root: string,
  port: number,
  launch: boolean,
  log: Log,
  operationEnv?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  options: Launch & { resetCache?: boolean } = { tunnel: false, publicOrigin: null },
): Promise<Answer> {
  await adoptFromPredecessor(root, log);
  if (signal?.aborted) return { op: 'error', code: 'cancelled', message: 'the operation ended' };
  const child = children.get(root);
  if (child?.stopping && cleanupFailure) throw cleanupFailure;
  if (child) child.ensuredAt = Date.now();
  if (child && child.port === port && running(child)) {
    // compat C6 permanent
    if (launch && child.digest !== injectedDigest())
      await stopChild(child, 'a launch restarts a Metro of other injected files');
    // compat end
    else if (heartbeatFresh(child) || (await isMetroRunning(port, AbortSignal.timeout(PROBE_MS)))) {
      child.ready = true;
      return answer(child);
    } else await stopChild(child, `no heartbeat for ${HEARTBEAT_FRESH_MS / 1000} s and /status did not answer`);
  } else if (child)
    await stopChild(child, child.port === port ? 'it no longer runs' : `the workspace now uses port ${port}`);
  const found = await resolveProjectMetro(port, root);
  if (found.metro) {
    recordForeignMetro(root, port, found);
    return { op: 'metro', state: found.metro.processToken ? 'supervisor' : 'foreign', pid: found.metro.pid, port };
  }
  if (found.notOurs) return { op: 'error', code: 'port-taken', message: found.notOurs };
  if (signal?.aborted) return { op: 'error', code: 'cancelled', message: 'the operation ended' };
  const { resetCache = false, ...how } = options;
  return start(root, port, log, operationEnv, how, resetCache, signal);
}

/**
 * `metro.ensure {root, port?, launch?, tunnel?, publicOrigin?, resetCache?}`: makes sure the workspace's Metro runs as
 * a child of this stimd and answers `{op: 'metro', state, pid, port, mode}`. A spawned child whose handle runs and
 * whose heartbeat is under 3 s old answers at once; a stale heartbeat probes `/status` for 500 ms and restarts Metro
 * when it fails. A Metro on the port that runs from the project and that Stim did not start is reused and recorded in
 * `metro.foreign.json`. With `launch`, a Metro of other injected files is restarted first. A Metro this call starts
 * runs Expo's own tunnel with `tunnel`, serves `publicOrigin` (a managed tunnel's URL) and, with `resetCache`, starts
 * with empty Metro caches; a restart keeps the first two.
 */
export function ensureMetro(
  params: unknown,
  log: Log,
  operationEnv?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Answer> {
  if (closingChildren) return Promise.resolve({ op: 'error', code: 'metro', message: 'The Stim daemon is ending.' });
  const fields = isJsonObject(params) ? params : {};
  let root: string;
  try {
    root = realpathSync(String(fields.root));
  } catch {
    return Promise.resolve({ op: 'error', code: 'bad-root', message: `no workspace at ${String(fields.root)}` });
  }
  const portEnv =
    process.platform === 'win32'
      ? Object.entries(operationEnv ?? {}).find(([name]) => name.toUpperCase() === 'STIM_METRO_PORT')?.[1]
      : operationEnv?.STIM_METRO_PORT;
  const override = portEnv
    ? metroPortSetting(resolveProjectSettings(root).settings, { STIM_METRO_PORT: portEnv })
    : null;
  if (override?.error) return Promise.resolve({ op: 'error', code: 'bad-port', message: override.error });
  const port = Number.isInteger(fields.port)
    ? Number(fields.port)
    : (override?.port ?? loadConfig()?.projects?.[root]?.metroPort);
  if (!port) return Promise.resolve({ op: 'error', code: 'no-port', message: `${root} has no Metro port` });
  const child = children.get(root);
  if (
    !busy.has(root) &&
    child?.handle &&
    !child.stopping &&
    child.port === port &&
    fields.launch !== true &&
    running(child) &&
    heartbeatFresh(child)
  ) {
    child.ensuredAt = Date.now();
    return Promise.resolve(answer(child));
  }
  const options = {
    tunnel: fields.tunnel === true,
    publicOrigin: typeof fields.publicOrigin === 'string' ? fields.publicOrigin : null,
    resetCache: fields.resetCache === true,
  };
  return serialize(root, () => ensure(root, port, fields.launch === true, log, operationEnv, signal, options));
}

export function stopManagedMetro(params: unknown, log: Log): Promise<Answer> {
  const fields = isJsonObject(params) ? params : {};
  let root: string;
  try {
    root = realpathSync(String(fields.root));
  } catch {
    return Promise.resolve({ op: 'error', code: 'bad-root', message: 'The workspace is unavailable.' });
  }
  children.get(root)?.readiness?.abort();
  return serialize(root, async () => {
    await adoptFromPredecessor(root, log);
    const child = children.get(root);
    if (!child) return { op: 'metro.stopped', state: 'not-owned' };
    if (child.pid !== fields.pid || child.processToken !== fields.processToken)
      return { op: 'error', code: 'metro-changed', message: 'The managed dev server changed before it could stop.' };
    await stopChild(child, 'requested by a command');
    return { op: 'metro.stopped', state: 'stopped' };
  });
}

/** `op.begin {params: {workspace}}`'s flag: the workspace's Metro loaded other injected files, so it is foreign until a restart. */
export function metroOpFlags(params: unknown): Answer {
  let child: MetroChild | undefined;
  try {
    if (isJsonObject(params) && typeof params.workspace === 'string')
      child = children.get(realpathSync(params.workspace));
  } catch {}
  const digest = child ? child.digest : predecessorDigest(params);
  // compat C6 permanent
  return digest !== undefined && digest !== injectedDigest() ? { metroForeign: true } : {};
  // compat end
}

function predecessorDigest(params: unknown): string | null | undefined {
  try {
    if (!isJsonObject(params) || typeof params.workspace !== 'string') return undefined;
    const digest = predecessorClaim(realpathSync(params.workspace))?.details.digest;
    return digest === undefined ? undefined : typeof digest === 'string' ? digest : null;
  } catch {
    return undefined;
  }
}

/** The workspaces whose dev servers stop when this stimd exits: on Windows, every one it runs; elsewhere, none. */
export function metroRootsEndingWithStimd(): string[] {
  return GROUPS ? [] : [...new Set([...children.keys(), ...tunnels.keys()])];
}

/** Whether this stimd supervises any Metro or tunnel child, which keeps it running whatever `daemon.mode` says. */
export function metroChildrenRun(): boolean {
  return children.size > 0 || tunnels.size > 0 || busy.size > 0;
}

function retake(holder: ClaimHolder, root: string, label: string): ClaimHandle | null {
  if (
    !holder.child ||
    inspectProcessIdentity(holder.owner) === 'same' ||
    inspectProcessIdentity(holder.child) !== 'same'
  )
    return null;
  try {
    releaseClaim({ ...holder, root, label });
    const { offsets: _consumed, ...details } = holder.details;
    const attempt = tryAcquireClaim({ root, mode: 'exclusive', label, details });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) setClaimChild(attempt.acquired, holder.child);
    return attempt.acquired ?? null;
  } catch {
    return null;
  }
}

function offsetsOf(value: unknown): Record<'stdout' | 'stderr', number> | undefined {
  return isJsonObject(value) && typeof value.stdout === 'number' && typeof value.stderr === 'number'
    ? { stdout: value.stdout, stderr: value.stderr }
    : undefined;
}

/**
 * Takes over the Metro and tunnel children an earlier stimd of this home left running, by their claims: a claim whose
 * holder is gone and whose child runs. It runs at boot and on every tick, for a predecessor still exiting at boot.
 * Windows has no process groups, so there its children stop with their stimd and nothing is adopted.
 */
export function adoptMetroChildren(log: Log): void {
  if (!GROUPS) return;
  let paths: string[];
  try {
    paths = Object.keys(loadConfig()?.projects ?? {});
  } catch (error) {
    log(
      'warn',
      'metro_adopt_failed',
      `the config cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const path of paths) adoptAt(path, log);
}

function adoptAt(path: string, log: Log): void {
  if (!GROUPS) return;
  for (const holder of children.has(path) ? [] : readClaimSet(claimRoot(path, 'metro')).live) {
    const claim = retake(holder, claimRoot(path, 'metro'), 'Metro');
    if (!claim || !holder.child) continue;
    const digest = typeof holder.details.digest === 'string' ? holder.details.digest : null;
    const mode = String(holder.details.mode);
    const writer = metroWriter(path, digest);
    const records = childRecords({ log: writer, toRecord: outputRecord(mode) });
    const child: MetroChild = {
      root: path,
      launch: launchOf(holder.details),
      port: Number(holder.details.port),
      mode,
      digest,
      ...holder.child,
      startedAt: holder.startedAt,
      claim,
      writer,
      handle: null,
      tail: tailChildOutput(outputFiles(path), records.push, offsetsOf(holder.details.offsets)),
      ready: true,
      ensuredAt: 0,
      gone: false,
      closeLinks: null,
      roots: null,
      observesRequests: holder.details.observesRequests === true,
    };
    children.set(path, child);
    child.roots = trackMetroWatchRoots({
      workspaceRoot: path,
      writer,
      known: watchOf(holder.details.watch),
      onChange: (watch) => saveWatch(child, watch),
    });
    child.roots.started(child.pid);
    serveLinks(child, log);
    const supervisor = readWorkspaceState(path)?.supervisor;
    if (isJsonObject(supervisor) && typeof claim.details.engineDir === 'string')
      writeWorkspaceState(path, { supervisor: { ...supervisor, engineDir: claim.details.engineDir } });
    else if (!isJsonObject(supervisor)) record(child, child.observesRequests);
    log(
      'info',
      'metro_adopted',
      `${path}: adopted the ${child.mode} dev server pid ${child.pid}${child.digest !== injectedDigest() ? ', of other injected files' : ''}`,
    );
  }
  for (const holder of tunnels.has(path) ? [] : readClaimSet(claimRoot(path, 'tunnel')).live) {
    const claim = retake(holder, claimRoot(path, 'tunnel'), 'tunnel');
    if (claim && holder.child)
      tunnels.set(path, {
        claim,
        ...holder.child,
        url: String(holder.details.url),
        startedAt: typeof holder.details.startedAt === 'string' ? holder.details.startedAt : holder.startedAt,
      });
  }
}

/** The live Metro claim of a workspace this stimd does not supervise yet: another stimd's that is still exiting. */
function predecessorClaim(root: string): ClaimHolder | undefined {
  if (children.has(root)) return undefined;
  return readClaimSet(claimRoot(root, 'metro')).live.find((holder) => holder.child && holder.owner.pid !== process.pid);
}

/** Waits up to `SUCCESSOR_WAIT_MS` for the stimd that holds the workspace's Metro claim to exit, then adopts its Metro. */
async function adoptFromPredecessor(root: string, log: Log): Promise<void> {
  const holder = predecessorClaim(root);
  if (!holder) return;
  await gone(() => inspectProcessIdentity(holder.owner) === 'same', SUCCESSOR_WAIT_MS);
  adoptAt(root, log);
}

/** Whether nothing used the child's workspace since `since`: no Metro request, no device use, no blocker. */
async function idlePoint(child: MetroChild, since: number): Promise<boolean> {
  const probe = workspaceIdleProbe(child.root);
  const metro = metroRequestAt(child.root, since, true);
  if (typeof metro !== 'number' || Date.parse(child.startedAt) > since) return false;
  return Math.max(probe.lastActivityAt(), metro > 0 ? metro : 0) <= since && (await probe.blocker()) === null;
}

/**
 * The tick's Metro hook: forgets children that exited, restarts a Metro of other injected files at its workspace's
 * next idle point, and, while no pass runs (`daemon.mode` off), stops a Metro that served no request and no Stim
 * command for the workspace's `idle.minutes`, with the workspace's devices idle as long, as the supervisor's own idle
 * timers did. Under `on` the idle stage does both, and `report` acts on nothing.
 */
export function metroTick(mode: DaemonMode, log: Log): Promise<void> {
  if (backgroundStopped || closingChildren) return Promise.resolve();
  if (tickWork) return tickWork;
  tickWork = (async () => {
    adoptMetroChildren(log);
    for (const child of children.values()) {
      if (busy.has(child.root)) continue;
      if (child.stopping) {
        if (child.unverified && inspectProcessIdentity(child) === 'gone' && !processGroupAlive(child.pid))
          forget(child, `the ${child.mode} dev server whose stop could not be verified has exited (pid ${child.pid})`);
        continue;
      }
      const decidedAt = Date.now();
      if (!running(child)) {
        if (GROUPS && processGroupAlive(child.pid)) continue;
        settleExited(child, null, null);
        continue;
      }
      // compat C6 permanent
      if (child.digest !== injectedDigest() && (await idlePoint(child, Date.now() - IDLE_POINT_MS))) {
        if (backgroundStopped) break;
        await restartAt(child, decidedAt, 'it loaded other injected files; restarting it at an idle point', log, true);
        continue;
      }
      // compat end
      if (mode !== 'off' || !child.observesRequests) continue;
      const minutes = idleMinutesSetting(resolveProjectSettings(child.root).settings);
      if (minutes <= 0) continue;
      const idleMs = minutes * 60_000;
      if (await idlePoint(child, Date.now() - idleMs)) {
        if (backgroundStopped) break;
        await restartAt(
          child,
          decidedAt,
          `no Metro request or Stim command for ${minutes} minutes (idle.minutes)`,
          log,
          false,
          {
            [IDLE_STOP_KEY]: { reason: 'idle', at: new Date().toISOString(), idleMinutes: minutes },
          },
          idleMs,
        );
      } else {
        const usedAt = workspaceDeviceLastUseAt(child.root);
        if (!Number.isFinite(usedAt) || Date.now() - usedAt >= idleMs) await shutDownIdle(child, idleMs, log);
      }
    }
    for (const [root, tunnel] of tunnels)
      if (
        !busy.has(`tunnel:${root}`) &&
        inspectProcessIdentity(tunnel) === 'gone' &&
        !(GROUPS && processGroupAlive(tunnel.pid))
      ) {
        forgetTunnel(root, tunnel);
      }
  })()
    .catch((error: unknown) => {
      if (error instanceof Error && 'reportCleanup' in error) failedCleanup(error);
      throw error;
    })
    .finally(() => {
      tickWork = null;
    });
  return tickWork;
}

/**
 * Shuts down, through centralized teardown, the workspace's owned devices idle for `idleMs` while the passes do not act
 * and no live share keeps them, under the workspace's native-run lock. Returns what it did and kept, for the log.
 */
async function shutDownIdle(
  child: MetroChild,
  idleMs: number,
  log: Log,
  reason?: typeof DEVICE_METRO_IDLE_STOP_REASON,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    if (await liveShareKeepReason(child.root)) return lines;
    await withIdleWorkspace(
      child.root,
      () =>
        shutDownIdleDevices(
          child.root,
          idleMs,
          (entry) => {
            child.writer.write({ src: 'metro', ...entry });
            lines.push(entry.msg);
          },
          Date.now(),
          reason ? { reason, kept: (line) => lines.push(line) } : {},
        ),
      { purpose: 'device idle shutdown', supervisor: false, managedLocks: false },
    );
  } catch (error) {
    log(
      'warn',
      'device_idle_shutdown_failed',
      `${child.root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return lines;
}

/**
 * Stops the child, unless an ensure took it over meanwhile, and starts it again when `again`, all in its root's turn.
 * An idle stop (`idleMs`) first shuts down the workspace's devices idle as long.
 */
function restartAt(
  child: MetroChild,
  decidedAt: number,
  why: string,
  log: Log,
  again: boolean,
  state: Record<string, unknown> = {},
  idleMs?: number,
): Promise<Answer> {
  return serialize(child.root, async () => {
    if (children.get(child.root) !== child || child.gone || child.ensuredAt >= decidedAt) return {};
    const devices = idleMs ? await shutDownIdle(child, idleMs, log, DEVICE_METRO_IDLE_STOP_REASON) : [];
    await stopChild(child, [why, ...devices].join('; '));
    writeWorkspaceState(child.root, state);
    if (!again) return {};
    const context = invocations.get(child.root);
    const restart = () => ensure(child.root, child.port, false, log, undefined, undefined, child.launch);
    const answered = context ? await withInvocation(context, new AbortController().signal, restart) : await restart();
    if (answered.op === 'error') log('warn', 'metro_restart_failed', `${child.root}: ${String(answered.message)}`);
    return answered;
  });
}

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '');

const providerOf = (tunnel: TunnelChild): ManagedProvider => tunnel.claim.details.provider as ManagedProvider;

const recordOf = (tunnel: TunnelChild): ManagedTunnelRecord => ({
  kind: 'managed',
  provider: providerOf(tunnel),
  pid: tunnel.pid,
  url: tunnel.url,
  port: Number(tunnel.claim.details.port),
  startedAt: tunnel.startedAt,
  processToken: tunnel.processToken,
  ...(typeof tunnel.claim.details.logFile === 'string' ? { logFile: tunnel.claim.details.logFile } : {}),
});

const tunnelAnswer = (tunnel: TunnelChild, reused: boolean): Answer => {
  const { kind: _kind, ...fields } = recordOf(tunnel);
  return { op: 'tunnel', reused, ...fields };
};

const unreachable = (message: string, remedy: string): Answer => ({
  op: 'error',
  code: 'STIM_REMOTE_METRO_UNREACHABLE',
  message,
  remedy,
});

const refuseTunnel = (message: string, remedy: string) => ({
  refusal: { op: 'error', code: 'STIM_REMOTE_START_REQUIRED', message, remedy },
});

/** Takes over a tunnel an earlier CLI recorded in the workspace state without a claim, by its verified identity. */
function adoptRecordedTunnel(root: string): { tunnel: TunnelChild } | { refusal: Answer } | null {
  const recorded = readMetroTunnel(root);
  if (recorded?.kind !== 'managed' || !pidExists(recorded.pid)) return null;
  if (!recorded.processToken)
    return refuseTunnel(
      'The recorded managed Metro tunnel has no process identity token.',
      'Inspect the process, stop it with the provider tooling, remove the stale metroTunnel state, and retry.',
    );
  const identity = { pid: recorded.pid, processToken: recorded.processToken };
  if (inspectProcessIdentity(identity) !== 'same')
    return refuseTunnel(
      `The recorded ${recorded.provider} tunnel pid ${recorded.pid} no longer has its recorded process identity.`,
      'Run `stim stop`, resolve any ownership refusal, then retry `stim start --remote`.',
    );
  const attempt = tryAcquireClaim({
    root: claimRoot(root, 'tunnel'),
    mode: 'exclusive',
    label: 'tunnel',
    details: {
      provider: recorded.provider,
      port: recorded.port,
      url: recorded.url,
      logFile: recorded.logFile,
      startedAt: recorded.startedAt,
    },
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired) return null;
  setClaimChild(attempt.acquired, identity);
  const tunnel = { claim: attempt.acquired, ...identity, url: recorded.url, startedAt: recorded.startedAt };
  tunnels.set(root, tunnel);
  return { tunnel };
}

function recordTunnel(root: string, tunnel: TunnelChild): void {
  const recorded = recordOf(tunnel);
  withWorkspaceStateLock(root, () => writeWorkspaceState(root, { metroTunnel: { ...recorded } }));
  const stored = readMetroTunnel(root);
  if (stored?.kind !== 'managed' || stored.pid !== recorded.pid || stored.processToken !== recorded.processToken)
    throw new Error('The workspace did not retain this tunnel ownership record.');
}

/**
 * `tunnel.ensure {root, port, mode, isExpo?, ngrokUrl?, requireReachable?}`: the workspace's managed tunnel as a child of
 * this stimd in its own process group with file stdio, claimed under `tunnel.claim`, recorded as the workspace's
 * `metroTunnel`, answering `{op: 'tunnel', url, pid, provider, reused}`. Which providers run and in what order is decided
 * here: with `auto`, ngrok then cloudflared, each tried until one prints a URL; a named provider alone. A running
 * tunnel of the same port and a provider this call would try is reused; another one refuses.
 * @ref LLP 0016#stimd-runs-the-managed-tunnel -- one owner for the tunnel, its provider order and its record
 */
export function ensureTunnel(
  params: unknown,
  log: Log,
  operationEnv?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Answer> {
  if (closingChildren) return Promise.resolve({ op: 'error', code: 'metro', message: 'The Stim daemon is ending.' });
  const fields = isJsonObject(params) ? params : {};
  let root: string;
  try {
    root = realpathSync(String(fields.root));
  } catch {
    return Promise.resolve({ op: 'error', code: 'bad-root', message: `no workspace at ${String(fields.root)}` });
  }
  const mode = TUNNEL_MODES.find((name) => name === fields.mode);
  if (!mode || mode === 'off')
    return Promise.resolve({ op: 'error', code: 'bad-mode', message: `no managed tunnel mode ${String(fields.mode)}` });
  const port = Number(fields.port);
  if (!Number.isInteger(port) || port <= 0)
    return Promise.resolve({ op: 'error', code: 'bad-port', message: `no port ${String(fields.port)}` });
  const env = operationEnv ?? invocations.get(root)?.forwarded.env;
  const available = detectProviders((bin) => {
    try {
      return Boolean(getExecutor().findExecutable(bin, env ? { env } : undefined));
    } catch {
      return false;
    }
  }, mode);
  const plan = planMetroReach({ mode, metroPort: port, isExpo: fields.isExpo === true, available });
  if ('failed' in plan) return Promise.resolve(unreachable(plan.failed, plan.remedy));
  if (!('start' in plan))
    return Promise.resolve({ op: 'error', code: 'bad-mode', message: `no managed tunnel for mode ${mode}` });
  const candidates: readonly ManagedProvider[] = mode === 'auto' ? available : [plan.start];
  const ngrokUrl = typeof fields.ngrokUrl === 'string' ? fields.ngrokUrl : null;
  const requireReachable = fields.requireReachable !== false;
  return serialize(`tunnel:${root}`, async () => {
    adoptAt(root, log);
    const owned = tunnels.get(root);
    const adopted = owned ? { tunnel: owned } : adoptRecordedTunnel(root);
    if (adopted && 'refusal' in adopted) return adopted.refusal;
    const known = adopted?.tunnel;
    if (known && inspectProcessIdentity(known) === 'same') {
      const reusable =
        known.claim.details.port === port &&
        candidates.includes(providerOf(known)) &&
        (!ngrokUrl || normalizeUrl(known.url) === normalizeUrl(ngrokUrl));
      if (!reusable)
        return {
          op: 'error',
          code: 'STIM_REMOTE_START_REQUIRED',
          message: 'A different managed Metro tunnel is already running for this workspace.',
          remedy: 'Run `stim stop`, then `stim start --remote`.',
        };
      return tunnelAnswer(known, true);
    }
    if (known) forgetTunnel(root, known);
    return startTunnelChild(root, port, candidates, ngrokUrl, requireReachable, env, signal);
  });
}

async function startTunnelChild(
  root: string,
  port: number,
  providers: readonly ManagedProvider[],
  ngrokUrl: string | null,
  requireReachable: boolean,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  const attempt = tryAcquireClaim({
    root: claimRoot(root, 'tunnel'),
    mode: 'exclusive',
    label: 'tunnel',
    details: { port },
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    return { op: 'error', code: 'tunnel-claimed', message: `another process holds ${claimRoot(root, 'tunnel')}` };
  const claim = attempt.acquired;
  const { startTunnelSequence } = await import('../../engine/tunnel.ts');
  const started = await startTunnelSequence({
    env,
    claims: [claim],
    signal,
    providers,
    port,
    ngrokUrl,
    requireReachable,
  });
  if ('failed' in started) {
    if (started.cleanupFailed) throw unverifiedChild(claim, { pid: 0 }, started.reason);
    releaseClaim(claim);
    return unreachable(`Could not start a managed Metro tunnel for port ${port}.`, started.reason);
  }
  const startedAt = new Date().toISOString();
  const tunnel: TunnelChild = {
    claim:
      updateClaimDetails(claim, {
        provider: started.provider,
        port,
        url: normalizeUrl(started.url),
        logFile: started.logFile,
        startedAt,
      }) ?? claim,
    pid: started.pid,
    processToken: started.processToken,
    url: normalizeUrl(started.url),
    startedAt,
  };
  try {
    recordTunnel(root, tunnel);
  } catch (error) {
    const message = `Could not record the managed Metro tunnel: ${error instanceof Error ? error.message : String(error)}`;
    const stopped = await started.cleanup();
    if (stopped.status === 'failed')
      throw unverifiedChild(claim, started, `${message} ${stopped.reason ?? 'Cleanup failed.'}`);
    releaseClaim(tunnel.claim);
    return unreachable(
      message,
      'The tunnel process was stopped. Fix the workspace write error, then retry `stim start --remote`.',
    );
  }
  tunnels.set(root, tunnel);
  return tunnelAnswer(tunnel, false);
}

/**
 * `tunnel.stop {root, pid, processToken}`: stops the workspace's managed tunnel, one this stimd runs or one an earlier
 * CLI recorded without a claim, by its verified identity, and clears its record. Answers `{op: 'tunnel.stopped', state}`
 * with `state` `stopped`, `missing` (it already ran no more) or `failed` and a `reason`.
 */
export function stopManagedTunnel(params: unknown, log: Log): Promise<Answer> {
  const fields = isJsonObject(params) ? params : {};
  let root: string;
  try {
    root = realpathSync(String(fields.root));
  } catch {
    return Promise.resolve({ op: 'error', code: 'bad-root', message: 'The workspace is unavailable.' });
  }
  return serialize(`tunnel:${root}`, async () => {
    adoptAt(root, log);
    const owned = tunnels.get(root);
    if (owned) {
      if (owned.pid !== fields.pid || owned.processToken !== fields.processToken)
        return { op: 'error', code: 'tunnel-changed', message: 'The managed tunnel changed before it could stop.' };
      await stopTunnel(root, owned);
      return { op: 'tunnel.stopped', state: 'stopped' };
    }
    const recorded = readMetroTunnel(root);
    if (recorded?.kind !== 'managed') return { op: 'tunnel.stopped', state: 'missing' };
    if (recorded.pid !== fields.pid || (recorded.processToken ?? undefined) !== fields.processToken)
      return { op: 'error', code: 'tunnel-changed', message: 'The managed tunnel changed before it could stop.' };
    const { stopTunnel: stopRecorded } = await import('../../engine/tunnel.ts');
    const result = await stopRecorded(recorded);
    if (result.status !== 'failed') withWorkspaceStateLock(root, () => clearManagedMetroTunnel(root, recorded));
    return {
      op: 'tunnel.stopped',
      state: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  });
}

async function stopTunnel(root: string, tunnel: TunnelChild): Promise<void> {
  if (!GROUPS) {
    let stopped = false;
    try {
      stopped =
        inspectProcessIdentity(tunnel) === 'same' &&
        (await signalProcessTreeAsync(tunnel.pid, 'SIGKILL', { platform: 'win32' })) &&
        (await gone(() => inspectProcessIdentity(tunnel) !== 'gone', STOP_MS));
    } catch {}
    if (!stopped)
      throw unverifiedChild(tunnel.claim, tunnel, `Could not confirm shutdown of tunnel pid ${tunnel.pid}.`);
    forgetTunnel(root, tunnel);
    return;
  }
  const alive = () => processGroupAlive(tunnel.pid);
  const verify = () => {
    if (inspectProcessIdentity(tunnel) !== 'same')
      throw unverifiedChild(tunnel.claim, tunnel, 'Could not verify the tunnel process group.');
  };
  if (!alive()) {
    forgetTunnel(root, tunnel);
    return;
  }
  verify();
  try {
    signalProcessTree(tunnel.pid, 'SIGTERM', { group: GROUPS });
  } catch {}
  if (!(await gone(alive, STOP_MS))) {
    verify();
    try {
      signalProcessTree(tunnel.pid, 'SIGKILL', { group: GROUPS });
    } catch {}
    if (!(await gone(alive, 1000)))
      throw unverifiedChild(tunnel.claim, tunnel, `Could not confirm shutdown of tunnel pid ${tunnel.pid}.`);
  }
  forgetTunnel(root, tunnel);
}

function forgetTunnel(root: string, tunnel: TunnelChild): void {
  tunnels.delete(root);
  try {
    withWorkspaceStateLock(root, () => clearManagedMetroTunnel(root, tunnel));
  } catch {}
  releaseClaim(tunnel.claim);
  if (typeof tunnel.claim.details.logFile === 'string') rmSync(tunnel.claim.details.logFile, { force: true });
}

/**
 * At stimd's exit: on Windows, where children cannot be re-adopted, stops them; elsewhere stops following them and
 * records how far it read their output in their claims, for the next stimd.
 */
export function closeMetroChildren(): Promise<void> {
  if (closeWork) return closeWork;
  backgroundStopped = true;
  closingChildren = true;
  closeWork = (async () => {
    await tickWork?.catch(() => {});
    await Promise.allSettled(busy.values());
    if (cleanupFailure) throw cleanupFailure;
    for (const child of children.values()) {
      if (!GROUPS) await stopChild(child, 'stimd exits');
      else if (child.tail) {
        child.tail.stop();
        child.claim =
          updateClaimDetails(child.claim, { ...child.claim.details, offsets: child.tail.offsets() }) ?? child.claim;
      }
    }
    if (!GROUPS) for (const [root, tunnel] of tunnels) await stopTunnel(root, tunnel);
  })().catch((error: unknown) => {
    if (error instanceof Error && 'reportCleanup' in error) failedCleanup(error);
    throw error;
  });
  return closeWork;
}
