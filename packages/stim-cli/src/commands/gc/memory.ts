import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import chalk from 'chalk';
import { buildWorkerRoot, loadConfig } from '@stim-cli/core/state';
import { formatLongDuration } from '../../command-output.ts';
import { createDeviceProcessTables, type HostProcess } from '../../devices/activity.ts';
import { listBuildLocks, type BuildLockInfo } from '../../engine/build-lock.ts';
import { listBuildSlots, type BuildSlotInfo } from '../../engine/build-slots.ts';
import { getExecutor } from '../../exec.ts';
import { readFootprints } from '../../footprint.ts';
import { formatBytes, isOnMountedVolume } from '../../fs-util.ts';
import { STIM_SERVER_COMMAND } from '../../machine-usage.ts';
import { readPidFile } from '../../supervisor/state.ts';
import {
  parseSubscriberNames,
  parseTriggerCount,
  parseWatchmanClients,
  parseWatchmanPid,
  parseWatchRoots,
  type WatchmanClient,
} from '../../watchman.ts';
import type { Finding } from '../../diagnostics/doctor.ts';
import { recordGcResult } from './results.ts';

export const WATCHMAN_KIND = 'watchman';
export const GRADLE_DAEMONS_KIND = 'gradle-daemons';
export type MemoryCacheKind = typeof WATCHMAN_KIND | typeof GRADLE_DAEMONS_KIND;

export interface MemoryScope {
  watchman: boolean;
  gradle: boolean;
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

export type MemoryKeptCode = 'in-use' | 'busy' | 'unknown' | 'build-running' | 'stim-server';

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
 * Decides which Gradle and Kotlin daemons gc may stop. A running Stim build (`buildRunning`) keeps every one. An
 * offload worker's daemon is left to stim-server while it runs. A Gradle daemon goes only when its own `gradle
 * --status` says IDLE. A Kotlin daemon goes only when every Gradle daemon is idle and each of its connections comes from
 * a Gradle daemon gc stops in the same run.
 */
export function planDaemons({
  gradle,
  kotlin,
  buildRunning,
  stimServerRunning,
}: {
  gradle: readonly GradleDaemonFacts[];
  kotlin: readonly KotlinDaemonFacts[];
  buildRunning: string | null;
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
      detail = `stim-server stops the daemons of offload client ${daemon.offloadClient} when that client loses build or memory runs low`;
    } else if (buildRunning) {
      reason = 'build-running';
      detail = buildRunning;
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

/** A watchman client's pid resolved to the Stim workspace whose supervisor it is or descends from. */
export function stimWorkspaceOf(
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

export function reclaimableBytes(report: MemoryReport, kind?: MemoryCacheKind): number {
  return report.processes
    .filter((entry) => entry.reclaimable && (kind === undefined || entry.cacheKind === kind))
    .reduce((sum, entry) => sum + entry.bytes, 0);
}

type BoundWatchman = (args: string[]) => Promise<unknown>;

const boundWatchman: BoundWatchman = async (args) =>
  JSON.parse(await getExecutor().runFileAsync('watchman', ['--no-spawn', ...args], { timeoutMs: WATCHMAN_TIMEOUT_MS }));

async function quietly<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * `watchman debug-status` with gc's own call left out of its clients. The call is spawned directly so its pid is
 * known: debug-status lists the asking CLI as a client too.
 */
function watchmanClients(): Promise<WatchmanClient[] | null> {
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

async function collectWatchmanRoots(): Promise<WatchmanRootFacts[] | null> {
  const watchman = boundWatchman;
  const paths = parseWatchRoots(await quietly(() => watchman(['watch-list'])));
  if (!paths) return null;
  const roots: WatchmanRootFacts[] = [];
  for (const path of paths) {
    roots.push({
      path,
      stale: watchmanRootStaleness(path),
      subscribers: parseSubscriberNames(await quietly(() => watchman(['debug-get-subscriptions', path]))),
      triggers: parseTriggerCount(await quietly(() => watchman(['trigger-list', path]))),
    });
  }
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

async function readLsof(pids: readonly number[]): Promise<Map<number, LsofProcess> | null> {
  if (pids.length === 0) return new Map();
  try {
    return parseLsof(
      await getExecutor().runFileAsync('lsof', ['-n', '-P', '-F', 'pnT', '-p', pids.join(',')], {
        timeoutMs: LSOF_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    // lsof exits 1 when one of the pids has exited; what it printed for the others is still valid. Output cut off by
    // the timeout is not.
    const { status, signal: killed, stdout } = error as { status?: unknown; signal?: unknown; stdout?: unknown };
    return status === 1 && !killed && typeof stdout === 'string' && stdout ? parseLsof(stdout) : null;
  }
}

async function gradleStatus(
  command: GradleDaemonCommand,
  home: string,
): Promise<Map<number, string> | { unknown: string }> {
  if (!command.distribution) return { unknown: 'could not find its Gradle distribution on its classpath' };
  const launcher = join(command.distribution, 'bin', 'gradle');
  if (!existsSync(launcher)) return { unknown: `its distribution has no ${launcher}` };
  try {
    const output = await getExecutor().runFileAsync(launcher, ['--status', '-q', '-g', home], {
      cwd: home,
      env: { JAVA_HOME: command.javaHome },
      omitEnv: ['GRADLE_OPTS', 'JAVA_OPTS'],
      timeoutMs: GRADLE_STATUS_TIMEOUT_MS,
    });
    return parseGradleStatus(output);
  } catch (error) {
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
): Promise<{ gradle: GradleDaemonFacts[]; kotlin: KotlinDaemonFacts[] }> {
  const gradleRows = rows.flatMap((row) => {
    const command = parseGradleDaemonCommand(row.command);
    return command ? [{ row, command }] : [];
  });
  const kotlinRows = rows.filter((row) => isKotlinDaemonCommand(row.command));
  if (gradleRows.length === 0 && kotlinRows.length === 0) return { gradle: [], kotlin: [] };
  const lsof = await readLsof([...gradleRows.map(({ row }) => row.pid), ...kotlinRows.map((row) => row.pid)]);
  const workerRoot = buildWorkerRoot();
  const homes = gradleRows.map(({ row, command }) => {
    const files = lsof?.get(row.pid)?.files;
    return files ? gradleHomeFromFiles(row.pid, command.version, files) : null;
  });
  const offload = gradleRows.map(({ row }, index) => offloadClientOf(row.command, workerRoot, homes[index] ?? null));
  const statuses = new Map<string, Promise<Map<number, string> | { unknown: string }>>();
  gradleRows.forEach(({ command }, index) => {
    const home = homes[index];
    if (offload[index] !== null && stimServerRunning) return;
    if (home && !statuses.has(groupKey(command, home)))
      statuses.set(groupKey(command, home), gradleStatus(command, home));
  });
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
): Promise<WatchmanFacts | null> {
  const pid = parseWatchmanPid(await quietly(() => boundWatchman(['get-pid'])));
  if (pid === null) return null;
  const roots = await collectWatchmanRoots();
  const clients = (await watchmanClients())?.filter((client) => client.pid !== pid) ?? null;
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

export function memorySweepIsScoped(): boolean {
  return Boolean(process.env.STIM_HOME);
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

export async function collectMemoryReport(scope: MemoryScope): Promise<MemoryReport> {
  const report: MemoryReport = { processes: [], watchmanRoots: [], notices: [] };
  if (process.platform === 'win32') return report;
  const rows = createDeviceProcessTables().host();
  if (rows === null) {
    report.notices.push('memory sweep skipped: ps did not answer');
    return report;
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const footprints = await readFootprints();
  if (scope.watchman) {
    const facts = await collectWatchmanFacts(byPid, footprints);
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
    const facts = await collectGradleFacts(rows, byPid, footprints, stimServerRunning);
    report.processes.push(
      ...planDaemons({
        ...facts,
        buildRunning:
          facts.gradle.length || facts.kotlin.length ? runningBuild(listBuildLocks(), listBuildSlots()) : null,
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
  return Boolean(row && row.startedAt === entry.startedAt);
}

function signal(pid: number): string | null {
  try {
    process.kill(pid, 'SIGTERM');
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : (error as Error).message;
  }
}

function keep(entry: MemoryProcess, kind: 'watchman' | 'gradleDaemon' | 'kotlinDaemon', detail: string): void {
  console.log(chalk.yellow(`Kept ${processLabel(entry)}: ${detail}`));
  recordGcResult(kind, 'kept', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes, detail });
}

async function reclaimWatchman(before: MemoryReport): Promise<number> {
  let failures = 0;
  const fresh = await collectMemoryReport({ watchman: true, gradle: false });
  const daemon = fresh.processes.find((entry) => entry.kind === 'watchman');
  const planned = before.processes.find((entry) => entry.kind === 'watchman');
  if (!daemon || !planned || daemon.pid !== planned.pid) {
    if (planned) keep(planned, 'watchman', 'the daemon changed or stopped since the report');
    return 0;
  }
  for (const root of fresh.watchmanRoots.filter((r) => r.stale !== null)) {
    if (!root.removable) {
      console.log(chalk.yellow(`Kept the watchman root ${root.path}: ${root.detail}`));
      recordGcResult('watchmanRoot', 'kept', root.path, { detail: root.detail });
      continue;
    }
    try {
      await boundWatchman(['watch-del', root.path]);
      console.log(chalk.green(`Removed the stale watchman root ${root.path} (${root.detail})`));
      recordGcResult('watchmanRoot', 'done', root.path, { detail: root.detail });
    } catch (error) {
      failures++;
      console.log(chalk.red(`Could not remove the watchman root ${root.path}: ${(error as Error).message}`));
      recordGcResult('watchmanRoot', 'failed', root.path, { detail: (error as Error).message });
    }
  }
  const after = await collectMemoryReport({ watchman: true, gradle: false });
  const current = after.processes.find((entry) => entry.kind === 'watchman');
  if (!current || current.pid !== daemon.pid) return failures;
  if (!current.reclaimable) {
    keep(current, 'watchman', current.detail ?? 'it could not be proven unused');
    return failures;
  }
  try {
    await boundWatchman(['shutdown-server']);
    console.log(
      chalk.green(
        `Shut down watchman pid ${current.pid}, freeing ${formatBytes(current.bytes)}; the next client that needs it starts it again`,
      ),
    );
    recordGcResult('watchman', 'done', processLabel(current), { id: String(current.pid), bytes: current.bytes });
  } catch (error) {
    failures++;
    console.log(chalk.red(`Could not shut down watchman pid ${current.pid}: ${(error as Error).message}`));
    recordGcResult('watchman', 'failed', processLabel(current), {
      id: String(current.pid),
      bytes: current.bytes,
      detail: (error as Error).message,
    });
  }
  return failures;
}

function stopKotlin(entry: MemoryProcess, rows: ReadonlyMap<number, HostProcess> | null): number {
  if (!sameProcess(entry, rows)) {
    keep(entry, 'kotlinDaemon', 'the process changed or exited since the check');
    return 0;
  }
  const error = signal(entry.pid);
  if (error) {
    console.log(chalk.red(`Could not stop ${processLabel(entry)}: ${error}`));
    recordGcResult('kotlinDaemon', 'failed', processLabel(entry), {
      id: String(entry.pid),
      bytes: entry.bytes,
      detail: error,
    });
    return 1;
  }
  console.log(chalk.green(`Stopped ${processLabel(entry)}, freeing ${formatBytes(entry.bytes)}`));
  recordGcResult('kotlinDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
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
): Promise<number> {
  let failures = 0;
  const groups = new Map<string, MemoryProcess[]>();
  for (const entry of idle) {
    const command = parseGradleDaemonCommand(rows?.get(entry.pid)?.command ?? '');
    if (!command || !entry.gradleHome || !sameProcess(entry, rows)) {
      keep(entry, 'gradleDaemon', 'the process changed or exited since the check');
      continue;
    }
    const key = groupKey(command, entry.gradleHome);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, entries] of groups) {
    const [home, , distribution, javaHome] = JSON.parse(key) as [string, string, string | null, string];
    const command = parseGradleDaemonCommand(rows!.get(entries[0]!.pid)!.command)!;
    const building = runningBuild(listBuildLocks(), listBuildSlots());
    if (building) {
      for (const entry of entries) keep(entry, 'gradleDaemon', building);
      continue;
    }
    let states = await gradleStatus(command, home);
    let current = rows;
    const listed = states instanceof Map ? [...states].filter(([, state]) => state !== 'stopped') : [];
    const whole =
      distribution !== null &&
      listed.length > 0 &&
      listed.every(([pid, state]) => state === 'idle' && entries.some((entry) => entry.pid === pid));
    if (whole) {
      try {
        await getExecutor().runFileAsync(join(distribution, 'bin', 'gradle'), ['--stop', '-q', '-g', home], {
          cwd: home,
          env: { JAVA_HOME: javaHome },
          omitEnv: ['GRADLE_OPTS', 'JAVA_OPTS'],
          timeoutMs: GRADLE_STOP_TIMEOUT_MS,
        });
        for (const entry of entries) {
          console.log(
            chalk.green(`Stopped ${processLabel(entry)} with gradle --stop, freeing ${formatBytes(entry.bytes)}`),
          );
          recordGcResult('gradleDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
        }
        continue;
      } catch (error) {
        console.log(
          chalk.dim(
            `gradle --stop failed for ${home}; signalling each idle daemon: ${(error as Error).message.split('\n')[0]}`,
          ),
        );
        states = await gradleStatus(command, home);
        current = hostRows();
      }
    }
    for (const entry of entries) {
      const state = states instanceof Map ? states.get(entry.pid) : undefined;
      if (!sameProcess(entry, current)) {
        keep(entry, 'gradleDaemon', 'the process changed or exited since the check');
        continue;
      }
      if (state !== 'idle') {
        keep(
          entry,
          'gradleDaemon',
          state ? `gradle --status now reports it ${state}` : 'gradle --status no longer lists it idle',
        );
        continue;
      }
      const error = signal(entry.pid);
      if (error) {
        failures++;
        console.log(chalk.red(`Could not stop ${processLabel(entry)}: ${error}`));
        recordGcResult('gradleDaemon', 'failed', processLabel(entry), {
          id: String(entry.pid),
          bytes: entry.bytes,
          detail: error,
        });
        continue;
      }
      console.log(chalk.green(`Stopped ${processLabel(entry)}, freeing ${formatBytes(entry.bytes)}`));
      recordGcResult('gradleDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
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

function hostRows(): Map<number, HostProcess> | null {
  const rows = createDeviceProcessTables().host();
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

async function waitForExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
}

/** Stops the Gradle daemons first, then re-checks the Kotlin daemons, whose clients those Gradle daemons were. */
async function reclaimDaemons(before: MemoryReport): Promise<number> {
  const scope = { watchman: false, gradle: true };
  const gradle = stillPlanned(await collectMemoryReport(scope), before, 'gradleDaemon');
  for (const entry of gradle.filter((e) => !e.reclaimable))
    keep(entry, 'gradleDaemon', entry.detail ?? 'it could not be proven idle');
  const stopping = gradle.filter((entry) => entry.reclaimable);
  let failures = await stopGradle(stopping, hostRows());
  if (!before.processes.some((entry) => entry.kind === 'kotlinDaemon')) return failures;
  await waitForExit(stopping.map((entry) => entry.pid));
  const kotlin = stillPlanned(await collectMemoryReport(scope), before, 'kotlinDaemon');
  for (const entry of before.processes.filter((e) => e.kind === 'kotlinDaemon' && e.reclaimable)) {
    if (kotlin.some((current) => current.pid === entry.pid) || alive(entry.pid)) continue;
    console.log(
      chalk.green(`${processLabel(entry)} exited with its Gradle daemon, freeing ${formatBytes(entry.bytes)}`),
    );
    recordGcResult('kotlinDaemon', 'done', processLabel(entry), { id: String(entry.pid), bytes: entry.bytes });
  }
  const rows = hostRows();
  for (const entry of kotlin) {
    if (entry.reclaimable) failures += stopKotlin(entry, rows);
    else keep(entry, 'kotlinDaemon', entry.detail ?? 'it could not be proven idle');
  }
  return failures;
}

/** Whether `gc --delete --cache <cache>` would act on a memory kind: stop a process or remove a watchman root. */
export function memoryWorkPending(cache: string | null, report: MemoryReport | null | undefined): boolean {
  if (!memoryCacheKind(cache) || !report) return false;
  return reclaimableBytes(report) > 0 || report.watchmanRoots.some((root) => root.removable);
}

/** Acts on the one memory kind `--cache` names: never on an unscoped run or `--cache all`. */
export async function reclaimMemory(cache: string | null, report: MemoryReport | null | undefined): Promise<number> {
  const kind = memoryCacheKind(cache);
  if (!kind || !report || report.processes.length === 0) return 0;
  return kind === WATCHMAN_KIND ? reclaimWatchman(report) : reclaimDaemons(report);
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

export async function inspectWatchmanMemory(): Promise<Finding | null> {
  if (process.platform === 'win32' || memorySweepIsScoped()) return null;
  return watchmanFinding(await collectMemoryReport({ watchman: true, gradle: false }));
}
