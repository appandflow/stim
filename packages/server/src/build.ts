import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, posix, win32 } from 'node:path';
import {
  clearFreeClaimSet,
  processGroupAlive,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import {
  buildWorkerRoot,
  isJsonObject,
  liveOffloadedClients,
  windowsShortDir,
  windowsShortDirKey,
  workerAreaMaxAgeDays,
} from '@stim-cli/core/state';
import { readAvailableMemory } from './machine.ts';
import { listCommandLines } from './processes.ts';
import {
  areaLastUsed,
  areasToEvict,
  measureTreeBytes,
  evictionOf,
  notRealDirectory,
  readRootUsage,
  readWorkerRecord,
  recordRootUsage,
  type AreaEviction,
  type DiskSpace,
  type Eviction,
  type WorkerArea,
  type WorkerRootUsage,
} from './worker-areas.ts';
import { BUILD_REPO_PATTERN, type BuildToolchain } from './protocol.ts';

export { readAvailableMemory } from './machine.ts';
export { listCommandLines } from './processes.ts';
export { notRealDirectory, readWorkerRecord, recordAreaUse } from './worker-areas.ts';
export { appendAudit } from './actions.ts';
export { signalChild } from './stim-command.ts';

export interface BuildLimits {
  /** Free bytes the worker root's volume must keep for a build to start there. */
  minFreeBytes: number;
  /** Sum of the declared file sizes one manifest may hold. */
  maxManifestBytes: number;
  timeoutMs: number;
  killGraceMs: number;
  /** How long a build whose connection dropped keeps running for a new connection to attach to it. */
  detachGraceMs: number;
  /** How long a toolchain report is reused before `build.offer` asks the toolchain again. */
  toolchainTtlMs: number;
  /** Available memory below which the idle Gradle daemons of offloaded builds are stopped. */
  minFreeMemoryBytes: number;
  /** How often the idle Gradle daemons of offloaded builds are checked. */
  daemonSweepMs: number;
  /** How long a fetched macOS bundle stays here for a hosted session on this machine to take. */
  handoffMs: number;
  /** Free bytes above `minFreeBytes` under which the least recently used repository areas are evicted. */
  evictionMarginBytes: number;
  /** How long since its last use an area stays safe from eviction for space while the volume is above `minFreeBytes`. */
  evictionRecentMs: number;
  /** How often unused repository areas are looked for while the volume is above that margin. */
  areaSweepMs: number;
  /** How often the worker root's size is measured. */
  rootMeasureMs: number;
}

export const DEFAULT_BUILD_LIMITS: BuildLimits = {
  minFreeBytes: 10 * 1024 ** 3,
  maxManifestBytes: 20 * 1024 ** 3,
  timeoutMs: 60 * 60_000,
  killGraceMs: 5000,
  detachGraceMs: 5 * 60_000,
  toolchainTtlMs: 60_000,
  minFreeMemoryBytes: 2 * 1024 ** 3,
  daemonSweepMs: 60_000,
  handoffMs: 10 * 60_000,
  evictionMarginBytes: 40 * 1024 ** 3,
  evictionRecentMs: 3 * 60 * 60_000,
  areaSweepMs: 15 * 60_000,
  rootMeasureMs: 6 * 60 * 60_000,
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const EVICTED_DIR = 'evicted';
const HANDOFFS_DIR = 'handoffs';
const HANDOFF_TOKEN = /^[0-9a-f]{64}$/;

export const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Free bytes for builds under `root`; on Windows also on the drive that holds `windowsShortDir`s, whichever is less. */
export function workerFreeBytes(root: string): number | null {
  const free = [root, ...(process.platform === 'win32' ? [dirname(dirname(windowsShortDir(root)))] : [])]
    .map(freeBytes)
    .filter((bytes) => bytes !== null);
  return free.length ? Math.min(...free) : null;
}

export const GRADLE_DAEMON = 'org.gradle.launcher.daemon.bootstrap.GradleDaemon';

/** An area's Gradle home, shortened on Windows for the NDK's path limit. */
export function gradleUserHome(area: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? windowsShortDir(win32.join(area, 'cache', 'gradle')) : join(area, 'cache', 'gradle');
}

export function ownsWindowsGradleHome(area: string): boolean {
  try {
    return readFileSync(`${gradleUserHome(area, 'win32')}.owner`, 'utf8') === windowsShortDirKey('gradle', area);
  } catch {
    return false;
  }
}

interface GradleScope {
  client: string;
  repo?: string;
}

/**
 * Identifies worker Gradle homes on daemon classpaths. Windows also includes Kotlin processes whose open jars
 * prevent home deletion, and needs the known areas because short homes are outside the worker root.
 */
export function workerGradleDaemons(
  ps: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  areas: readonly GradleScope[] = [],
): Array<GradleScope & { pid: number }> {
  const home = new RegExp(
    `${posix.resolve(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/\\s]+)/(?:repos/([^/\\s]+)/)?cache/gradle/`,
  );
  const windowsHomes = areas.map((scope) => ({
    ...scope,
    home: `${gradleUserHome(win32.join(root, scope.client, ...(scope.repo ? ['repos', scope.repo] : [])), platform).toLowerCase()}\\`,
  }));
  const daemons: Array<GradleScope & { pid: number }> = [];
  for (const line of ps.split(/\r?\n/)) {
    const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
    if (!pid || !command) continue;
    let scope: GradleScope | undefined;
    if (platform === 'win32') {
      const matched = windowsHomes.find((each) => command.toLowerCase().includes(each.home));
      if (matched) scope = { client: matched.client, ...(matched.repo ? { repo: matched.repo } : {}) };
    } else if (command.includes(GRADLE_DAEMON) || command.includes('KotlinCompileDaemon')) {
      const matched = home.exec(command);
      if (matched?.[1]) scope = { client: matched[1], ...(matched[2] ? { repo: matched[2] } : {}) };
    }
    if (scope) daemons.push({ pid: Number(pid), ...scope });
  }
  return daemons;
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const areaKey = (client: string, repo: string): string => `${client}/${repo}`;

async function deletionFailure(dir: string): Promise<string | null> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
    return null;
  } catch (error) {
    return String(error);
  }
}

export function unknownGradleProcess(home: string, known: ReadonlySet<number>): Error | null {
  const homes = [home];
  if (existsSync(home))
    homes.push(
      ...readdirSync(home)
        .filter((name) => /^n[a-f0-9]{12}$/.test(name))
        .map((name) => join(home, name)),
    );
  for (const directory of homes) {
    const logs = join(directory, 'daemon');
    if (!existsSync(logs)) continue;
    for (const version of readdirSync(logs, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      for (const log of readdirSync(join(logs, version.name))) {
        const pid = Number(/^daemon-(\d+)\.out\.log$/.exec(log)?.[1]);
        if (!pid || known.has(pid)) continue;
        if (processGroupAlive(pid)) return new Error(`Gradle process ${pid} may still use ${directory}.`);
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') continue;
          throw error;
        }
        return new Error(`Gradle process ${pid} may still use ${directory}.`);
      }
    }
  }
  return null;
}

/**
 * Windows has no process groups, and Node's SIGTERM there is TerminateProcess on the one process, so the build's
 * Gradle and Java children are reached only through `taskkill /T`, which is always forceful.
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 30_000 }, () => resolve());
  });
}

/** Runs an offload worker's `offer` mode, `<node> ...command`, and resolves the toolchain it reports, or null. */
export function probeToolchain(command: readonly string[], env: NodeJS.ProcessEnv): Promise<BuildToolchain | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, command, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      let report: unknown = null;
      try {
        report = JSON.parse(out);
      } catch {}
      resolve(isJsonObject(report) ? (report as unknown as BuildToolchain) : null);
    });
  });
}

/** A bundle an offload job kept after its client fetched it, for a hosted session on this machine to take. */
export interface Handoff {
  repo: string;
  /** The job's output directory, deleted with the record. */
  dir: string;
  bundle: string;
  sha256: string;
  expiresAt: number;
}

const handoffRecord = (clientDir: string, token: string): string => join(clientDir, HANDOFFS_DIR, `${token}.json`);

/** Records `handoff` under a new single-use token, which this returns. */
export function writeHandoff(clientDir: string, handoff: Handoff): string {
  const token = randomBytes(32).toString('hex');
  const record = handoffRecord(clientDir, token);
  mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
  writeFileSync(`${record}.tmp`, JSON.stringify(handoff), { mode: 0o600 });
  renameSync(`${record}.tmp`, record);
  return token;
}

/** The bundle kept under `token`, or null when there is none or its record names a path outside its area. */
export function readHandoff(clientDir: string, token: string): Handoff | null {
  try {
    const value: unknown = JSON.parse(readFileSync(handoffRecord(clientDir, token), 'utf8'));
    if (
      isJsonObject(value) &&
      typeof value.repo === 'string' &&
      typeof value.dir === 'string' &&
      typeof value.bundle === 'string' &&
      typeof value.sha256 === 'string' &&
      typeof value.expiresAt === 'number' &&
      dirname(value.bundle) === value.dir &&
      dirname(value.dir) === join(clientDir, 'repos', value.repo, 'out')
    )
      return value as unknown as Handoff;
  } catch {}
  return null;
}

/** The tokens of the bundles kept under `clientDir`. */
export function handoffTokens(clientDir: string): string[] {
  try {
    return readdirSync(join(clientDir, HANDOFFS_DIR))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((token) => HANDOFF_TOKEN.test(token));
  } catch {
    return [];
  }
}

/** Deletes a kept bundle and its record, the record last. */
export function dropHandoff(clientDir: string, token: string): void {
  const handoff = readHandoff(clientDir, token);
  if (handoff) rmSync(handoff.dir, { recursive: true, force: true });
  rmSync(handoffRecord(clientDir, token), { force: true });
}

/** The repositories whose areas an offload job of a client uses now. */
export interface LiveJob {
  client: string;
  repo: string;
}

export interface BuildWorkerRootOptions {
  limits?: Partial<BuildLimits>;
  /** Whether a client still holds `build`; the Gradle daemons of one that does not are stopped. */
  allowed?: (client: string) => boolean;
  /** Whether the periodic daemon sweep may read the Stim home yet; it runs unconditionally when absent. */
  ready?: () => boolean;
  /** The offload jobs running now. */
  jobs: () => Iterable<LiveJob>;
  /** Ends the offload jobs of `client`, resolving once each has exited. */
  stopJobs: (client: string) => Promise<void>;
}

/**
 * The worker root of the builds other machines run here: each client's areas, blobs and kept bundles, which the
 * offload jobs use while they run. Evicts unused areas, removes a client's areas once it loses `build`, and stops the
 * Gradle daemons offloaded builds left.
 */
export class BuildWorkerRoot {
  readonly limits: BuildLimits;
  private readonly served = new Set<string>();
  private readonly removals = new Map<string, Promise<void>>();
  private closed = false;
  private draining: string | null = null;
  private readonly options: BuildWorkerRootOptions;
  private sweeping: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private readonly forced = new Set<string>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly pins = new Map<string, number>();
  private readonly areaRefusals = new Map<string, string>();
  private readonly reported = new Map<string, string>();
  private readonly recoveries = new Map<string, Promise<unknown>>();
  private reportedLow = false;
  private evicting: Promise<void> | null = null;
  private lastEviction = 0;
  private lastMeasure = 0;
  private readonly closing = new AbortController();
  private rootUsage: WorkerRootUsage | null = null;

  constructor(options: BuildWorkerRootOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_BUILD_LIMITS, ...options.limits };
    this.sweeper = setInterval(() => {
      if (this.options.ready?.() ?? true) void this.sweepDaemons();
      this.maintainAreas();
    }, this.limits.daemonSweepMs);
    this.sweeper.unref();
  }

  /** Records that a job of `client` ran here, so a revocation of `client` deletes its areas. */
  serve(client: string): void {
    this.served.add(client);
  }

  /** Why this machine takes no new offload job now, or null. */
  get drained(): string | null {
    return this.draining;
  }

  /** Whether `client`'s areas are being removed, so it takes no new job. */
  removing(client: string): boolean {
    return this.removals.has(client);
  }

  /**
   * Stops the Gradle daemons that offloaded Android builds left warm, except those of a client with a running job:
   * every one while no job runs and available memory is under `minFreeMemoryBytes`, and those of a client that lost `build` or that
   * is `client`. Calls made while a sweep is queued join it. A daemon leaves its build's process group, so no claim or slot tracks it. A daemon whose Gradle home
   * is deleted stops itself: Gradle expires a daemon once its registry file is gone.
   */
  sweepDaemons(client: string | null = null): Promise<void> {
    if (client !== null) this.forced.add(client);
    this.queued ??= this.sweeping
      .then(() => {
        this.queued = null;
        const forced = new Set(this.forced);
        this.forced.clear();
        return this.sweep(forced);
      })
      .catch((error: unknown) =>
        console.error(`stim-server: could not check the Gradle daemons of offloaded builds: ${String(error)}`),
      );
    this.sweeping = this.queued;
    return this.queued;
  }

  private async sweep(forced: ReadonlySet<string>): Promise<void> {
    if (this.closed) return;
    const available = await readAvailableMemory();
    const low = available !== null && available < this.limits.minFreeMemoryBytes;
    let clients: string[] = [];
    if (process.platform === 'win32') {
      try {
        clients = readdirSync(this.root());
      } catch {}
    }
    const daemons = workerGradleDaemons(
      await listCommandLines().catch(() => ''),
      this.root(),
      process.platform,
      clients.flatMap((client) => this.gradleScopes(client)),
    );
    const busy = new Set(liveOffloadedClients());
    for (const daemon of daemons) {
      if (busy.has(daemon.client)) continue;
      if ((!low || busy.size > 0) && !forced.has(daemon.client) && (this.options.allowed?.(daemon.client) ?? true))
        continue;
      try {
        process.kill(daemon.pid, 'SIGTERM');
      } catch {}
    }
  }

  private gradleScopes(client: string): GradleScope[] {
    const clientDir = this.clientDir(client);
    if (notRealDirectory(clientDir)) return [];
    const scopes: GradleScope[] = [{ client }];
    const repos = join(clientDir, 'repos');
    try {
      if (!notRealDirectory(repos)) {
        for (const entry of readdirSync(repos, { withFileTypes: true })) {
          if (entry.isDirectory() && new RegExp(BUILD_REPO_PATTERN).test(entry.name))
            scopes.push({ client, repo: entry.name });
        }
      }
    } catch {}
    return process.platform === 'win32'
      ? scopes.filter((scope) =>
          ownsWindowsGradleHome(
            scope.repo ? join(this.clientDir(client), 'repos', scope.repo) : this.clientDir(client),
          ),
        )
      : scopes;
  }

  root(): string {
    return buildWorkerRoot();
  }

  clientDir(client: string): string {
    return join(this.root(), client);
  }

  /** Refuses new offload jobs with `reason` while it is set. */
  drain(reason: string | null): void {
    this.draining = reason;
  }

  /** Why the worker root's volume cannot take `bytes` more, or null when it can. */
  lowDisk(bytes = 0): string | null {
    const free = workerFreeBytes(this.root());
    return free !== null && free - bytes < this.limits.minFreeBytes
      ? `${gb(free)} GB free, builds need ${gb(this.limits.minFreeBytes)} GB`
      : null;
  }

  /** Deletes the blobs of `client` that no `mirror.json` of its repositories references, unless a job of that client runs. */
  pruneBlobs(client: string): void {
    if ([...this.options.jobs()].some((job) => job.client === client)) return;
    const keep = new Set<string>();
    try {
      const clientDir = this.clientDir(client);
      const repos = join(clientDir, 'repos');
      const blobs = join(clientDir, 'blobs');
      if ([clientDir, repos, blobs].some(notRealDirectory)) return;
      for (const repo of readdirSync(repos, { withFileTypes: true })) {
        if (!repo.isDirectory()) continue;
        const mirror = readWorkerRecord(join(repos, repo.name, 'mirror.json'));
        if (mirror === null) continue;
        const record: unknown = JSON.parse(mirror);
        if (typeof record !== 'object' || record === null) throw new Error('unreadable mirror record');
        for (const entry of Object.values(record)) {
          if (typeof entry?.sha256 !== 'string') throw new Error('unreadable mirror record');
          keep.add(entry.sha256);
        }
      }
      for (const prefix of readdirSync(blobs, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
        for (const blob of readdirSync(join(blobs, prefix.name), { withFileTypes: true })) {
          if (blob.isFile() && /^[0-9a-f]{64}$/.test(blob.name) && !keep.has(blob.name))
            rmSync(join(blobs, prefix.name, blob.name), { force: true });
        }
      }
    } catch {}
  }

  /** Cancels the builds of `client`, a client that lost `build`, and deletes its area once they end. */
  remove(client: string): Promise<void> {
    if (!client || client === '.' || client === '..' || basename(client) !== client) return Promise.resolve();
    const pending = this.removals.get(client);
    if (pending) return pending;
    const removal = this.removeClient(client)
      .catch((error: unknown) => console.error(`stim-server: retaining the build area of ${client}: ${String(error)}`))
      .finally(() => this.removals.delete(client));
    this.removals.set(client, removal);
    return removal;
  }

  private async removeClient(client: string): Promise<void> {
    await this.options.stopJobs(client);
    const clientDir = this.clientDir(client);
    for (const token of handoffTokens(clientDir)) dropHandoff(clientDir, token);
    if (notRealDirectory(clientDir)) {
      await this.removeDir(client, clientDir);
      return;
    }
    if (!(await this.resumeEvicted(client))) {
      console.error(`stim-server: retaining the build area of ${client} because an evicted area is not deleted yet.`);
      return;
    }
    let areas: string[];
    try {
      const repos = join(clientDir, 'repos');
      areas = notRealDirectory(repos) ? [] : await readdir(repos);
    } catch (error) {
      if (!isMissing(error)) {
        console.error(`stim-server: retaining unreadable build areas of ${client}: ${String(error)}`);
        return;
      }
      areas = [];
    }
    for (const area of areas.filter((name) => name.endsWith('.claims'))) {
      const root = join(clientDir, 'repos', area);
      if (notRealDirectory(root)) {
        console.error(`stim-server: not clearing the claims of ${client} through ${root}: it is not a real directory.`);
        continue;
      }
      const clearance = clearFreeClaimSet({ root, label: 'build worker' });
      if (clearance.status !== 'cleared') {
        console.error(
          `stim-server: retaining the build area of ${client}; ownership at ${root} is ${clearance.status}.`,
        );
        return;
      }
    }
    if (process.platform === 'win32') await this.sweepDaemons(client);
    if (process.platform === 'win32') {
      const repos = join(clientDir, 'repos');
      const dirs = areas.flatMap((repo) => this.windowsAreaDirs(join(repos, repo)));
      if (ownsWindowsGradleHome(clientDir)) dirs.push(gradleUserHome(clientDir));
      if (!(await this.removeWindowsDirs(client, dirs))) return;
    }
    await this.removeDir(client, clientDir);
  }

  private async removeDir(client: string, dir: string): Promise<boolean> {
    const failure = await deletionFailure(dir);
    if (failure) console.error(`stim-server: could not delete the build area of ${client}: ${failure}`);
    return failure === null;
  }

  private windowsAreaDirs(area: string): string[] {
    if (notRealDirectory(area)) return [];
    const dirs: string[] = [];
    try {
      if (lstatSync(join(area, 'src')).isSymbolicLink()) {
        const real = realpathSync(area);
        const checkout = windowsShortDir(real);
        if (
          realpathSync(join(area, 'src')).toLowerCase() === checkout.toLowerCase() &&
          readWorkerRecord(`${checkout}.owner`) === windowsShortDirKey('checkout', real)
        )
          dirs.push(checkout);
      }
    } catch {}
    if (ownsWindowsGradleHome(area)) dirs.push(gradleUserHome(area));
    return dirs;
  }

  private async removeWindowsDirs(client: string, dirs: readonly string[]): Promise<boolean> {
    for (const dir of dirs) {
      if (!(await this.removeDir(client, dir))) return false;
      await rm(`${dir}.owner`, { force: true }).catch(() => {});
    }
    return true;
  }

  private diskSpace(): DiskSpace {
    const free = workerFreeBytes(this.root());
    if (free === null || free >= this.limits.minFreeBytes + this.limits.evictionMarginBytes) return 'ok';
    return free < this.limits.minFreeBytes ? 'floor' : 'low';
  }

  /** Starts an eviction pass when one is due, sooner while the volume is low; stimd calls it as each job starts. */
  maintainAreas(): void {
    try {
      if (this.closed || !(this.options.ready?.() ?? true)) return;
      const interval = this.diskSpace() === 'ok' ? this.limits.areaSweepMs : this.limits.daemonSweepMs;
      this.dropExpiredHandoffs();
      if (Date.now() - this.lastEviction >= interval) void this.evictAreas();
      if (Date.now() - this.lastMeasure >= this.limits.rootMeasureMs)
        void this.measureRoot().catch((error: unknown) =>
          console.error(`stim-server: could not measure the worker root: ${String(error)}`),
        );
    } catch (error) {
      console.error(`stim-server: could not check the build areas: ${String(error)}`);
    }
  }

  private async measureRoot(): Promise<void> {
    this.lastMeasure = Date.now();
    const path = this.root();
    if (!existsSync(path)) {
      this.lastMeasure = 0;
      return;
    }
    const recorded = readRootUsage(path);
    if (recorded) {
      this.rootUsage = recorded;
      const measured = Date.parse(recorded.measuredAt);
      if (Date.now() - measured < this.limits.rootMeasureMs) {
        this.lastMeasure = measured;
        return;
      }
    }
    const bytes = await measureTreeBytes(path, this.closing.signal);
    if (bytes === null) return;
    this.rootUsage = { path, bytes, measuredAt: new Date().toISOString() };
    recordRootUsage(this.rootUsage);
  }

  workerRootUsage(): WorkerRootUsage | null {
    if (this.options.ready?.() ?? true) {
      try {
        const path = this.root();
        if (this.rootUsage && (this.rootUsage.path !== path || !existsSync(path))) {
          this.rootUsage = null;
          this.lastMeasure = 0;
        }
        this.rootUsage ??= readRootUsage(path);
      } catch {}
    }
    return this.rootUsage;
  }

  /**
   * Evicts repository areas of approved clients: those unused for longer than `server.workerAreaMaxAgeDays` and, while
   * the volume is near the disk floor, the least recently used. Calls made during a pass join it.
   */
  evictAreas(): Promise<void> {
    this.evicting ??= this.evictionPass()
      .catch((error: unknown) => console.error(`stim-server: could not evict build areas: ${String(error)}`))
      .finally(() => {
        this.evicting = null;
      });
    return this.evicting;
  }

  private planEvictions(maxAgeMs: number): AreaEviction[] {
    return areasToEvict(this.workerAreas(), {
      now: Date.now(),
      maxAgeMs,
      recentMs: this.limits.evictionRecentMs,
      space: this.diskSpace(),
    });
  }

  private async evictionPass(): Promise<void> {
    this.lastEviction = Date.now();
    const maxAgeMs = workerAreaMaxAgeDays() * DAY_MS;
    for (const client of this.workerClients()) {
      if (this.closed) return;
      await this.resumeEvicted(client);
    }
    const refused = new Set<string>();
    const emptied = new Set<string>();
    const unrefused = (area: AreaEviction) => !refused.has(areaKey(area.client, area.repo));
    let processes: string | null = null;
    while (!this.closed && this.planEvictions(maxAgeMs).some(unrefused)) {
      processes ??= await listCommandLines();
      if (this.closed) return;
      const next = this.planEvictions(maxAgeMs).find(unrefused);
      if (!next) continue;
      const key = areaKey(next.client, next.repo);
      const outcome = this.evictArea(next, processes);
      if ('kept' in outcome) {
        refused.add(key);
        if (this.areaRefusals.get(key) !== outcome.kept)
          console.error(`stim-server: retaining the build area ${key}: ${outcome.kept}.`);
        this.areaRefusals.set(key, outcome.kept);
        continue;
      }
      emptied.add(next.client);
      this.areaRefusals.delete(key);
      const days = ((Date.now() - next.usedAt) / DAY_MS).toFixed(1);
      const why =
        next.reason === 'age'
          ? `unused for ${days} days, over the ${maxAgeMs / DAY_MS} of server.workerAreaMaxAgeDays`
          : `the least recently used (${days} days ago) while the volume is near its disk floor`;
      const { eviction } = outcome;
      const failure =
        outcome.failure ?? (await this.serialized(next.client, () => this.deleteEvicted(next.client, eviction)));
      processes = null;
      const free = workerFreeBytes(this.root());
      if (failure) {
        this.reported.set(eviction.id, failure);
        console.error(
          `stim-server: moved the build area ${key} out of repos (${why}) but could not delete it: ${failure}. ${this.evictedRemedy(next.client, eviction.id)}`,
        );
      } else
        console.error(
          `stim-server: removed the build area ${key}: ${why}; ${free === null ? 'free disk unknown' : `${gb(free)} GB free`}.`,
        );
    }
    if (this.closed) return;
    for (const key of this.areaRefusals.keys()) if (!refused.has(key)) this.areaRefusals.delete(key);
    for (const client of emptied) this.pruneBlobs(client);
    const stillLow = this.diskSpace() !== 'ok';
    if (stillLow && !this.reportedLow)
      console.error(
        `stim-server: the worker root's volume stays under ${gb(this.limits.minFreeBytes + this.limits.evictionMarginBytes)} GB free: every area left is in use, a client's newest, or used in the last ${this.limits.evictionRecentMs / HOUR_MS} hours.`,
      );
    this.reportedLow = stillLow;
  }

  private workerClients(all = false): string[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.root(), { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((client) => all || (!this.removals.has(client) && (this.options.allowed?.(client) ?? true)));
  }

  private workerAreas(): WorkerArea[] {
    return this.workerClients().flatMap((client) => {
      const repos = join(this.clientDir(client), 'repos');
      if (notRealDirectory(repos)) {
        this.reportOnce(
          repos,
          `stim-server: retaining the build areas of ${client}: ${repos} is not a real directory.`,
        );
        return [];
      }
      try {
        return readdirSync(repos, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() && !entry.name.endsWith('.claims') && new RegExp(BUILD_REPO_PATTERN).test(entry.name),
          )
          .map((entry) => ({ client, repo: entry.name, usedAt: areaLastUsed(join(repos, entry.name)) }));
      } catch (error) {
        if (!isMissing(error))
          console.error(`stim-server: retaining unreadable build areas of ${client}: ${String(error)}`);
        return [];
      }
    });
  }

  /** Runs `read`, which uses the area outside any claim; eviction retains the area until it settles. */
  pinned<T>(client: string, repo: string, read: () => Promise<T>): Promise<T> {
    const unpin = this.pin(client, repo);
    return read().finally(unpin);
  }

  private pin(client: string, repo: string): () => void {
    const key = areaKey(client, repo);
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
    return () => {
      const count = (this.pins.get(key) ?? 1) - 1;
      if (count > 0) this.pins.set(key, count);
      else this.pins.delete(key);
    };
  }

  private areaBusy(client: string, repo: string): string | null {
    const here = (entry: { client: string; repo: string }) => entry.client === client && entry.repo === repo;
    if ([...this.options.jobs()].some(here)) return 'an offload job is using it';
    const clientDir = this.clientDir(client);
    if (handoffTokens(clientDir).some((token) => readHandoff(clientDir, token)?.repo === repo))
      return 'it holds a bundle for a hosted session to take';
    if (this.pins.has(areaKey(client, repo))) return 'its artifacts are being read';
    return null;
  }

  private evictArea(
    { client, repo }: AreaEviction,
    processes: string,
  ): { kept: string } | { eviction: Eviction; failure: string | null } {
    const area = join(this.clientDir(client), 'repos', repo);
    const busy = this.areaBusy(client, repo);
    if (busy) return { kept: busy };
    try {
      const daemons = workerGradleDaemons(processes, this.root(), process.platform, [{ client, repo }]);
      if (daemons.some((daemon) => daemon.client === client && daemon.repo === repo))
        return { kept: 'a Gradle daemon is running in it' };
      const unknown = unknownGradleProcess(gradleUserHome(area), new Set());
      if (unknown) return { kept: unknown.message };
    } catch (error) {
      return { kept: `its Gradle processes could not be checked: ${String(error)}` };
    }
    if (notRealDirectory(join(this.clientDir(client), EVICTED_DIR)))
      return { kept: `${join(this.clientDir(client), EVICTED_DIR)} is not a real directory` };
    const claims = `${area}.claims`;
    const claim = this.areaClaim(client, repo);
    if (typeof claim === 'string') return { kept: claim };
    const uuid = randomUUID();
    const eviction: Eviction = { id: `${repo}-${uuid}`, repo, uuid };
    const parked = join(this.clientDir(client), EVICTED_DIR, eviction.id);
    let failure: string | null;
    try {
      mkdirSync(dirname(parked), { recursive: true, mode: 0o700 });
      writeFileSync(`${parked}.json`, '');
      try {
        renameSync(area, parked);
      } catch (error) {
        rmSync(`${parked}.json`, { force: true });
        throw error;
      }
      failure = this.moveExternalsAside(client, eviction);
    } catch (error) {
      return { kept: `it could not be moved aside: ${String(error)}` };
    } finally {
      releaseClaim(claim);
    }
    const clearance = notRealDirectory(claims) ? null : clearFreeClaimSet({ root: claims, label: 'build worker' });
    if (clearance?.status !== 'cleared')
      console.error(
        `stim-server: left the claim set of the evicted area at ${claims}: ${clearance?.status ?? 'not a real directory'}.`,
      );
    return { eviction, failure };
  }

  private areaClaim(client: string, repo: string): ClaimHandle | string {
    const claims = `${join(this.clientDir(client), 'repos', repo)}.claims`;
    if (notRealDirectory(claims)) return `${claims} is not a real directory`;
    try {
      const attempt = tryAcquireClaim({
        root: claims,
        mode: 'exclusive',
        details: { client, repo, eviction: true },
        label: 'build worker',
      });
      if (attempt.acquired) return attempt.acquired;
      if (attempt.pending) releaseClaim(attempt.pending);
      return `its claim at ${claims} is held${attempt.held ? ` by process ${attempt.held.owner.pid}` : ''}`;
    } catch (error) {
      return `its claim is unresolved: ${String(error)}`;
    }
  }

  private externalDirs(client: string, repo: string): Array<{ dir: string; key: string }> {
    if (process.platform !== 'win32') return [];
    const repos = join(this.clientDir(client), 'repos');
    const real = join(realpathSync(repos), repo);
    const area = join(repos, repo);
    return [
      { dir: windowsShortDir(real), key: windowsShortDirKey('checkout', real) },
      { dir: gradleUserHome(area), key: windowsShortDirKey('gradle', area) },
    ];
  }

  /**
   * Takes an evicted area's short directories out of use. Their names can collide (`makePrivateWindowsDirs`), so each
   * moves only while its `.owner` names this area.
   */
  private moveExternalsAside(client: string, { repo, uuid }: Eviction): string | null {
    try {
      for (const { dir, key } of this.externalDirs(client, repo)) {
        let owner: string | null = null;
        try {
          owner = readFileSync(`${dir}.owner`, 'utf8');
        } catch {}
        if (owner !== key) {
          if (owner !== null || existsSync(dir))
            console.error(
              `stim-server: leaving ${dir} of the evicted build area ${areaKey(client, repo)}: ${owner === null ? 'it has no owner marker' : 'its owner marker names another area'}.`,
            );
          continue;
        }
        if (existsSync(dir)) renameSync(dir, `${dir}.evicted-${uuid}`);
        rmSync(`${dir}.owner`, { force: true });
      }
      return null;
    } catch (error) {
      return String(error);
    }
  }

  /** Deletes what an eviction moved aside, the record last; what could not be deleted stays for a later pass. */
  private async deleteEvicted(client: string, { id, repo, uuid }: Eviction): Promise<string | null> {
    const parked = join(this.clientDir(client), EVICTED_DIR, id);
    try {
      const asides = this.externalDirs(client, repo).map(({ dir }) => `${dir}.evicted-${uuid}`);
      for (const dir of [...asides, parked]) {
        const failure = await deletionFailure(dir);
        if (failure) return failure;
      }
      rmSync(`${parked}.json`, { force: true });
    } catch (error) {
      return String(error);
    }
    this.reported.delete(id);
    try {
      rmdirSync(dirname(parked));
    } catch {}
    return null;
  }

  private evictedRemedy(client: string, id: string): string {
    const parked = join(this.clientDir(client), EVICTED_DIR, id);
    return `It stays at ${parked} and a later pass retries; if this repeats, fix the cause or delete it and ${parked}.json by hand.`;
  }

  private reportOnce(key: string, message: string): void {
    if (this.reported.get(key) !== message) console.error(message);
    this.reported.set(key, message);
  }

  private serialized<T>(client: string, work: () => Promise<T>): Promise<T> {
    const run = (this.recoveries.get(client) ?? Promise.resolve()).then(work);
    this.recoveries.set(client, run);
    const forget = () => {
      if (this.recoveries.get(client) === run) this.recoveries.delete(client);
    };
    run.then(forget, forget);
    return run;
  }

  /** One client's recovery at a time, so a pass and a revocation never work through the same records together. */
  private resumeEvicted(client: string): Promise<boolean> {
    return this.serialized(client, () =>
      this.finishEvictions(client).catch((error: unknown) => {
        this.reportOnce(client, `stim-server: could not finish the evictions of ${client}: ${String(error)}.`);
        return false;
      }),
    );
  }

  /**
   * Finishes the evictions an earlier pass or server left, each directory outside the worker root before the area that
   * names it. A directory a new area of the same repository took over is its own again. Returns whether none is left.
   */
  private async finishEvictions(client: string): Promise<boolean> {
    const dir = join(this.clientDir(client), EVICTED_DIR);
    if (notRealDirectory(this.clientDir(client))) return true;
    if (notRealDirectory(dir)) {
      this.reportOnce(
        dir,
        `stim-server: ignoring ${dir}: it is not a real directory. Delete it to allow evictions of ${client}.`,
      );
      return true;
    }
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    let finished = true;
    for (const name of names) {
      const eviction = evictionOf(name);
      if (!eviction) {
        this.reportOnce(
          join(dir, name),
          `stim-server: keeping ${join(dir, name)}: stim-server does not name an eviction record that, so it deletes nothing for it. Check it and delete it by hand.`,
        );
        continue;
      }
      const parked = existsSync(join(dir, eviction.id));
      const failure = this.claimExternals(client, eviction) ?? (await this.deleteEvicted(client, eviction));
      if (failure) {
        finished = false;
        if (this.reported.get(eviction.id) !== failure)
          console.error(
            `stim-server: could not finish deleting the evicted build area ${client}/${eviction.id}: ${failure}. ${this.evictedRemedy(client, eviction.id)}`,
          );
        this.reported.set(eviction.id, failure);
      } else if (parked)
        console.error(`stim-server: finished deleting the evicted build area ${client}/${eviction.id}.`);
    }
    return finished;
  }

  private claimExternals(client: string, eviction: Eviction): string | null {
    const repos = join(this.clientDir(client), 'repos');
    if (notRealDirectory(repos)) return `${repos} is not a real directory`;
    const externals = this.externalDirs(client, eviction.repo);
    if (!externals.some(({ dir }) => existsSync(dir) || existsSync(`${dir}.owner`))) return null;
    const claim = this.areaClaim(client, eviction.repo);
    if (typeof claim === 'string') return claim;
    try {
      return existsSync(join(repos, eviction.repo)) ? null : this.moveExternalsAside(client, eviction);
    } finally {
      releaseClaim(claim);
    }
  }

  /** Deletes the kept bundles whose time is up. */
  private dropExpiredHandoffs(): void {
    const now = Date.now();
    for (const client of this.workerClients()) {
      const clientDir = this.clientDir(client);
      for (const token of handoffTokens(clientDir)) {
        const handoff = readHandoff(clientDir, token);
        if (!handoff || handoff.expiresAt <= now) dropHandoff(clientDir, token);
      }
    }
  }

  /**
   * Takes the bundle an offload job kept under `token` once its artifact digest is `sha256` and `accept` admits the
   * client that built it. `release` deletes it.
   */
  takeBundle(
    token: string,
    sha256: string,
    accept: (client: string) => boolean,
  ): { bundle: string; release: () => void } | string {
    const client = HANDOFF_TOKEN.test(token)
      ? this.workerClients().find((each) => existsSync(handoffRecord(this.clientDir(each), token)))
      : undefined;
    const clientDir = client === undefined ? null : this.clientDir(client);
    const entry = clientDir === null ? null : readHandoff(clientDir, token);
    if (!client || !clientDir || !entry || entry.expiresAt <= Date.now())
      return 'This machine no longer holds that build.';
    if (entry.sha256 !== sha256) return 'This machine holds a different build under that handoff.';
    if (!accept(client))
      return 'That build belongs to another machine: its build client and this device-host client have different keys.';
    rmSync(handoffRecord(clientDir, token), { force: true });
    const unpin = this.pin(client, entry.repo);
    return {
      bundle: entry.bundle,
      release: () => {
        try {
          rmSync(entry.dir, { recursive: true, force: true });
        } finally {
          unpin();
        }
      },
    };
  }

  /**
   * Deletes the kept bundles of clients `allowed` no longer accepts, such as a revoked one. With `deleteAreas`, the area
   * of each such client a job ran for in this process is deleted once its jobs end.
   */
  abandonDetached(allowed: (client: string) => boolean, deleteAreas = false): void {
    for (const client of this.workerClients(true)) {
      if (allowed(client)) continue;
      const clientDir = this.clientDir(client);
      for (const token of handoffTokens(clientDir)) dropHandoff(clientDir, token);
    }
    for (const client of this.served) {
      if (!deleteAreas || allowed(client)) continue;
      this.served.delete(client);
      void this.remove(client);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    clearInterval(this.sweeper);
    await this.sweeping;
    await Promise.all(this.removals.values());
  }
}
