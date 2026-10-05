import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import type { WebSocket } from 'ws';
import {
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity } from '@stim-cli/core/process-identity';
import {
  buildWorkerRoot,
  isJsonObject,
  loadConfig,
  machineCapacity,
  saturation,
  settingDefinition,
  settingValueError,
  tryAcquireBuildSlotClaim,
} from '@stim-cli/core/state';
import { validMacosResourceDestination } from '@stim-cli/core';
import type { BuildStartParams } from '@stim-cli/core/protocol';
import { readAvailableMemory } from './machine.ts';
import {
  BUILD_REPO_PATTERN,
  type BuildAndroidOptions,
  type BuildArtifactResult,
  type BuildAttachResult,
  type BuildCapacity,
  type BuildFile,
  type BuildJobOutcome,
  type BuildOfferResult,
  type BuildProgressEvent,
  type BuildSyncResult,
  type BuildToolchain,
  type ErrorCode,
  type ProtocolError,
} from './protocol.ts';

export interface BuildLimits {
  /** Offloaded builds this Mac runs at once, across every client. */
  maxJobs: number;
  /** Free bytes the worker root's volume must keep for a build to start there. */
  minFreeBytes: number;
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
}

const DEFAULT_BUILD_LIMITS: BuildLimits = {
  maxJobs: 1,
  minFreeBytes: 10 * 1024 ** 3,
  timeoutMs: 60 * 60_000,
  killGraceMs: 5000,
  detachGraceMs: 5 * 60_000,
  toolchainTtlMs: 60_000,
  minFreeMemoryBytes: 2 * 1024 ** 3,
  daemonSweepMs: 60_000,
};

const DIGEST_BYTES = 32;
const MAX_MANIFEST_FILES = 200_000;
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const MAX_PATH_CHARS = 1024;
const ARTIFACT_CHUNK = 1024 * 1024;
const MAX_BUFFERED = 16 * 1024 * 1024;
const MAX_WORKER_LINE = 1024 * 1024;
const GROUP_POLL_MS = 200;

type Refusal = { error: ProtocolError };

const refusal = (code: ErrorCode, message: string): Refusal => ({ error: { code, message } });

/** A manifest path the mirror can hold: relative, normalized, and never inside `.git`. */
function validBuildPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function validFile(file: unknown): file is BuildFile {
  if (!isJsonObject(file) || !validBuildPath(file.path)) return false;
  if (file.kind !== 'file' && file.kind !== 'exec' && file.kind !== 'link') return false;
  const size = file.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) return false;
  return typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256);
}

const validRepo = (repo: unknown): repo is string =>
  typeof repo === 'string' && new RegExp(BUILD_REPO_PATTERN).test(repo);

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

const optional = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const GRADLE_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/** The Gradle choices of an Android `build.start`, or null when they are malformed. */
function androidOptions(value: unknown): BuildAndroidOptions | null {
  if (!isJsonObject(value)) return null;
  const { variant, abi, gradleBuildCache, pch, compilerCache } = value;
  if (variant !== null && !(typeof variant === 'string' && GRADLE_NAME.test(variant))) return null;
  if (abi !== null && !(typeof abi === 'string' && GRADLE_NAME.test(abi))) return null;
  if (typeof gradleBuildCache !== 'boolean') return null;
  if (pch !== 'auto' && pch !== 'on' && pch !== 'off') return null;
  if (compilerCache !== 'ccache' && compilerCache !== 'none') return null;
  return { variant, abi, gradleBuildCache, pch, compilerCache };
}

function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function nonEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function gradleDaemonIdleMs(): number {
  const definition = settingDefinition('offload.gradleDaemonIdleMinutes')!;
  const value = loadConfig()?.offload?.gradleDaemonIdleMinutes;
  const valid = typeof value === 'number' && settingValueError(definition, value) === null;
  return (valid ? value : (definition.default as number)) * 60_000;
}

const GRADLE_DAEMON = 'org.gradle.launcher.daemon.bootstrap.GradleDaemon';

/**
 * The Gradle daemons in `ps -A -ww -o pid=,command=` output that run from a client's Gradle home under `root`,
 * which the wrapper distribution on their classpath names.
 */
function workerGradleDaemons(ps: string, root: string): Array<{ pid: number; client: string }> {
  const home = new RegExp(`${resolvePath(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/\\s]+)/cache/gradle/`);
  const daemons: Array<{ pid: number; client: string }> = [];
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2]!.includes(GRADLE_DAEMON)) continue;
    const client = home.exec(match[2]!)?.[1];
    if (client) daemons.push({ pid: Number(match[1]), client });
  }
  return daemons;
}

function listProcesses(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-A', '-ww', '-o', 'pid=,command='],
      { timeout: 10_000, maxBuffer: 64 * 1024 ** 2 },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
}

interface Job {
  id: string;
  client: string;
  child: ChildProcess;
  archive: string;
  /** Whether the job holds one of this Mac's `concurrency.maxBuilds` slots, which `machineCapacity` counts. */
  slotted: boolean;
  outcome: BuildJobOutcome | null;
  settled: boolean;
  cancel: () => void;
  done: Promise<void>;
  send: (event: BuildProgressEvent) => void;
  session: BuildSession | null;
  grace: NodeJS.Timeout | null;
}

const nowhere = (): void => {};

export interface BuildHostOptions {
  /** The `offload-worker.mjs` entry of the bundled Stim. */
  worker: string;
  env: NodeJS.ProcessEnv;
  limits?: Partial<BuildLimits>;
  /** Called once a job ends, for the action log. */
  finished?: (record: { client: string; repo: string; ok: boolean; error?: ProtocolError; durationMs: number }) => void;
  /** Whether a client still holds `build`; the Gradle daemons of one that does not are stopped. */
  allowed?: (client: string) => boolean;
  /** Whether the periodic daemon sweep may read the Stim home yet; it runs unconditionally when absent. */
  ready?: () => boolean;
}

/** Runs other Macs' iOS and Android builds here for clients with `build`, each in its own area under the worker root. */
export class BuildHost {
  readonly limits: BuildLimits;
  private readonly jobs = new Set<Job>();
  private readonly owned = new Map<string, Job>();
  private closed = false;
  private toolchainAt = 0;
  private toolchainValue: Promise<BuildToolchain | null> | null = null;
  private readonly options: BuildHostOptions;
  private sweeping: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private readonly forced = new Set<string>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(options: BuildHostOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_BUILD_LIMITS, ...options.limits };
    this.sweeper = setInterval(() => {
      if (this.options.ready?.() ?? true) void this.sweepDaemons();
    }, this.limits.daemonSweepMs);
    this.sweeper.unref();
  }

  /**
   * Stops the Gradle daemons that offloaded Android builds left warm, except those of a client with a running job:
   * every one while available memory is under `minFreeMemoryBytes`, and those of a client that lost `build` or that
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
    const daemons = workerGradleDaemons(await listProcesses(), this.root());
    const busy = new Set([...this.jobs].map((job) => job.client));
    for (const daemon of daemons) {
      if (busy.has(daemon.client)) continue;
      if (!low && !forced.has(daemon.client) && (this.options.allowed?.(daemon.client) ?? true)) continue;
      try {
        process.kill(daemon.pid, 'SIGTERM');
      } catch {}
    }
  }

  root(): string {
    return buildWorkerRoot();
  }

  clientDir(client: string): string {
    return join(this.root(), client);
  }

  toolchain(): Promise<BuildToolchain | null> {
    if (this.toolchainValue && Date.now() - this.toolchainAt < this.limits.toolchainTtlMs) return this.toolchainValue;
    this.toolchainAt = Date.now();
    this.toolchainValue = new Promise((resolve) => {
      const child = spawn(process.execPath, [this.options.worker, 'offer'], {
        env: this.options.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (out += chunk));
      child.on('error', () => resolve(null));
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(out) as unknown;
          resolve(isJsonObject(value) ? (value as unknown as BuildToolchain) : null);
        } catch {
          resolve(null);
        }
      });
    });
    void this.toolchainValue.then((value) => {
      if (!value) this.toolchainValue = null;
      return undefined;
    });
    return this.toolchainValue;
  }

  async offer(client: string, params: unknown): Promise<{ result: BuildOfferResult } | Refusal> {
    if (!isJsonObject(params) || !validRepo(params.repo)) {
      return refusal('bad-request', 'build.offer needs params.repo.');
    }
    const toolchain = await this.toolchain();
    if (!toolchain) return refusal('build-refused', 'This Mac could not read its build toolchain.');
    const root = this.root();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const area = join(this.clientDir(client), 'repos', params.repo);
    let lockfile: string | null = null;
    try {
      lockfile = readFileSync(join(area, 'lockfile'), 'utf8');
    } catch {}
    return {
      result: {
        toolchain,
        capacity: this.capacity(),
        warm: {
          checkout: existsSync(join(area, 'src')),
          dependencies: typeof params.lockfile === 'string' && lockfile === params.lockfile,
          build: nonEmptyDir(join(area, 'home', 'workspaces')) || nonEmptyDir(join(area, 'macos')),
        },
      },
    };
  }

  capacity(): BuildCapacity {
    const machine = machineCapacity();
    const running = this.jobs.size;
    const diskFreeBytes = freeBytes(this.root());
    const builds = machine.builds + [...this.jobs].filter((job) => !job.slotted).length;
    const declined =
      running >= this.limits.maxJobs
        ? `already running ${running} offloaded build(s), its limit`
        : diskFreeBytes !== null && diskFreeBytes < this.limits.minFreeBytes
          ? `${gb(diskFreeBytes)} GB free, builds need ${gb(this.limits.minFreeBytes)} GB`
          : saturation({ ...machine, builds });
    return {
      running,
      max: this.limits.maxJobs,
      diskFreeBytes,
      minDiskFreeBytes: this.limits.minFreeBytes,
      cpus: machine.cpus,
      loadPerCore: machine.loadPerCore,
      builds,
      maxBuilds: machine.maxBuilds,
      maxLoadPerCore: machine.maxLoadPerCore,
      declined,
    };
  }

  session(client: string, socket: WebSocket, send: (event: BuildProgressEvent) => void): BuildSession {
    return new BuildSession(this, client, socket, send);
  }

  /** Starts the build of one synced manifest; the job belongs to the caller's connection. */
  launch({
    client,
    repo,
    job,
    session,
    send,
  }: {
    client: string;
    repo: string;
    job: Record<string, unknown>;
    session: BuildSession;
    send: (event: BuildProgressEvent) => void;
  }): Job | Refusal {
    if (this.closed) return refusal('build-refused', 'This Mac is shutting down stim-server.');
    const { declined } = this.capacity();
    if (declined) return refusal('build-busy', `This Mac declines the build: ${declined}.`);
    const clientDir = this.clientDir(client);
    const area = join(clientDir, 'repos', repo);
    mkdirSync(join(area, 'home'), { recursive: true, mode: 0o700 });
    let claim: ClaimHandle;
    try {
      const attempt = tryAcquireClaim({
        root: `${area}.claims`,
        mode: 'exclusive',
        details: { client, repo },
        label: 'build worker',
      });
      if (!attempt.acquired) {
        if (attempt.pending) releaseClaim(attempt.pending);
        return refusal('build-busy', 'Another build of this repository is running on this Mac.');
      }
      claim = attempt.acquired;
    } catch (error) {
      return refusal('build-refused', (error as Error).message);
    }
    const id = randomUUID();
    let slot: ClaimHandle | null = null;
    const releaseClaims = () => {
      releaseClaim(slot);
      releaseClaim(claim);
    };
    const maxBuilds = machineCapacity().maxBuilds;
    try {
      const taken =
        maxBuilds > 0
          ? tryAcquireBuildSlotClaim({ max: maxBuilds, details: { offloaded: true, client, repo, job: id } })
          : null;
      if (maxBuilds > 0 && !taken) {
        releaseClaim(claim);
        return refusal('build-busy', `This Mac declines the build: all ${maxBuilds} build slots busy.`);
      }
      slot = taken?.claim ?? null;
    } catch (error) {
      releaseClaim(claim);
      return refusal('build-refused', (error as Error).message);
    }
    const started = Date.now();
    try {
      markClaimChildPending(claim);
      if (slot) markClaimChildPending(slot);
    } catch (error) {
      releaseClaims();
      return refusal('build-refused', (error as Error).message);
    }
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.options.worker, 'build'], {
        cwd: area,
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          ...this.options.env,
          STIM_HOME: join(area, 'home'),
          CP_HOME_DIR: join(clientDir, 'cache', 'cocoapods-home'),
          CP_CACHE_DIR: join(clientDir, 'cache', 'cocoapods'),
          npm_config_store_dir: join(clientDir, 'cache', 'pnpm-store'),
          GRADLE_USER_HOME: join(clientDir, 'cache', 'gradle'),
        },
      });
    } catch (error) {
      releaseClaims();
      return refusal('build-refused', (error as Error).message);
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    let killTimer: NodeJS.Timeout | null = null;
    let finished = false;
    const cancel = () => {
      if (killTimer || finished) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), this.limits.killGraceMs);
      killTimer.unref();
    };
    try {
      const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
      if (captured?.ok) {
        setClaimChild(claim, { pid: child.pid, processToken: captured.token });
        if (slot) setClaimChild(slot, { pid: child.pid, processToken: captured.token });
      } else cancel();
    } catch {
      cancel();
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end(
      JSON.stringify({
        ...job,
        job: id,
        area,
        blobs: join(clientDir, 'blobs'),
        swiftpmCache: join(clientDir, 'cache', 'swiftpm'),
        gradleDaemonIdleMs: gradleDaemonIdleMs(),
      }),
    );
    const timeout = setTimeout(cancel, this.limits.timeoutMs);
    const entry: Job = {
      id,
      client,
      child,
      archive: join(area, 'out', id, 'app.tgz'),
      slotted: slot !== null,
      outcome: null,
      settled: false,
      cancel,
      done: Promise.resolve(),
      send,
      session,
      grace: null,
    };
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > MAX_WORKER_LINE) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!isJsonObject(value)) return;
      if (value.type === 'phase' && typeof value.phase === 'string' && typeof value.msg === 'string') {
        entry.send({ event: 'build.progress', job: id, phase: value.phase, msg: value.msg });
      } else if (value.type === 'log' && isJsonObject(value.record)) {
        entry.send({ event: 'build.progress', job: id, record: value.record });
      } else if (value.type === 'result') {
        entry.outcome = workerOutcome(value);
      }
    });
    this.jobs.add(entry);
    this.owned.set(id, entry);
    entry.done = new Promise<void>((resolve) => {
      child.on('error', () => {});
      child.on('close', () => {
        clearTimeout(timeout);
        const outcome: BuildJobOutcome =
          entry.outcome ??
          (killTimer
            ? { ok: false, code: 'cancelled', message: 'The build was cancelled.' }
            : { ok: false, code: 'worker-exited', message: 'The build process exited without a result.' });
        entry.outcome = outcome;
        if (child.pid !== undefined && processGroupAlive(child.pid)) cancel();
        const settle = () => {
          if (child.pid !== undefined && processGroupAlive(child.pid)) {
            setTimeout(settle, GROUP_POLL_MS).unref();
            return;
          }
          if (killTimer) clearTimeout(killTimer);
          finished = true;
          releaseClaims();
          entry.settled = true;
          this.jobs.delete(entry);
          if (entry.outcome!.ok === false && entry.outcome!.code === 'cancelled') void this.sweepDaemons(client);
          entry.send({ event: 'build.progress', job: id, outcome: entry.outcome! });
          this.options.finished?.({
            client,
            repo,
            ok: entry.outcome!.ok,
            ...(entry.outcome!.ok
              ? {}
              : { error: { code: 'build-refused', message: `${entry.outcome!.code}: ${entry.outcome!.message}` } }),
            durationMs: Date.now() - started,
          });
          resolve();
        };
        settle();
      });
    });
    return entry;
  }

  /** Keeps a job whose connection dropped running for `detachGraceMs`, then cancels it. */
  detach(job: Job): void {
    if (this.closed) return this.abandon(job);
    job.session = null;
    job.send = nowhere;
    job.grace = setTimeout(() => this.abandon(job), this.limits.detachGraceMs);
    job.grace.unref();
  }

  /** Cancels a job and deletes its archive once its process group is gone. */
  abandon(job: Job): void {
    if (job.grace) clearTimeout(job.grace);
    job.grace = null;
    job.session = null;
    job.send = nowhere;
    job.cancel();
    this.owned.delete(job.id);
    void job.done.then(() => rmSync(dirname(job.archive), { recursive: true, force: true }));
  }

  /** Hands a job of `client` to `session`, taking it from the connection that held it; null when there is none. */
  attach(client: string, id: string, session: BuildSession): Job | null {
    const job = this.owned.get(id);
    if (!job || job.client !== client) return null;
    if (job.grace) clearTimeout(job.grace);
    job.grace = null;
    if (job.session !== session) job.session?.release(id);
    job.session = session;
    return job;
  }

  forget(job: Job): void {
    this.owned.delete(job.id);
  }

  /** Cancels the jobs no connection holds whose client `allowed` no longer accepts, such as a revoked one. */
  abandonDetached(allowed: (client: string) => boolean): void {
    for (const job of this.owned.values()) {
      if (!job.session && !allowed(job.client)) this.abandon(job);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const job of this.owned.values()) this.abandon(job);
    await Promise.all([...this.jobs].map((job) => job.done));
    await this.sweeping;
  }
}

function workerOutcome(value: Record<string, unknown>): BuildJobOutcome {
  const timings = isJsonObject(value.timings) ? (value.timings as Record<string, number>) : {};
  if (value.ok === true && isJsonObject(value.artifact)) {
    const { name, size, sha256 } = value.artifact;
    if (typeof name === 'string' && typeof size === 'number' && typeof sha256 === 'string') {
      return {
        ok: true,
        artifact: { name, size, sha256 },
        fingerprint: String(value.fingerprint),
        compilationCache: isJsonObject(value.compilationCache) ? value.compilationCache : {},
        timings,
      };
    }
  }
  return {
    ok: false,
    code: typeof value.code === 'string' ? value.code : 'worker-failed',
    message: typeof value.message === 'string' ? value.message.slice(0, 2000) : 'The build failed.',
    timings,
  };
}

/**
 * One connection's manifest, blob uploads and jobs. Closing the connection cancels its jobs; a dropped connection
 * leaves them to `BuildHost.detach`.
 */
export class BuildSession {
  private repo: string | null = null;
  private files = new Map<string, BuildFile>();
  private done = false;
  private readonly expected = new Map<string, number>();
  private incoming: { sha256: string; size: number; received: number; hash: Hash; tmp: string } | null = null;
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private readonly host: BuildHost;
  private readonly client: string;
  private readonly socket: WebSocket;
  private readonly send: (event: BuildProgressEvent) => void;

  constructor(host: BuildHost, client: string, socket: WebSocket, send: (event: BuildProgressEvent) => void) {
    this.host = host;
    this.client = client;
    this.socket = socket;
    this.send = send;
  }

  private blobs(): string {
    return join(this.host.clientDir(this.client), 'blobs');
  }

  private blobPath(sha256: string): string {
    return join(this.blobs(), sha256.slice(0, 2), sha256);
  }

  sync(params: unknown): { result: BuildSyncResult } | Refusal {
    if (!isJsonObject(params) || !validRepo(params.repo) || !Array.isArray(params.files)) {
      return refusal('bad-request', 'build.sync needs params.repo, params.files and params.done.');
    }
    if (typeof params.done !== 'boolean') return refusal('bad-request', 'build.sync needs params.done.');
    if (this.done || this.repo !== params.repo) {
      this.repo = params.repo;
      this.files = new Map();
      this.done = false;
    }
    if (this.files.size + params.files.length > MAX_MANIFEST_FILES) {
      return refusal('limit-exceeded', `A manifest holds at most ${MAX_MANIFEST_FILES} files.`);
    }
    const missing: string[] = [];
    for (const file of params.files) {
      if (!validFile(file)) {
        return refusal('bad-request', `Invalid manifest entry ${JSON.stringify(file).slice(0, 200)}.`);
      }
      this.files.set(file.path, file);
      if (this.expected.has(file.sha256) || existsSync(this.blobPath(file.sha256))) continue;
      this.expected.set(file.sha256, file.size);
      missing.push(file.sha256);
    }
    this.done = params.done;
    return { result: { missing } };
  }

  /** One binary frame: a 32-byte sha256, then the next bytes of that blob. Returns why the frame is refused. */
  blob(frame: Buffer): string | null {
    if (frame.length < DIGEST_BYTES) return 'a blob frame starts with its 32-byte sha256';
    const sha256 = frame.subarray(0, DIGEST_BYTES).toString('hex');
    const data = frame.subarray(DIGEST_BYTES);
    if (this.incoming && this.incoming.sha256 !== sha256) return 'a blob started before the previous one ended';
    if (!this.incoming) {
      const size = this.expected.get(sha256);
      if (size === undefined) return `blob ${sha256} was not asked for`;
      const tmp = join(this.blobs(), `.incoming-${randomUUID()}`);
      mkdirSync(this.blobs(), { recursive: true, mode: 0o700 });
      this.incoming = { sha256, size, received: 0, hash: createHash('sha256'), tmp };
    }
    const incoming = this.incoming;
    incoming.received += data.length;
    if (incoming.received > incoming.size) return `blob ${sha256} is larger than its manifest entry`;
    incoming.hash.update(data);
    appendFileSync(incoming.tmp, data);
    if (incoming.received < incoming.size) return null;
    this.incoming = null;
    this.expected.delete(sha256);
    if (incoming.hash.digest('hex') !== sha256) {
      rmSync(incoming.tmp, { force: true });
      return `blob ${sha256} does not match its digest`;
    }
    const target = this.blobPath(sha256);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(incoming.tmp, target);
    return null;
  }

  async start(params: unknown): Promise<{ result: { job: string } } | Refusal> {
    if (!isJsonObject(params) || !validRepo(params.repo))
      return refusal('bad-request', 'build.start needs params.repo.');
    const strings = ['fingerprint', 'stimBuild'] as const;
    if (strings.some((key) => typeof params[key] !== 'string' || !params[key])) {
      return refusal('bad-request', `build.start needs params.${strings.join(', params.')}.`);
    }
    const platform = params.platform;
    if (platform !== 'ios' && platform !== 'android' && platform !== 'macos') {
      return refusal('bad-request', 'params.platform must be ios, android or macos.');
    }
    if (platform === 'ios' && (typeof params.runtime !== 'string' || !params.runtime)) {
      return refusal('bad-request', 'An ios build needs params.runtime.');
    }
    const android = platform === 'android' ? androidOptions(params.android) : null;
    if (platform === 'android' && !android) {
      return refusal(
        'bad-request',
        'An android build needs params.android: variant and abi (string or null), gradleBuildCache, pch and compilerCache.',
      );
    }
    let macos: BuildStartParams['macos'] = null;
    if (platform === 'macos') {
      const options = params.macos;
      if (
        !isJsonObject(options) ||
        typeof options.product !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(options.product) ||
        !validBuildPath(options.infoPlist) ||
        typeof options.bundleId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(options.bundleId)
      ) {
        return refusal(
          'bad-request',
          'A macos build needs a valid product, relative infoPlist path and bundleId in params.macos.',
        );
      }
      if (
        (options.resources !== undefined &&
          (!isJsonObject(options.resources) ||
            Object.keys(options.resources).length > 256 ||
            Object.entries(options.resources).some(
              ([destination, source]) => !validMacosResourceDestination(destination) || !validBuildPath(source),
            ))) ||
        (options.assetCatalog !== undefined && options.assetCatalog !== null && !validBuildPath(options.assetCatalog))
      ) {
        return refusal(
          'bad-request',
          'params.macos needs contained resource destinations and repository-relative sources.',
        );
      }
      macos = {
        product: options.product,
        infoPlist: options.infoPlist,
        bundleId: options.bundleId,
        ...(options.resources !== undefined ? { resources: options.resources as Record<string, string> } : {}),
        ...(options.assetCatalog !== undefined ? { assetCatalog: options.assetCatalog as string | null } : {}),
      };
    }
    if (params.project !== '' && !validBuildPath(params.project)) {
      return refusal('bad-request', 'params.project must be a relative path inside the repository.');
    }
    if (!this.done || this.repo !== params.repo) {
      return refusal('bad-request', 'Send the whole manifest of this repo with build.sync first.');
    }
    if (this.incoming || [...this.files.values()].some((file) => this.expected.has(file.sha256))) {
      return refusal('bad-request', 'Some files of the manifest were not uploaded.');
    }
    for (const file of this.files.values()) {
      if (!existsSync(this.blobPath(file.sha256))) {
        return refusal('bad-request', `The blob of ${file.path} is missing; sync again.`);
      }
    }
    const toolchain = await this.host.toolchain();
    if (this.closed) return refusal('build-refused', 'The connection closed.');
    if (!toolchain || toolchain.stimBuild !== params.stimBuild) {
      return refusal('build-refused', `This Mac runs Stim build ${toolchain?.stimBuild ?? 'unknown'}.`);
    }
    const launched = this.host.launch({
      client: this.client,
      repo: params.repo,
      session: this,
      send: this.send,
      job: {
        manifest: [...this.files.values()],
        platform,
        android,
        macos,
        project: params.project,
        packageName: optional(params.packageName),
        isExpo: params.isExpo === true,
        configuration: optional(params.configuration),
        scheme: optional(params.scheme),
        runtime: optional(params.runtime),
        expectedFingerprint: params.fingerprint,
        optimizations: isJsonObject(params.optimizations) ? params.optimizations : null,
      },
    });
    if ('error' in launched) return launched;
    this.jobs.set(launched.id, launched);
    return { result: { job: launched.id } };
  }

  /** Takes over a job of this client that another connection started, including one whose connection dropped. */
  attach(params: unknown): { result: BuildAttachResult } | Refusal {
    const id = isJsonObject(params) && typeof params.job === 'string' ? params.job : null;
    const job = id === null ? null : this.host.attach(this.client, id, this);
    if (!job) return refusal('bad-request', 'No such build job for this device; it ended or was cancelled.');
    this.jobs.set(job.id, job);
    job.send = this.send;
    return { result: { outcome: job.settled ? job.outcome : null } };
  }

  release(id: string): void {
    this.jobs.delete(id);
  }

  cancel(params: unknown): { result: Record<string, never> } | Refusal {
    const job = isJsonObject(params) && typeof params.job === 'string' ? this.jobs.get(params.job) : undefined;
    if (!job) return refusal('bad-request', 'No such build job on this connection.');
    job.cancel();
    return { result: {} };
  }

  /** Streams the job's archive as binary frames, each a 32-byte sha256 and then the next bytes. */
  async artifact(params: unknown): Promise<{ result: BuildArtifactResult } | Refusal> {
    const job = isJsonObject(params) && typeof params.job === 'string' ? this.jobs.get(params.job) : undefined;
    if (!job) return refusal('bad-request', 'No such build job on this connection.');
    const outcome = job.outcome;
    if (!job.settled || !outcome?.ok) {
      return refusal('bad-request', 'The job has no artifact: it is still running or it failed.');
    }
    let size: number;
    try {
      size = statSync(job.archive).size;
    } catch {
      return refusal('build-refused', 'The artifact is gone; build again.');
    }
    if (size !== outcome.artifact.size) return refusal('build-refused', 'The artifact changed after the build.');
    const header = Buffer.from(outcome.artifact.sha256, 'hex');
    const fd = openSync(job.archive, 'r');
    try {
      const buffer = Buffer.alloc(ARTIFACT_CHUNK);
      for (let offset = 0; offset < size;) {
        if (this.socket.readyState !== this.socket.OPEN) return refusal('build-refused', 'The connection closed.');
        const read = readSync(fd, buffer, 0, ARTIFACT_CHUNK, offset);
        if (read <= 0) break;
        offset += read;
        this.socket.send(Buffer.concat([header, buffer.subarray(0, read)]), { binary: true });
        while (this.socket.bufferedAmount > MAX_BUFFERED && this.socket.readyState === this.socket.OPEN) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      closeSync(fd);
    }
    rmSync(dirname(job.archive), { recursive: true, force: true });
    this.jobs.delete(job.id);
    this.host.forget(job);
    return { result: outcome.artifact };
  }

  close(dropped: boolean): void {
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (dropped) this.host.detach(job);
      else this.host.abandon(job);
    }
    this.jobs.clear();
    if (this.incoming) rmSync(this.incoming.tmp, { force: true });
    this.incoming = null;
  }
}
