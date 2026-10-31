import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { cancellableSleep } from '../../cancellation.ts';
import { runOperationFile, runOperationFileQuiet } from '../../engine/operation-exec.ts';
import { childEnvironment } from '../../workspace/git-read.ts';
import type { StimContext } from '@stim-cli/core';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import chalk from 'chalk';
import { buildWorkerRoot, loadConfig } from '@stim-cli/core/state';
import { formatLongDuration, plural } from '../../command-output.ts';
import { readHostProcessTableAsync, type HostProcess } from '../../devices/activity.ts';
import { listBuildLocks, type BuildLockInfo } from '../../engine/build-lock.ts';
import { listBuildSlots, type BuildSlotInfo } from '../../engine/build-slots.ts';
import { getExecutor } from '../../exec.ts';
import { readFootprints } from '../../footprint.ts';
import { formatBytes, isOnMountedVolume } from '../../fs-util.ts';
import { STIM_SERVER_COMMAND } from '../../machine-usage.ts';
import { readPidFile } from '../../supervisor/state.ts';
import { readHostMemoryPressureAsync } from '../../host-memory.ts';
import { resolveMaintenanceSettings } from '../../maintenance/settings.ts';
import {
  parseSubscriberNames,
  parseTriggerCount,
  parseWatchmanClients,
  parseWatchmanPid,
  parseWatchRoots,
  type WatchmanClient,
} from '../../watchman.ts';
import type { Finding } from '../../diagnostics/doctor.ts';
import { phase } from './progress.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';

export const WATCHMAN_KIND = 'watchman';
export const GRADLE_DAEMONS_KIND = 'gradle-daemons';
export type MemoryCacheKind = typeof WATCHMAN_KIND | typeof GRADLE_DAEMONS_KIND;

export interface MemoryScope {
  watchman: boolean;
  gradle: boolean;
  /** Plans Gradle and Kotlin daemon stops whatever the memory, for the disk pressure step that deletes Gradle versions. */
  anyMemory?: boolean;
}

/** The memory kind `--cache` names, or null for any other name. */
export function memoryCacheKind(cache: string | null | undefined): MemoryCacheKind | null {
  const wanted = cache?.trim().toLowerCase();
  return wanted === WATCHMAN_KIND || wanted === GRADLE_DAEMONS_KIND ? wanted : null;
}

/** Which helpers a gc run inspects: both without --cache, one for its own kind, none for any other --cache. */
export function memoryScope(cache: string | null | undefined): MemoryScope | null {
  if (!cache?.trim()) return { watchman: true, gradle: true };
  const kind = memoryCacheKind(cache);
  return kind ? { watchman: kind === WATCHMAN_KIND, gradle: kind === GRADLE_DAEMONS_KIND } : null;
}

type MemoryKeptCode = 'in-use' | 'busy' | 'unknown' | 'build-running' | 'stim-server' | 'memory-ok';

export interface MemoryProcess {
  kind: 'watchman' | 'gradleDaemon' | 'kotlinDaemon';
  cacheKind: MemoryCacheKind;
  pid: number;
  startedAt: string | null;
  bytes: number;
  measure: 'footprint' | 'rss';
  version: string | null;
  gradleHome: string | null;
  offloadClient: string | null;
  state: 'idle' | 'busy' | 'unknown';
  reclaimable: boolean;
  reason: MemoryKeptCode | null;
  detail: string | null;
}

export type WatchmanRootStale = 'missing' | 'pruned-worktree';

export interface WatchmanRoot {
  path: string;
  stale: WatchmanRootStale | null;
  subscriptions: number | null;
  triggers: number | null;
  removable: boolean;
  detail: string | null;
}

export interface MemoryReport {
  processes: MemoryProcess[];
  watchmanRoots: WatchmanRoot[];
  notices: string[];
}

const WATCHMAN_TIMEOUT_MS = 5000;
const WATCHMAN_DOCTOR_BYTES = 2 * 1024 ** 3;
const GRADLE_STATUS_TIMEOUT_MS = 20_000;
const GRADLE_STOP_TIMEOUT_MS = 60_000;
const LSOF_TIMEOUT_MS = 10_000;
const ROOT_PROBES_AT_ONCE = 4;
const GRADLE_DAEMON_CLASS = /\borg\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon\s+(\S+)/;
const KOTLIN_DAEMON_CLASS = /^\S.*?\/bin\/java\s.*\sorg\.jetbrains\.kotlin\.daemon\.KotlinCompileDaemon(\s|$)/;

export interface GradleDaemonCommand {
  version: string;
  javaHome: string;
  distribution: string | null;
}

/**
 * The Gradle version, Java home and distribution of a `GradleDaemon` process from its command line. The
 * distribution is the directory whose `lib/` holds the daemon's main jar (`gradle-daemon-main-<v>.jar`, or
 * `gradle-launcher-<v>.jar` before Gradle 8.13), so `<distribution>/bin/gradle` is the daemon's own launcher.
 */
export function parseGradleDaemonCommand(command: string): GradleDaemonCommand | null {
  const version = GRADLE_DAEMON_CLASS.exec(command)?.[1];
  const java = /^(\/.*?)\/bin\/java\s/.exec(command)?.[1];
  if (!version || !java) return null;
  const jar =
    /(?:^|\s)-(?:cp|classpath)\s+(?:[^\s]*:)?(\/.*?\/lib\/gradle-(?:daemon-main|launcher)-[^/\s:]+\.jar)(?=[\s:])/.exec(
      command,
    )?.[1];
  return { version, javaHome: java, distribution: jar ? dirname(dirname(jar)) : null };
}

export function isKotlinDaemonCommand(command: string): boolean {
  return KOTLIN_DAEMON_CLASS.test(command) && !GRADLE_DAEMON_CLASS.test(command);
}

/**
 * The offload client whose Gradle home under `workerRoot` a daemon uses: named by its classpath, as stim-server
 * matches it, or by the Gradle home it runs in.
 */
export function offloadClientOf(command: string, workerRoot: string, gradleHome: string | null): string | null {
  const root = resolve(workerRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const home = new RegExp(`${root}/([^/\\s]+)/cache/gradle(/|$)`);
  return home.exec(command)?.[1] ?? (gradleHome ? (home.exec(gradleHome)?.[1] ?? null) : null);
}

/** `gradle --status` rows: the state of each daemon pid it lists, lowercased (idle, busy, stopped, ...). */
export function parseGradleStatus(output: string): Map<number, string> {
  const states = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+([A-Z][A-Z_]*)\s+\S/.exec(line);
    if (match) states.set(Number(match[1]), match[2]!.toLowerCase());
  }
  return states;
}

export interface LsofProcess {
  files: string[];
  /** Each ESTABLISHED TCP connection as its `local->remote` name. */
  connections: string[];
}

/** `lsof -F pnT` output: each pid's open file names and its ESTABLISHED TCP connections. */
export function parseLsof(output: string): Map<number, LsofProcess> {
  const processes = new Map<number, LsofProcess>();
  let current: LsofProcess | null = null;
  let name: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      current = processes.get(pid) ?? { files: [], connections: [] };
      processes.set(pid, current);
    } else if (current && line.startsWith('n')) {
      name = line.slice(1);
      current.files.push(name);
    } else if (current && name?.includes('->') && line === 'TST=ESTABLISHED') {
      current.connections.push(name);
    }
  }
  return processes;
}

/**
 * The process at the other end of each of `pid`'s connections, found among the other processes lsof listed by the
 * reversed `remote->local` name; null for a peer lsof did not list.
 */
export function connectionPeers(pid: number, lsof: ReadonlyMap<number, LsofProcess>): (number | null)[] {
  return (lsof.get(pid)?.connections ?? []).map((connection) => {
    const [local, remote] = connection.split('->');
    const reversed = `${remote}->${local}`;
    for (const [other, entry] of lsof) {
      if (other !== pid && entry.connections.includes(reversed)) return other;
    }
    return null;
  });
}

/** The Gradle user home a daemon runs in: the one whose `daemon/<version>/daemon-<pid>.out.log` it holds open. */
export function gradleHomeFromFiles(pid: number, version: string, files: readonly string[]): string | null {
  const suffix = `/daemon/${version}/daemon-${pid}.out.log`;
  const log = files.find((file) => file.endsWith(suffix));
  return log ? log.slice(0, -suffix.length) : null;
}

interface RootProbe {
  exists(path: string): boolean;
  isFile(path: string): boolean;
  read(path: string): string | null;
  mounted(path: string): boolean;
}

const fsProbe: RootProbe = {
  exists: existsSync,
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  mounted: (path) => isOnMountedVolume(path),
};

/**
 * Why a watch root is stale: its directory is gone from a mounted volume, or the nearest `.git` above it is a
 * linked worktree's `.git` file whose gitdir no longer exists (git pruned the worktree and left the directory).
 * Null when it is live or when that cannot be proven, such as a path on a volume that is not mounted.
 */
export function watchmanRootStaleness(path: string, probe: RootProbe = fsProbe): WatchmanRootStale | null {
  if (!probe.exists(path)) return probe.mounted(path) ? 'missing' : null;
  for (let dir = path; ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (probe.exists(git)) {
      if (!probe.isFile(git)) return null;
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(probe.read(git) ?? '')?.[1];
      if (!target) return null;
      const gitdir = isAbsolute(target) ? target : resolve(dir, target);
      return probe.exists(gitdir) || !probe.mounted(gitdir) ? null : 'pruned-worktree';
    }
    if (dirname(dir) === dir) return null;
  }
}

interface WatchmanRootFacts {
  path: string;
  stale: WatchmanRootStale | null;
  subscribers: string[] | null;
  triggers: number | null;
}

interface ProcessMeasure {
  bytes: number;
  measure: 'footprint' | 'rss';
}

export interface WatchmanFacts extends ProcessMeasure {
  pid: number;
  startedAt: string | null;
  roots: WatchmanRootFacts[] | null;
  /** Connected clients other than gc's own call and the daemon's own connections, or null when `debug-status` did not list them. */
  clients: WatchmanClient[] | null;
}

function staleText(stale: WatchmanRootStale): string {
  return stale === 'missing' ? 'its directory is gone' : 'its linked worktree was pruned';
}

function planWatchmanRoot(root: WatchmanRootFacts): WatchmanRoot {
  const subscriptions = root.subscribers?.length ?? null;
  const base = { path: root.path, stale: root.stale, subscriptions, triggers: root.triggers };
  if (root.stale === null) return { ...base, removable: false, detail: null };
  const kept =
    subscriptions === null
      ? 'could not list its subscriptions'
      : subscriptions > 0
        ? `${subscriptions} subscription(s) still use it`
        : root.triggers === null
          ? 'could not list its triggers'
          : root.triggers > 0
            ? `it has ${root.triggers} trigger(s)`
            : null;
  return {
    ...base,
    removable: kept === null,
    detail: kept ? `${staleText(root.stale)}, but ${kept}` : staleText(root.stale),
  };
}

/**
 * Decides the watchman roots gc removes and whether it may shut the daemon down. A stale root goes only while no
 * subscription or trigger uses it. The daemon goes only when `debug-status` lists no client besides gc's own call and
 * every root's subscriptions and triggers could be read, no kept root has a trigger, and no root has a subscription;
 * `describeClient` names each client that keeps it.
 */
export function planWatchman(
  facts: WatchmanFacts,
  describeClient: (client: WatchmanClient) => string,
): { process: MemoryProcess; roots: WatchmanRoot[] } {
  const roots = (facts.roots ?? []).map(planWatchmanRoot);
  const unreadRoots =
    facts.roots === null || roots.some((root) => root.subscriptions === null || root.triggers === null);
  const triggered = roots.filter((root) => !root.removable && (root.triggers ?? 0) > 0);
  let reason: MemoryKeptCode | null = null;
  let detail: string | null = null;
  if (facts.clients === null || unreadRoots) {
    reason = 'unknown';
    detail =
      facts.clients === null
        ? 'watchman debug-status did not list its clients'
        : 'could not list the subscriptions and triggers of every root';
  } else if (facts.clients.length > 0) {
    reason = 'in-use';
    detail = `used by ${[...new Set(facts.clients.map(describeClient))].join(', ')}; shutting it down would break their file watching`;
  } else if (roots.some((root) => !root.removable && (root.subscriptions ?? 0) > 0)) {
    reason = 'in-use';
    detail = 'a root still has a subscription';
  } else if (triggered.length > 0) {
    reason = 'in-use';
    detail = `${triggered.map((root) => root.path).join(', ')} ha${triggered.length === 1 ? 's' : 've'} triggers that stop firing while watchman is down`;
  }
  return {
    process: {
      kind: 'watchman',
      cacheKind: WATCHMAN_KIND,
      pid: facts.pid,
      startedAt: facts.startedAt,
      bytes: facts.bytes,
      measure: facts.measure,
      version: null,
      gradleHome: null,
      offloadClient: null,
      state: reason === 'in-use' ? 'busy' : reason === 'unknown' ? 'unknown' : 'idle',
      reclaimable: reason === null,
      reason,
      detail,
    },
    roots,
  };
}

export interface GradleDaemonFacts extends ProcessMeasure {
  pid: number;
  startedAt: string | null;
  command: GradleDaemonCommand;
  gradleHome: string | null;
  offloadClient: string | null;
  /** The state `gradle --status` gave, or why it could not be read. */
  status: { state: string } | { unknown: string };
}

export interface KotlinDaemonFacts extends ProcessMeasure {
  pid: number;
  startedAt: string | null;
  /** The pid at the other end of each ESTABLISHED connection (null when unknown), or null when lsof failed. */
  peers: (number | null)[] | null;
}

/**
 * Decides which Gradle and Kotlin daemons gc may stop. A running Stim build (`buildRunning`) keeps every one, and so
 * does memory that is not low (`memoryOk`, why). An offload worker's daemon is left to stim-server while it runs. A Gradle daemon goes only when its own `gradle
 * --status` says IDLE. A Kotlin daemon goes only when every Gradle daemon is idle and each of its connections comes from
 * a Gradle daemon gc stops in the same run.
 */
export function planDaemons({
  gradle,
  kotlin,
  buildRunning,
  memoryOk,
  stimServerRunning,
}: {
  gradle: readonly GradleDaemonFacts[];
  kotlin: readonly KotlinDaemonFacts[];
  buildRunning: string | null;
  memoryOk: string | null;
  stimServerRunning: boolean;
}): MemoryProcess[] {
  const plans: MemoryProcess[] = [];
  const gradleBusy = gradle.some((daemon) => !('state' in daemon.status) || daemon.status.state !== 'idle');
  for (const daemon of gradle) {
    const state = 'state' in daemon.status ? daemon.status.state : null;
    const idle = state === 'idle';
    let reason: MemoryKeptCode | null = null;
    let detail: string | null = null;
    if (daemon.offloadClient !== null && stimServerRunning) {
      reason = 'stim-server';
      detail = `stim-server stops the daemons of offload client ${daemon.offloadClient} when memory runs low and no offloaded build runs`;
    } else if (buildRunning) {
      reason = 'build-running';
      detail = buildRunning;
    } else if (memoryOk) {
      reason = 'memory-ok';
      detail = memoryOk;
    } else if (state === 'busy') {
      reason = 'busy';
      detail = 'a build is using it';
    } else if (!idle) {
      reason = 'unknown';
      detail = 'unknown' in daemon.status ? daemon.status.unknown : `gradle --status reports it ${state}`;
    }
    plans.push({
      kind: 'gradleDaemon',
      cacheKind: GRADLE_DAEMONS_KIND,
      pid: daemon.pid,
      startedAt: daemon.startedAt,
      bytes: daemon.bytes,
      measure: daemon.measure,
      version: daemon.command.version,
      gradleHome: daemon.gradleHome,
      offloadClient: daemon.offloadClient,
      state: idle ? 'idle' : state === 'busy' ? 'busy' : 'unknown',
      reclaimable: reason === null,
      reason,
      detail,
    });
  }
  const stopping = new Set(plans.filter((plan) => plan.reclaimable).map((plan) => plan.pid));
  for (const daemon of kotlin) {
    const clients = daemon.peers?.filter((peer) => peer === null || !stopping.has(peer)) ?? [];
    let reason: MemoryKeptCode | null = null;
    let detail: string | null = null;
    if (buildRunning) {
      reason = 'build-running';
      detail = buildRunning;
    } else if (memoryOk) {
      reason = 'memory-ok';
      detail = memoryOk;
    } else if (daemon.peers === null) {
      reason = 'unknown';
      detail = 'lsof could not list its connections';
    } else if (gradleBusy) {
      reason = 'busy';
      detail = 'a Gradle daemon is busy or its state is unknown, and it may be compiling through this one';
    } else if (clients.length > 0) {
      reason = 'busy';
      detail = `${clients.length} connection(s) from a process gc does not stop are open`;
    }
    plans.push({
      kind: 'kotlinDaemon',
      cacheKind: GRADLE_DAEMONS_KIND,
      pid: daemon.pid,
      startedAt: daemon.startedAt,
      bytes: daemon.bytes,
      measure: daemon.measure,
      version: null,
      gradleHome: null,
      offloadClient: null,
      state: reason === null ? 'idle' : reason === 'unknown' ? 'unknown' : 'busy',
      reclaimable: reason === null,
      reason,
      detail,
    });
  }
  return plans;
}

/**
 * Why no Gradle or Kotlin daemon may be stopped now, or null. An Android build lock, or a build slot that no live iOS
 * build lock of the same process holds, counts as a running build; one whose holder is unresolved counts too.
 */
export function runningBuild(locks: readonly BuildLockInfo[], slots: readonly BuildSlotInfo[]): string | null {
  const android = locks.find((lock) => lock.platform === 'android' && (lock.alive || lock.unresolved));
  if (android) {
    return `${android.unresolved ? 'an unresolved' : 'a running'} Android build holds ${android.path} (pid ${android.pid ?? '?'}, ${android.projectRoot || 'unrecorded workspace'})`;
  }
  const ios = new Set(locks.filter((lock) => lock.platform === 'ios' && lock.alive).map((lock) => lock.pid));
  const slot = slots.find((s) => (s.alive || s.unresolved) && !(s.alive && s.pid !== null && ios.has(s.pid)));
  if (slot) {
    return `${slot.unresolved ? 'an unresolved' : 'a running'} build holds build slot ${slot.index ?? '?'} (pid ${slot.pid ?? '?'}, ${slot.projectRoot || 'unrecorded workspace'})`;
  }
  return null;
}

function stimWorkspaceOf(
  pid: number,
  parentOf: ReadonlyMap<number, number>,
  supervisors: ReadonlyMap<number, string>,
): string | null {
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < 64; depth++) {
    const workspace = supervisors.get(current);
    if (workspace) return workspace;
    current = parentOf.get(current);
  }
  return null;
}

function reclaimableBytes(report: MemoryReport, kind?: MemoryCacheKind): number {
  return report.processes
    .filter((entry) => entry.reclaimable && (kind === undefined || entry.cacheKind === kind))
    .reduce((sum, entry) => sum + entry.bytes, 0);
}

type BoundWatchman = (args: string[], operation?: StimContext) => Promise<unknown>;

const boundWatchman: BoundWatchman = async (args, operation) => {
  const options = { timeoutMs: WATCHMAN_TIMEOUT_MS, cwd: operation?.cwd };
  const output = await runOperationFile(operation, getExecutor(), 'watchman', ['--no-spawn', ...args], options);
  const answer: unknown = JSON.parse(output);
  const error = (answer as { error?: unknown } | null)?.error;
  if (error !== undefined) throw new Error(String(error));
  return answer;
};

async function quietly<T>(fn: () => Promise<T>, operation?: StimContext): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    return null;
  }
}

/**
 * `watchman debug-status` with gc's own call left out of its clients. The call is spawned directly so its pid is
 * known: debug-status lists the asking CLI as a client too.
 */
async function watchmanClients(operation?: StimContext): Promise<WatchmanClient[] | null> {
  if (operation) {
    let self: number | undefined;
    const output = await runOperationFileQuiet(operation, getExecutor(), 'watchman', ['--no-spawn', 'debug-status'], {
      timeoutMs: WATCHMAN_TIMEOUT_MS,
      cwd: operation.cwd,
      onSpawn: (child) => {
        self = child.pid;
      },
    });
    try {
      if (output === null || self === undefined) return null;
      return parseWatchmanClients(JSON.parse(output))?.filter((client) => client.pid !== self) ?? null;
    } catch {
      return null;
    }
  }
  return new Promise((done) => {
    let child;
    try {
      child = getExecutor().spawn('watchman', ['--no-spawn', 'debug-status'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      done(null);
      return;
    }
    const self = child.pid;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), WATCHMAN_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      let clients: WatchmanClient[] | null = null;
      try {
        if (status === 0 && self !== undefined) {
          clients = parseWatchmanClients(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        }
      } catch {}
      done(clients ? clients.filter((client) => client.pid !== self) : null);
    });
  });
}

async function collectWatchmanRoots(
  pid: number,
  progress: boolean,
  operation?: StimContext,
): Promise<WatchmanRootFacts[] | null> {
  const watchman = boundWatchman;
  const paths = parseWatchRoots(await quietly(() => watchman(['watch-list'], operation), operation));
  if (!paths) return null;
  if (progress) phase('daemons', `watchman pid ${pid}: checking ${plural(paths.length, 'root')}`, operation);
  const roots: WatchmanRootFacts[] = [];
  let next = 0;
  const probe = async (): Promise<void> => {
    while (next < paths.length) {
      operation?.signal.throwIfAborted();
      const index = next++;
      const path = paths[index]!;
      const subscriptions = () => quietly(() => watchman(['debug-get-subscriptions', path], operation), operation);
      const triggers = () => quietly(() => watchman(['trigger-list', path], operation), operation);
      const [subscribers, triggered] = operation
        ? [await subscriptions(), await triggers()]
        : await Promise.all([subscriptions(), triggers()]);
      roots[index] = {
        path,
        stale: watchmanRootStaleness(path),
        subscribers: parseSubscriberNames(subscribers),
        triggers: parseTriggerCount(triggered),
      };
    }
  };
  if (operation) await probe();
  else await Promise.all(Array.from({ length: Math.min(ROOT_PROBES_AT_ONCE, paths.length) }, probe));
  return roots;
}

function measureOf(
  pid: number,
  rows: ReadonlyMap<number, HostProcess>,
  footprints: ReadonlyMap<number, number> | null,
): ProcessMeasure {
  const footprint = footprints?.get(pid);
  if (footprint !== undefined) return { bytes: footprint, measure: 'footprint' };
  return { bytes: (rows.get(pid)?.rssKb ?? 0) * 1024, measure: 'rss' };
}

function supervisorPids(): Map<number, string> {
  const supervisors = new Map<number, string>();
  for (const root of Object.keys(loadConfig()?.projects ?? {})) {
    const pid = readPidFile(root);
    if (pid) supervisors.set(pid, root);
  }
  return supervisors;
}

async function readLsof(pids: readonly number[], operation?: StimContext): Promise<Map<number, LsofProcess> | null> {
  if (pids.length === 0) return new Map();
  try {
    return parseLsof(
      await runOperationFile(operation, getExecutor(), 'lsof', ['-n', '-P', '-F', 'pnT', '-p', pids.join(',')], {
        timeoutMs: LSOF_TIMEOUT_MS,
        cwd: operation?.cwd,
        signal: operation?.signal,
      }),
    );
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    // lsof exits 1 when one of the pids has exited; what it printed for the others is still valid. Output cut off by
    // the timeout is not.
    const { status, signal: killed, stdout } = error as { status?: unknown; signal?: unknown; stdout?: unknown };
    return status === 1 && !killed && typeof stdout === 'string' && stdout ? parseLsof(stdout) : null;
  }
}

async function gradleStatus(
  command: GradleDaemonCommand,
  home: string,
  operation?: StimContext,
): Promise<Map<number, string> | { unknown: string }> {
  if (!command.distribution) return { unknown: 'could not find its Gradle distribution on its classpath' };
  const launcher = join(command.distribution, 'bin', 'gradle');
  if (!existsSync(launcher)) return { unknown: `its distribution has no ${launcher}` };
  try {
    const environment = operation ? childEnvironment(operation.env) : { env: {}, omitEnv: [] };
    const output = await runOperationFile(operation, getExecutor(), launcher, ['--status', '-q', '-g', home], {
      ...environment,
      cwd: home,
      env: { ...environment.env, JAVA_HOME: command.javaHome },
      omitEnv: [...environment.omitEnv, 'GRADLE_OPTS', 'JAVA_OPTS'],
      signal: operation?.signal,
      timeoutMs: GRADLE_STATUS_TIMEOUT_MS,
    });
    return parseGradleStatus(output);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    return { unknown: `gradle --status failed: ${(error as Error).message.split('\n')[0]}` };
  }
}

function groupKey(command: GradleDaemonCommand, home: string): string {
  return JSON.stringify([home, command.version, command.distribution, command.javaHome]);
}

async function collectGradleFacts(
  rows: readonly HostProcess[],
  byPid: ReadonlyMap<number, HostProcess>,
  footprints: ReadonlyMap<number, number> | null,
  stimServerRunning: boolean,
  progress: boolean,
  operation?: StimContext,
): Promise<{ gradle: GradleDaemonFacts[]; kotlin: KotlinDaemonFacts[] }> {
  const gradleRows = rows.flatMap((row) => {
    const command = parseGradleDaemonCommand(row.command);
    return command ? [{ row, command }] : [];
  });
  const kotlinRows = rows.filter((row) => isKotlinDaemonCommand(row.command));
  if (gradleRows.length === 0 && kotlinRows.length === 0) return { gradle: [], kotlin: [] };
  if (progress) {
    phase(
      'daemons',
      `checking ${plural(gradleRows.length, 'Gradle daemon')} and ${plural(kotlinRows.length, 'Kotlin daemon')}`,
      operation,
    );
  }
  const lsof = await readLsof(
    [...gradleRows.map(({ row }) => row.pid), ...kotlinRows.map((row) => row.pid)],
    operation,
  );
  const workerRoot = buildWorkerRoot();
  const homes = gradleRows.map(({ row, command }) => {
    const files = lsof?.get(row.pid)?.files;
    return files ? gradleHomeFromFiles(row.pid, command.version, files) : null;
  });
  const offload = gradleRows.map(({ row }, index) => offloadClientOf(row.command, workerRoot, homes[index] ?? null));
  const statuses = new Map<string, Promise<Map<number, string> | { unknown: string }>>();
  for (const [index, { command }] of gradleRows.entries()) {
    const home = homes[index];
    if (offload[index] !== null && stimServerRunning) continue;
    if (home && !statuses.has(groupKey(command, home))) {
      if (progress) phase('daemons', `gradle --status for Gradle ${command.version} in ${home}`, operation);
      const status = gradleStatus(command, home, operation);
      statuses.set(groupKey(command, home), status);
      if (operation) await status;
    }
  }
  const gradle: GradleDaemonFacts[] = [];
  for (const [index, { row, command }] of gradleRows.entries()) {
    const home = homes[index] ?? null;
    let status: GradleDaemonFacts['status'];
    if (offload[index] !== null && stimServerRunning) {
      status = { unknown: 'stim-server manages it' };
    } else if (!home) {
      status = { unknown: lsof ? 'could not find its Gradle user home among its open files' : 'lsof failed' };
    } else {
      const states = await statuses.get(groupKey(command, home))!;
      if (states instanceof Map) {
        const state = states.get(row.pid);
        status = state ? { state } : { unknown: 'gradle --status did not list it' };
      } else {
        status = states;
      }
    }
    gradle.push({
      pid: row.pid,
      startedAt: row.startedAt,
      ...measureOf(row.pid, byPid, footprints),
      command,
      gradleHome: home,
      offloadClient: offload[index] ?? null,
      status,
    });
  }
  const kotlin = kotlinRows.map((row) =>
    Object.assign(measureOf(row.pid, byPid, footprints), {
      pid: row.pid,
      startedAt: row.startedAt,
      peers: lsof?.get(row.pid) ? connectionPeers(row.pid, lsof) : null,
    }),
  );
  return { gradle, kotlin };
}

async function collectWatchmanFacts(
  byPid: ReadonlyMap<number, HostProcess>,
  footprints: ReadonlyMap<number, number> | null,
  progress: boolean,
  operation?: StimContext,
): Promise<WatchmanFacts | null> {
  const pid = parseWatchmanPid(await quietly(() => boundWatchman(['get-pid'], operation), operation));
  if (pid === null) return null;
  const roots = await collectWatchmanRoots(pid, progress, operation);
  const clients = (await watchmanClients(operation))?.filter((client) => client.pid !== pid) ?? null;
  return {
    pid,
    startedAt: byPid.get(pid)?.startedAt ?? null,
    ...measureOf(pid, byPid, footprints),
    roots,
    clients,
  };
}

function watchmanClientDescriber(rows: readonly HostProcess[]): (client: WatchmanClient) => string {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const supervisors = supervisorPids();
  return (client) => {
    const workspace = stimWorkspaceOf(client.pid, parentOf, supervisors);
    return workspace ? `the Stim workspace ${workspace}` : `${client.name ?? 'a client'} (pid ${client.pid})`;
  };
}

export function memorySweepIsScoped(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STIM_HOME);
}

/** The report of a run whose STIM_HOME is set: the helpers are machine-global, so none is inspected or stopped. */
export function scopedMemoryReport(): MemoryReport {
  return {
    processes: [],
    watchmanRoots: [],
    notices: [
      'memory sweep skipped: STIM_HOME scopes this config, but watchman and the Gradle and Kotlin daemons are machine-global',
    ],
  };
}

/**
 * Why memory is not low enough for gc to stop a daemon, or null when it is: macOS memory pressure at
 * `maintenance.memoryPressureLevel` or above, or elsewhere available memory under `maintenance.minAvailableMemoryGb`
 * (10% of RAM when unset). `memoryPressureLevel` off never counts as low.
 */
async function memoryNotLow(operation?: StimContext): Promise<string | null> {
  const settings = resolveMaintenanceSettings();
  if (settings.memoryPressureLevel === 'off') return 'maintenance.memoryPressureLevel is off';
  if (process.platform === 'darwin') {
    const level = await readHostMemoryPressureAsync(undefined, undefined, operation?.signal, operation);
    if (level === 'critical' || (level === 'warning' && settings.memoryPressureLevel === 'warning')) return null;
    return level === null
      ? 'macOS memory pressure could not be read'
      : `macOS memory pressure is ${level}, under maintenance.memoryPressureLevel ${settings.memoryPressureLevel}`;
  }
  const floor =
    settings.minAvailableMemoryGb === undefined ? totalmem() * 0.1 : settings.minAvailableMemoryGb * 1024 ** 3;
  const available = freemem();
  return available < floor ? null : `${formatBytes(available)} of memory is available, at or above ${formatBytes(floor)}`;
}

export async function collectMemoryReport(
  scope: MemoryScope,
  progress = false,
  operation?: StimContext,
): Promise<MemoryReport> {
  const report: MemoryReport = { processes: [], watchmanRoots: [], notices: [] };
  if (process.platform === 'win32') return report;
  const rows = await readHostProcessTableAsync(operation?.signal, operation);
  operation?.signal.throwIfAborted();
  if (rows === null) {
    report.notices.push('memory sweep skipped: ps did not answer');
    return report;
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const footprints = await readFootprints(operation);
  if (scope.watchman) {
    const facts = await collectWatchmanFacts(byPid, footprints, progress, operation);
    if (facts) {
      const plan = planWatchman(facts, watchmanClientDescriber(rows));
      report.processes.push(plan.process);
      report.watchmanRoots = plan.roots;
    } else if (!scope.gradle) {
      report.notices.push('no watchman daemon answered');
    }
  }
  if (scope.gradle) {
    const stimServerRunning = rows.some((row) => STIM_SERVER_COMMAND.test(row.command));
    const facts = await collectGradleFacts(rows, byPid, footprints, stimServerRunning, progress, operation);
    const found = facts.gradle.length > 0 || facts.kotlin.length > 0;
    report.processes.push(
      ...planDaemons({
        ...facts,
        buildRunning: found ? runningBuild(listBuildLocks(), listBuildSlots()) : null,
        memoryOk: found && !scope.anyMemory ? await memoryNotLow(operation) : null,
        stimServerRunning,
      }),
    );
    if (!scope.watchman && report.processes.length === 0) report.notices.push('no Gradle or Kotlin daemon is running');
  }
  return report;
}

function processLabel(entry: MemoryProcess): string {
  if (entry.kind === 'watchman') return `watchman pid ${entry.pid}`;
  if (entry.kind === 'kotlinDaemon') return `Kotlin compile daemon pid ${entry.pid}`;
  const where = entry.offloadClient
    ? `offload client ${entry.offloadClient}`
    : (entry.gradleHome ?? 'unknown Gradle home');
  return `Gradle ${entry.version ?? '?'} daemon pid ${entry.pid} (${where})`;
}

function uptime(startedAt: string | null, now: number): string {
  const at = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(at) ? `up ${formatLongDuration(Math.max(0, now - at))}` : 'uptime unknown';
}

export function memoryLines(
  report: MemoryReport | null | undefined,
  scoped: MemoryCacheKind | null,
  now: number = Date.now(),
): string[] {
  if (!report || (report.processes.length === 0 && report.notices.length === 0)) return [];
  const measure = report.processes.some((entry) => entry.measure === 'rss')
    ? 'footprint, resident size where unreadable'
    : 'physical footprint';
  const lines = [
    `Memory (${measure}) - shared helpers that grow while they run; only --cache watchman or gradle-daemons stops them:`,
  ];
  for (const entry of report.processes) {
    const state = entry.reclaimable
      ? 'idle'
      : entry.kind === 'watchman' && entry.state === 'busy'
        ? 'in use'
        : entry.state;
    lines.push(`  ${processLabel(entry)} ${formatBytes(entry.bytes)}, ${uptime(entry.startedAt, now)}, ${state}`);
    if (entry.kind === 'watchman') {
      const stale = report.watchmanRoots.filter((root) => root.stale !== null).length;
      lines.push(`              ${report.watchmanRoots.length} root(s), ${stale} stale`);
      for (const root of report.watchmanRoots.filter((r) => r.stale !== null)) {
        lines.push(`              stale root ${root.path}: ${root.detail}${root.removable ? '' : '; kept'}`);
      }
    }
    if (entry.detail) lines.push(`              ${entry.reclaimable ? '' : 'kept: '}${entry.detail}`);
  }
  for (const notice of report.notices) lines.push(`  ${notice}`);
  const kinds: MemoryCacheKind[] = scoped ? [scoped] : [WATCHMAN_KIND, GRADLE_DAEMONS_KIND];
  const parts: string[] = [];
  for (const kind of kinds) {
    if (!report.processes.some((entry) => entry.cacheKind === kind)) continue;
    const roots = kind === WATCHMAN_KIND ? report.watchmanRoots.filter((root) => root.removable).length : 0;
    const note = roots ? ` (and ${roots} stale root(s) removed)` : '';
    parts.push(`${formatBytes(reclaimableBytes(report, kind))} with stim gc --delete --cache ${kind}${note}`);
  }
  if (parts.length) lines.push(`  reclaimable ${formatBytes(reclaimableBytes(report))}: ${parts.join('; ')}`);
  return lines;
}

function sameProcess(entry: MemoryProcess, rows: ReadonlyMap<number, HostProcess> | null): boolean {
  const row = rows?.get(entry.pid);
  return Boolean(row && entry.startedAt !== null && row.startedAt === entry.startedAt);
}

function signal(pid: number, abort?: AbortSignal): string | null {
  abort?.throwIfAborted();
  try {
    process.kill(pid, 'SIGTERM');
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : (error as Error).message;
  }
}

function keep(
  output: GcOutput,
  entry: MemoryProcess,
  kind: 'watchman' | 'gradleDaemon' | 'kotlinDaemon',
  detail: string,
): void {
  output.log(chalk.yellow(`Kept ${processLabel(entry)}: ${detail}`));
  output.record(kind, 'kept', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes, detail });
}

async function reclaimWatchman(before: MemoryReport, output: GcOutput, operation?: StimContext): Promise<number> {
  let failures = 0;
  const fresh = await collectMemoryReport({ watchman: true, gradle: false }, true, operation);
  const daemon = fresh.processes.find((entry) => entry.kind === 'watchman');
  const planned = before.processes.find((entry) => entry.kind === 'watchman');
  if (!daemon || !planned || daemon.pid !== planned.pid) {
    if (planned) keep(output, planned, 'watchman', 'the daemon changed or stopped since the report');
    return 0;
  }
  for (const root of fresh.watchmanRoots.filter((r) => r.stale !== null)) {
    operation?.signal.throwIfAborted();
    if (!root.removable) {
      output.log(chalk.yellow(`Kept the watchman root ${root.path}: ${root.detail}`));
      output.record('watchmanRoot', 'kept', root.path, { detail: root.detail });
      continue;
    }
    try {
      phase('daemons', `removing stale watchman root ${root.path}`, operation);
      await boundWatchman(['watch-del', root.path], operation);
      output.log(chalk.green(`Removed the stale watchman root ${root.path} (${root.detail})`));
      output.record('watchmanRoot', 'done', root.path, { detail: root.detail });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      failures++;
      output.log(chalk.red(`Could not remove the watchman root ${root.path}: ${(error as Error).message}`));
      output.record('watchmanRoot', 'failed', root.path, { detail: (error as Error).message });
    }
  }
  const after = await collectMemoryReport({ watchman: true, gradle: false }, true, operation);
  const current = after.processes.find((entry) => entry.kind === 'watchman');
  if (!current || current.pid !== daemon.pid) return failures;
  if (!current.reclaimable) {
    keep(output, current, 'watchman', current.detail ?? 'it could not be proven unused');
    return failures;
  }
  try {
    phase('daemons', `shutting down watchman pid ${current.pid}: no client uses it`, operation);
    await boundWatchman(['shutdown-server'], operation);
    output.log(
      chalk.green(
        `Shut down watchman pid ${current.pid}, freeing ${formatBytes(current.bytes)}; the next client that needs it starts it again`,
      ),
    );
    output.record('watchman', 'done', processLabel(current), { id: String(current.pid), bytes: current.bytes });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    failures++;
    output.log(chalk.red(`Could not shut down watchman pid ${current.pid}: ${(error as Error).message}`));
    output.record('watchman', 'failed', processLabel(current), {
      id: String(current.pid),
      bytes: current.bytes,
      detail: (error as Error).message,
    });
  }
  return failures;
}

function stopKotlin(
  entry: MemoryProcess,
  rows: ReadonlyMap<number, HostProcess> | null,
  output: GcOutput,
  operation?: StimContext,
): number {
  if (!sameProcess(entry, rows)) {
    keep(output, entry, 'kotlinDaemon', 'the process changed or exited since the check');
    return 0;
  }
  const error = signal(entry.pid, operation?.signal);
  if (error) {
    output.log(chalk.red(`Could not stop ${processLabel(entry)}: ${error}`));
    output.record('kotlinDaemon', 'failed', processLabel(entry), {
      id: String(entry.pid),
      bytes: entry.bytes,
      detail: error,
    });
    return 1;
  }
  output.log(chalk.green(`Stopped ${processLabel(entry)}, freeing ${formatBytes(entry.bytes)}`));
  output.record('kotlinDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
  return 0;
}

/**
 * Stops the Gradle daemons a fresh check still finds idle. When every daemon `gradle --status` lists for a home and
 * version is one of them, the daemon's own `gradle --stop` runs for that home; otherwise each idle one gets SIGTERM,
 * because `--stop` also stops the busy daemons of that home and version.
 */
async function stopGradle(
  idle: readonly MemoryProcess[],
  rows: ReadonlyMap<number, HostProcess> | null,
  output: GcOutput,
  operation?: StimContext,
): Promise<number> {
  let failures = 0;
  const groups = new Map<string, MemoryProcess[]>();
  for (const entry of idle) {
    const command = parseGradleDaemonCommand(rows?.get(entry.pid)?.command ?? '');
    if (!command || !entry.gradleHome || !sameProcess(entry, rows)) {
      keep(output, entry, 'gradleDaemon', 'the process changed or exited since the check');
      continue;
    }
    const key = groupKey(command, entry.gradleHome);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, entries] of groups) {
    operation?.signal.throwIfAborted();
    const [home, , distribution, javaHome] = JSON.parse(key) as [string, string, string | null, string];
    const command = parseGradleDaemonCommand(rows!.get(entries[0]!.pid)!.command)!;
    const building = runningBuild(listBuildLocks(), listBuildSlots());
    if (building) {
      for (const entry of entries) keep(output, entry, 'gradleDaemon', building);
      continue;
    }
    phase('daemons', `gradle --status for Gradle ${command.version} in ${home}`, operation);
    let states = await gradleStatus(command, home, operation);
    let current = await hostRows(operation);
    const listed = states instanceof Map ? [...states].filter(([, state]) => state !== 'stopped') : [];
    const whole =
      distribution !== null &&
      listed.length > 0 &&
      listed.every(([pid, state]) => state === 'idle' && entries.some((entry) => entry.pid === pid));
    if (whole) {
      try {
        phase('daemons', `gradle --stop for Gradle ${command.version} in ${home}`, operation);
        await runOperationFile(
          operation,
          getExecutor(),
          join(distribution, 'bin', 'gradle'),
          ['--stop', '-q', '-g', home],
          {
            cwd: home,
            env: { JAVA_HOME: javaHome },
            omitEnv: ['GRADLE_OPTS', 'JAVA_OPTS'],
            timeoutMs: GRADLE_STOP_TIMEOUT_MS,
          },
        );
        for (const entry of entries) {
          output.log(
            chalk.green(`Stopped ${processLabel(entry)} with gradle --stop, freeing ${formatBytes(entry.bytes)}`),
          );
          output.record('gradleDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
        }
        continue;
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        operation?.signal.throwIfAborted();
        output.log(
          chalk.dim(
            `gradle --stop failed for ${home}; signalling each idle daemon: ${(error as Error).message.split('\n')[0]}`,
          ),
        );
        states = await gradleStatus(command, home, operation);
        current = await hostRows(operation);
      }
    }
    for (const entry of entries) {
      const state = states instanceof Map ? states.get(entry.pid) : undefined;
      if (!sameProcess(entry, current)) {
        keep(output, entry, 'gradleDaemon', 'the process changed or exited since the check');
        continue;
      }
      if (state !== 'idle') {
        keep(
          output,
          entry,
          'gradleDaemon',
          state ? `gradle --status now reports it ${state}` : 'gradle --status no longer lists it idle',
        );
        continue;
      }
      const error = signal(entry.pid, operation?.signal);
      if (error) {
        failures++;
        output.log(chalk.red(`Could not stop ${processLabel(entry)}: ${error}`));
        output.record('gradleDaemon', 'failed', processLabel(entry), {
          id: String(entry.pid),
          bytes: entry.bytes,
          detail: error,
        });
        continue;
      }
      output.log(chalk.green(`Stopped ${processLabel(entry)}, freeing ${formatBytes(entry.bytes)}`));
      output.record('gradleDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
    }
  }
  return failures;
}

function stillPlanned(fresh: MemoryReport, before: MemoryReport, kind: MemoryProcess['kind']): MemoryProcess[] {
  const planned = new Map(before.processes.filter((entry) => entry.kind === kind).map((entry) => [entry.pid, entry]));
  return fresh.processes.filter(
    (entry) => entry.kind === kind && planned.get(entry.pid)?.startedAt === entry.startedAt,
  );
}

async function hostRows(operation?: StimContext): Promise<Map<number, HostProcess> | null> {
  const rows = await readHostProcessTableAsync(operation?.signal, operation);
  operation?.signal.throwIfAborted();
  return rows ? new Map(rows.map((row) => [row.pid, row])) : null;
}

const EXIT_WAIT_MS = 10_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForExit(pids: readonly number[], operation?: StimContext): Promise<void> {
  const running = pids.filter(alive);
  if (running.length === 0) return;
  phase(
    'daemons',
    `waiting up to ${EXIT_WAIT_MS / 1000}s for ${plural(running.length, 'Gradle daemon')} to exit: pid ${running.join(', ')}`,
    operation,
  );
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (running.some(alive) && Date.now() < deadline)
    await cancellableSleep(200, { signal: operation?.signal, what: 'GC daemon shutdown' });
}

/** Stops the Gradle daemons first, then re-checks the Kotlin daemons, whose clients those Gradle daemons were. */
async function reclaimDaemons(
  before: MemoryReport,
  output: GcOutput,
  operation?: StimContext,
  anyMemory = false,
): Promise<number> {
  const scope = { watchman: false, gradle: true, anyMemory };
  const gradle = stillPlanned(await collectMemoryReport(scope, true, operation), before, 'gradleDaemon');
  for (const entry of gradle.filter((e) => !e.reclaimable))
    keep(output, entry, 'gradleDaemon', entry.detail ?? 'it could not be proven idle');
  const stopping = gradle.filter((entry) => entry.reclaimable);
  let failures = await stopGradle(stopping, await hostRows(operation), output, operation);
  if (!before.processes.some((entry) => entry.kind === 'kotlinDaemon')) return failures;
  await waitForExit(
    stopping.map((entry) => entry.pid),
    operation,
  );
  const kotlin = stillPlanned(await collectMemoryReport(scope, true, operation), before, 'kotlinDaemon');
  for (const entry of before.processes.filter((e) => e.kind === 'kotlinDaemon' && e.reclaimable)) {
    if (kotlin.some((current) => current.pid === entry.pid) || alive(entry.pid)) continue;
    output.log(
      chalk.green(`${processLabel(entry)} exited with its Gradle daemon, freeing ${formatBytes(entry.bytes)}`),
    );
    output.record('kotlinDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
  }
  const rows = await hostRows(operation);
  for (const entry of kotlin) {
    if (entry.reclaimable) failures += stopKotlin(entry, rows, output, operation);
    else keep(output, entry, 'kotlinDaemon', entry.detail ?? 'it could not be proven idle');
  }
  return failures;
}

/**
 * Stops those of `pids` that `gc --delete --cache gradle-daemons` would stop under low memory, whatever the memory
 * now: never during a Stim build, never a busy daemon or one whose state is unknown. A Kotlin daemon in `pids` stops only when every idle
 * Gradle daemon is in `pids` too, since one left running may still be its client. Nothing stops while STIM_HOME scopes
 * the config.
 */
export async function stopIdleGradleDaemons(pids: readonly number[], output: GcOutput = GC_OUTPUT): Promise<number> {
  if (memorySweepIsScoped()) return 0;
  const report = await collectMemoryReport({ watchman: false, gradle: true, anyMemory: true });
  const wanted = new Set(pids);
  const othersStay = report.processes.some(
    (entry) => entry.kind === 'gradleDaemon' && entry.reclaimable && !wanted.has(entry.pid),
  );
  const processes = report.processes.filter(
    (entry) => wanted.has(entry.pid) && !(entry.kind === 'kotlinDaemon' && othersStay),
  );
  return processes.length ? reclaimDaemons({ ...report, processes }, output, undefined, true) : 0;
}

/** Whether `gc --delete --cache <cache>` would act on a memory kind: stop a process or remove a watchman root. */
export function memoryWorkPending(cache: string | null, report: MemoryReport | null | undefined): boolean {
  if (!memoryCacheKind(cache) || !report) return false;
  return reclaimableBytes(report) > 0 || report.watchmanRoots.some((root) => root.removable);
}

/** Acts on the one memory kind `--cache` names: never on an unscoped run or `--cache all`. */
export async function reclaimMemory(
  cache: string | null,
  report: MemoryReport | null | undefined,
  output: GcOutput = GC_OUTPUT,
  operation?: StimContext,
): Promise<number> {
  operation?.signal.throwIfAborted();
  const kind = memoryCacheKind(cache);
  if (!kind || !report || report.processes.length === 0) return 0;
  return kind === WATCHMAN_KIND
    ? reclaimWatchman(report, output, operation)
    : reclaimDaemons(report, output, operation);
}

/** A doctor note when watchman's footprint is over 2 GiB: only a restart shrinks it, and gc says when one is safe. */
export function watchmanFinding(report: MemoryReport): Finding | null {
  const daemon = report.processes.find((entry) => entry.kind === 'watchman');
  if (!daemon || daemon.bytes < WATCHMAN_DOCTOR_BYTES) return null;
  const stale = report.watchmanRoots.filter((root) => root.stale !== null).length;
  const state = daemon.reclaimable ? 'no client uses it now' : `it is kept: ${daemon.detail}`;
  return {
    level: 'note',
    title: `watchman uses ${formatBytes(daemon.bytes)}`,
    detail:
      `The shared watchman daemon (pid ${daemon.pid}) has a ${formatBytes(daemon.bytes)} ${daemon.measure} with ` +
      `${report.watchmanRoots.length} watched root(s), ${stale} of them stale; ${state}. Removing roots stops their ` +
      'recrawls, but only a restart returns the memory.',
    fix: 'Run `stim gc --cache watchman` to see its roots and clients, then `stim gc --delete --cache watchman` once no workspace uses it.',
  };
}

export async function inspectWatchmanMemory(
  env: NodeJS.ProcessEnv = process.env,
  operation?: StimContext,
): Promise<Finding | null> {
  if (process.platform === 'win32' || memorySweepIsScoped(env)) return null;
  return watchmanFinding(await collectMemoryReport({ watchman: true, gradle: false }, false, operation));
}
