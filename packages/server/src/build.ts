import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, type Hash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import {
  clearFreeClaimSet,
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
  windowsShortDir,
  windowsShortDirKey,
} from '@stim-cli/core/state';
import {
  reactNativeArtifactQuery,
  reusableDependencies,
  swiftpmArtifactQuery,
  validMacosResourceDestination,
} from '@stim-cli/core';
import type { BuildFingerprintSource, BuildOfferParams, BuildStartParams } from '@stim-cli/core/protocol';
import { readAvailableMemory } from './machine.ts';
import { listCommandLines } from './processes.ts';
import { BuildArtifactCache, validArtifactIdentity } from './build-artifact-cache.ts';
import { runArtifactQuery, type ArtifactQueryResult } from './artifact-query.ts';
import {
  BUILD_REPO_PATTERN,
  BUILD_RUBY_VERSION_PATTERN,
  type BuildAndroidOptions,
  type BuildArtifactResult,
  type BuildGradleArtifactQuery,
  type BuildSwiftpmArtifactQuery,
  type CachedBuildArtifact,
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
  /** Offloaded builds this machine runs at once, across every client. */
  maxJobs: number;
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
}

const DEFAULT_BUILD_LIMITS: BuildLimits = {
  maxJobs: 1,
  minFreeBytes: 10 * 1024 ** 3,
  maxManifestBytes: 20 * 1024 ** 3,
  timeoutMs: 60 * 60_000,
  killGraceMs: 5000,
  detachGraceMs: 5 * 60_000,
  toolchainTtlMs: 60_000,
  minFreeMemoryBytes: 2 * 1024 ** 3,
  daemonSweepMs: 60_000,
  handoffMs: 10 * 60_000,
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

interface BuildSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }): void;
}

const refusal = (code: ErrorCode, message: string): Refusal => ({ error: { code, message } });

/** A manifest path the mirror can hold: relative, normalized, and never inside `.git`. */
function validBuildPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function validFile(file: unknown): file is BuildFile {
  if (!isJsonObject(file) || !validBuildPath(file.path)) return false;
  if (file.kind !== 'file' && file.kind !== 'exec' && file.kind !== 'link' && file.kind !== 'directory') return false;
  if (file.kind === 'directory' && (file.size !== 0 || file.sha256 !== createHash('sha256').update('').digest('hex')))
    return false;
  const size = file.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) return false;
  return typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256);
}

const validRepo = (repo: unknown): repo is string =>
  typeof repo === 'string' && new RegExp(BUILD_REPO_PATTERN).test(repo);

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

const optional = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const MAX_FINGERPRINT_SOURCES = 20_000;

function fingerprintSources(value: unknown): BuildFingerprintSource[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FINGERPRINT_SOURCES) return null;
  const valid = value.every(
    (source) =>
      isJsonObject(source) &&
      Object.keys(source).every((key) => key === 'id' || key === 'hash') &&
      typeof source.id === 'string' &&
      source.id.length > 0 &&
      source.id.length <= MAX_PATH_CHARS &&
      (source.hash === null || (typeof source.hash === 'string' && /^[0-9a-f]{1,128}$/.test(source.hash))),
  );
  return valid ? (value as BuildFingerprintSource[]) : null;
}

const GRADLE_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const GRADLE_ROOT = /^[A-Za-z0-9._/ -]{1,200}$/;
const GRADLE_MODULE = /^(:(?!\.\.?(?::|$))[A-Za-z0-9._-]+){1,20}$/;

/** The Gradle choices of an Android `build.start`, or null when they are malformed. */
function androidOptions(value: unknown): BuildAndroidOptions | null {
  if (!isJsonObject(value)) return null;
  const { variant, abi, gradleBuildCache, pch, compilerCache, gradleRoot = null, module = null } = value;
  if (variant !== null && !(typeof variant === 'string' && GRADLE_NAME.test(variant))) return null;
  if (abi !== null && !(typeof abi === 'string' && GRADLE_NAME.test(abi))) return null;
  if (typeof gradleBuildCache !== 'boolean') return null;
  if (pch !== 'auto' && pch !== 'on' && pch !== 'off') return null;
  if (compilerCache !== 'ccache' && compilerCache !== 'none') return null;
  if (gradleRoot !== null && !(typeof gradleRoot === 'string' && GRADLE_ROOT.test(gradleRoot))) return null;
  if (module !== null && !(typeof module === 'string' && GRADLE_MODULE.test(module))) return null;
  return { variant, abi, gradleBuildCache, pch, compilerCache, gradleRoot, module };
}

function macosBuildOptions(
  params: Record<string, unknown>,
): { options: NonNullable<BuildStartParams['macos']> } | Refusal {
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
  const artifactQuery =
    options.artifactInputs === undefined
      ? null
      : swiftpmArtifactQuery({
          project: params.project,
          sourceDigest: params.fingerprint,
          stimBuild: params.stimBuild,
          inputs: options.artifactInputs,
          build: {
            product: options.product,
            infoPlist: options.infoPlist,
            resources: options.resources ?? {},
            assetCatalog: options.assetCatalog ?? null,
          },
        });
  if (options.artifactInputs !== undefined && !artifactQuery)
    return refusal('bad-request', 'SwiftPM artifact retention needs a complete repeatable input declaration.');
  return {
    options: {
      product: options.product,
      infoPlist: options.infoPlist,
      bundleId: options.bundleId,
      ...(artifactQuery ? { artifactInputs: artifactQuery.inputs } : {}),
      ...(options.resources !== undefined ? { resources: options.resources as Record<string, string> } : {}),
      ...(options.assetCatalog !== undefined ? { assetCatalog: options.assetCatalog as string | null } : {}),
    },
  };
}

function gradleArtifactQuery(value: unknown): BuildGradleArtifactQuery | null {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => !['project', 'sourceDigest', 'inputs', 'android'].includes(key))
  )
    return null;
  const { project, sourceDigest, inputs } = value;
  const path = (candidate: unknown): candidate is string => validBuildPath(candidate) && !/[\\:]/.test(candidate);
  if (
    typeof project !== 'string' ||
    (project !== '' && !path(project)) ||
    typeof sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceDigest) ||
    !isJsonObject(inputs) ||
    inputs.complete !== true ||
    Object.keys(inputs).some((key) => !['complete', 'ignored', 'outputs'].includes(key)) ||
    !Array.isArray(inputs.ignored) ||
    !inputs.ignored.every(path) ||
    !Array.isArray(inputs.outputs) ||
    !inputs.outputs.every(path)
  )
    return null;
  const android = androidOptions(value.android);
  return android && android.variant !== null
    ? {
        project,
        sourceDigest,
        inputs: { complete: true, ignored: inputs.ignored, outputs: inputs.outputs },
        android: { ...android, variant: android.variant },
      }
    : null;
}

function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Free bytes for builds under `root`; on Windows also on the drive that holds `windowsShortDir`s, whichever is less. */
function workerFreeBytes(root: string): number | null {
  const free = [root, ...(process.platform === 'win32' ? [dirname(dirname(windowsShortDir(root)))] : [])]
    .map(freeBytes)
    .filter((bytes) => bytes !== null);
  return free.length ? Math.min(...free) : null;
}

function gradleDaemonIdleMs(): number {
  const definition = settingDefinition('server.gradleDaemonIdleMinutes')!;
  const value = loadConfig()?.server?.gradleDaemonIdleMinutes;
  const valid = typeof value === 'number' && settingValueError(definition, value) === null;
  return (valid ? value : (definition.default as number)) * 60_000;
}

const GRADLE_DAEMON = 'org.gradle.launcher.daemon.bootstrap.GradleDaemon';

/** A client's Gradle user home: under its area, or on Windows a `windowsShortDir` that keeps cache paths short. */
function gradleUserHome(clientDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? windowsShortDir(win32.join(clientDir, 'cache', 'gradle'))
    : join(clientDir, 'cache', 'gradle');
}

/**
 * The Gradle daemons in `listCommandLines` output that run from the Gradle home of a client under `root`, which the
 * wrapper distribution on their classpath names. On Windows, where a client's home is not under `root`, `clients`
 * names the clients to look for, and every process running from a client's home counts, which includes the Kotlin
 * daemon: Windows cannot delete a jar a running process opened, so it would keep the home from deletion.
 */
export function workerGradleDaemons(
  ps: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
  clients: readonly string[] = [],
): Array<{ pid: number; client: string }> {
  const home = new RegExp(`${posix.resolve(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/\\s]+)/cache/gradle/`);
  const windowsHomes = clients.map((client) => ({
    client,
    home: `${gradleUserHome(win32.join(root, client), platform).toLowerCase()}\\`,
  }));
  const daemons: Array<{ pid: number; client: string }> = [];
  for (const line of ps.split(/\r?\n/)) {
    const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
    if (!pid || !command) continue;
    const client =
      platform === 'win32'
        ? windowsHomes.find((each) => command.toLowerCase().includes(each.home))?.client
        : command.includes(GRADLE_DAEMON)
          ? home.exec(command)?.[1]
          : undefined;
    if (client) daemons.push({ pid: Number(pid), client });
  }
  return daemons;
}

/**
 * Windows has no process groups, and Node's SIGTERM there is TerminateProcess on the one process, so the build's
 * Gradle and Java children are reached only through `taskkill /T`, which is always forceful.
 */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 30_000 }, () => resolve());
  });
}

interface Job {
  id: string;
  client: string;
  platform: unknown;
  child: ChildProcess;
  archive: string;
  /** Whether the job holds one of this machine's `concurrency.maxBuilds` slots, which `machineCapacity` counts. */
  slotted: boolean;
  outcome: BuildJobOutcome | null;
  cacheArtifact?: Record<string, unknown>;
  reactNativeArtifact?: Record<string, unknown>;
  swiftpmArtifact?: Record<string, unknown>;
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

/** Runs other machines' iOS and Android builds here for clients with `build`, each in its own area under the worker root. */
export class BuildHost {
  readonly limits: BuildLimits;
  private readonly jobs = new Set<Job>();
  private readonly owned = new Map<string, Job>();
  private readonly sessions = new Map<BuildSession, string>();
  private readonly served = new Set<string>();
  private readonly removals = new Map<string, Promise<void>>();
  private readonly queries = new Set<{
    client: string;
    run: ReturnType<typeof runArtifactQuery>;
    settled: boolean;
  }>();
  private readonly retained = new Map<
    string,
    { client: string; dir: string; bundle: string; sha256: string; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private draining: string | null = null;
  private readonly toolchains = new Map<string, { at: number; value: Promise<BuildToolchain | null> }>();
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
      clients,
    );
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

  toolchain(rubyVersion: string | null = null, native?: 'xcode' | 'gradle'): Promise<BuildToolchain | null> {
    const key = JSON.stringify([native ?? null, native ? null : rubyVersion]);
    const now = Date.now();
    for (const [context, entry] of this.toolchains) {
      if (now - entry.at >= this.limits.toolchainTtlMs) this.toolchains.delete(context);
    }
    const cached = this.toolchains.get(key);
    if (cached) return cached.value;
    const value = new Promise<BuildToolchain | null>((resolve) => {
      const args = native ? [`offer-native-${native}`] : ['offer', ...(rubyVersion ? [rubyVersion] : [])];
      const child = spawn(process.execPath, [this.options.worker, ...args], {
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
          const report = JSON.parse(out) as unknown;
          resolve(isJsonObject(report) ? (report as unknown as BuildToolchain) : null);
        } catch {
          resolve(null);
        }
      });
    });
    this.toolchains.set(key, { at: now, value });
    void value.then((result) => {
      if (!result && this.toolchains.get(key)?.value === value) this.toolchains.delete(key);
      return undefined;
    });
    return value;
  }

  async offer(
    client: string,
    params: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ result: BuildOfferResult } | Refusal> {
    if (!isJsonObject(params) || !validRepo(params.repo)) {
      return refusal('bad-request', 'build.offer needs params.repo.');
    }
    let dependencies: BuildOfferParams['dependencies'];
    if (params.dependencies !== undefined) {
      const value = params.dependencies;
      if (
        !isJsonObject(value) ||
        typeof value.project !== 'string' ||
        (value.project !== '' && (!validBuildPath(value.project) || /[\\:]/.test(value.project))) ||
        (value.packageName !== null && typeof value.packageName !== 'string')
      )
        return refusal('bad-request', 'Dependency warmth needs a repository project and package name or null.');
      dependencies = { project: value.project, packageName: value.packageName };
    }
    if (
      params.rubyVersion !== undefined &&
      (typeof params.rubyVersion !== 'string' || !new RegExp(BUILD_RUBY_VERSION_PATTERN).test(params.rubyVersion))
    ) {
      return refusal('bad-request', 'build.offer needs a Ruby installation name without path separators.');
    }
    if (params.native !== undefined && params.native !== 'xcode' && params.native !== 'gradle')
      return refusal('bad-request', 'build.offer supports native Xcode or Gradle toolchains.');
    if (params.artifact !== undefined && (params.native !== 'xcode' || !validArtifactIdentity(params.artifact)))
      return refusal('bad-request', 'An artifact lookup needs a complete native Xcode identity.');
    const query = params.gradleArtifact === undefined ? undefined : gradleArtifactQuery(params.gradleArtifact);
    if (query === null || (query !== undefined && (params.native !== 'gradle' || params.artifact !== undefined)))
      return refusal('bad-request', 'A native Gradle artifact lookup needs its completed source and build choices.');
    const reactNative =
      params.reactNativeArtifact === undefined ? undefined : reactNativeArtifactQuery(params.reactNativeArtifact);
    if (
      reactNative === null ||
      (reactNative !== undefined &&
        (params.native !== undefined || params.artifact !== undefined || query !== undefined))
    )
      return refusal(
        'bad-request',
        'A React Native artifact lookup needs its development fingerprint and build choices.',
      );
    const swiftpm = params.swiftpmArtifact === undefined ? undefined : swiftpmArtifactQuery(params.swiftpmArtifact);
    if (
      swiftpm === null ||
      (swiftpm !== undefined &&
        (params.native !== undefined ||
          params.artifact !== undefined ||
          query !== undefined ||
          reactNative !== undefined))
    )
      return refusal('bad-request', 'A SwiftPM artifact lookup needs its completed source and declared build choices.');
    const artifact =
      swiftpm !== undefined
        ? await this.privateArtifact(client, params.repo, swiftpm, signal)
        : reactNative !== undefined
          ? await this.cache(client, params.repo).lookupReactNative(reactNative, signal)
          : query !== undefined
            ? await this.privateArtifact(client, params.repo, query, signal)
            : params.artifact === undefined
              ? undefined
              : await this.cache(client, params.repo).lookup(params.artifact, signal);
    if (this.closed || this.removals.has(client) || signal.aborted || !(this.options.allowed?.(client) ?? true))
      return refusal('build-refused', 'This build connection closed or lost access during the offer.');
    const toolchain = await this.toolchain((params.rubyVersion as string | undefined) ?? null, params.native);
    if (this.closed || this.removals.has(client) || signal.aborted || !(this.options.allowed?.(client) ?? true))
      return refusal('build-refused', 'This build connection closed or lost access during the offer.');
    if (!toolchain) return refusal('build-refused', 'This machine could not read its build toolchain.');
    const root = this.root();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const area = join(this.clientDir(client), 'repos', params.repo);
    const available = await readAvailableMemory();
    const total = totalmem();
    const memory = available === null ? {} : { memoryTotalBytes: total, memoryUsedBytes: total - available };
    return {
      result: {
        toolchain,
        capacity: { ...this.capacity(), ...memory },
        warm: {
          checkout: existsSync(join(area, 'src')),
          dependencies:
            typeof params.lockfile === 'string' &&
            dependencies !== undefined &&
            reusableDependencies(area, dependencies.project, params.lockfile, this.options.env),
          build: false,
        },
        ...(artifact !== undefined ? { artifact } : {}),
      },
    };
  }

  cache(client: string, repo: string): BuildArtifactCache {
    return new BuildArtifactCache(join(this.clientDir(client), 'repos', repo, 'artifact-cache'));
  }

  private workerEnvironment(clientDir: string, area: string): NodeJS.ProcessEnv {
    return {
      ...this.options.env,
      STIM_HOME: join(area, 'home'),
      CP_HOME_DIR: join(clientDir, 'cache', 'cocoapods-home'),
      CP_CACHE_DIR: join(clientDir, 'cache', 'cocoapods'),
      npm_config_store_dir: join(clientDir, 'cache', 'pnpm-store'),
      GRADLE_USER_HOME: gradleUserHome(clientDir),
    };
  }

  async privateArtifact(
    client: string,
    repo: string,
    query: BuildGradleArtifactQuery | BuildSwiftpmArtifactQuery,
    signal: AbortSignal,
  ): Promise<CachedBuildArtifact | null> {
    try {
      if (
        this.closed ||
        this.removals.has(client) ||
        !(this.options.allowed?.(client) ?? true) ||
        this.queries.size >= 4
      )
        return null;
      const cache = this.cache(client, repo);
      const receipt = await cache.receipt(query, signal);
      if (
        !receipt ||
        this.closed ||
        this.removals.has(client) ||
        signal.aborted ||
        !(this.options.allowed?.(client) ?? true) ||
        this.queries.size >= 4
      )
        return null;
      const clientDir = this.clientDir(client),
        area = join(clientDir, 'repos', repo);
      const run = runArtifactQuery({
        worker: this.options.worker,
        area,
        env: this.workerEnvironment(clientDir, area),
        query,
        receipt,
        signal,
        killGraceMs: this.limits.killGraceMs,
      });
      const entry = { client, run, settled: false };
      this.queries.add(entry);
      this.served.add(client);
      try {
        const result = await run.done;
        entry.settled = result.settled;
        if (!result.settled)
          throw new Error(
            "Native artifact lookup cleanup is unresolved; inspect this machine's stim-server logs before retrying.",
          );
        if (!result.identity || signal.aborted || this.closed || !(this.options.allowed?.(client) ?? true)) return null;
        const artifact = await cache.lookup(result.identity, signal);
        return 'build' in query
          ? artifact?.name.endsWith('.app')
            ? artifact
            : null
          : artifact?.androidPackage
            ? artifact
            : null;
      } finally {
        if (entry.settled) this.queries.delete(entry);
      }
    } catch (error) {
      console.error(`stim-server: Completed artifact lookup failed for ${client}/${repo}: ${String(error)}`);
      throw new Error(
        'This machine could not verify the completed artifact inputs or their cleanup; inspect its stim-server logs before retrying.',
        { cause: error },
      );
    }
  }

  private async stopQueries(client?: string): Promise<boolean> {
    const entries = [...this.queries].filter((entry) => client === undefined || entry.client === client);
    for (const entry of entries) entry.run.cancel();
    const results: ArtifactQueryResult[] = await Promise.all(entries.map((entry) => entry.run.done));
    return results.every((result) => result.settled);
  }

  private async storeCompletedGradle(
    client: string,
    repo: string,
    job: Record<string, unknown>,
    entry: Job,
    signal: AbortSignal,
  ): Promise<void> {
    const outcome = entry.outcome,
      metadata = entry.cacheArtifact,
      native = job.native;
    if (
      !outcome?.ok ||
      !isJsonObject(native) ||
      native.provider !== 'gradle' ||
      !isJsonObject(native.cache) ||
      native.cache.write !== true ||
      native.cache.remote !== true ||
      outcome.fingerprint !== null ||
      outcome.sourceDigest !== native.sourceDigest ||
      typeof outcome.androidPackage !== 'string' ||
      !metadata ||
      !isJsonObject(metadata.identity) ||
      !isJsonObject(metadata.receipt)
    )
      return;
    const identity = { fingerprint: metadata.identity.hash, cacheKey: metadata.identity.key };
    const query = gradleArtifactQuery({
      project: job.project,
      sourceDigest: native.sourceDigest,
      inputs: native.inputs,
      android: job.android,
    });
    if (!query || !validArtifactIdentity(identity)) return;
    await this.cache(client, repo).storeCompleted(
      query,
      identity,
      metadata.receipt,
      entry.archive,
      { ...outcome.artifact, androidPackage: outcome.androidPackage },
      signal,
    );
  }

  private async storeCompletedSwiftpm(
    client: string,
    repo: string,
    job: Record<string, unknown>,
    entry: Job,
    signal: AbortSignal,
  ): Promise<void> {
    const metadata = entry.swiftpmArtifact;
    if (
      !entry.outcome?.ok ||
      job.platform !== 'macos' ||
      job.cacheArtifact !== true ||
      !isJsonObject(job.macos) ||
      !metadata ||
      !isJsonObject(metadata.identity) ||
      !isJsonObject(metadata.receipt)
    )
      return;
    const options = job.macos;
    const query = swiftpmArtifactQuery({
      project: job.project,
      sourceDigest: job.expectedFingerprint,
      stimBuild: job.stimBuild,
      inputs: options.artifactInputs,
      build: {
        product: options.product,
        infoPlist: options.infoPlist,
        resources: options.resources ?? {},
        assetCatalog: options.assetCatalog ?? null,
      },
    });
    const identity = { fingerprint: metadata.identity.hash, cacheKey: metadata.identity.key };
    if (
      !query ||
      !validArtifactIdentity(identity) ||
      identity.cacheKey !== `swiftpm-peer-${identity.fingerprint}` ||
      entry.outcome.fingerprint !== query.sourceDigest ||
      !isDeepStrictEqual(query, metadata.receipt.query) ||
      !isDeepStrictEqual(metadata.identity, metadata.receipt.identity)
    )
      return;
    await this.cache(client, repo).storeCompleted(
      query,
      identity,
      metadata.receipt,
      entry.archive,
      entry.outcome.artifact,
      signal,
    );
  }

  running(): number {
    return this.jobs.size;
  }

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

  capacity(): BuildCapacity {
    const machine = machineCapacity();
    const running = this.jobs.size;
    const diskFreeBytes = workerFreeBytes(this.root());
    const builds = machine.builds + [...this.jobs].filter((job) => !job.slotted).length;
    const declined =
      this.draining ??
      (loadConfig()?.server?.buildsPaused === true
        ? 'Incoming builds are paused; resume with stim settings set server.buildsPaused false'
        : null) ??
      (running >= this.limits.maxJobs
        ? `already running ${running} offloaded build(s), its limit`
        : (this.lowDisk() ?? saturation({ ...machine, builds })));
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

  session(client: string, socket: BuildSocket, send: (event: BuildProgressEvent) => void): BuildSession {
    const session = new BuildSession(this, client, socket, send);
    this.sessions.set(session, client);
    this.served.add(client);
    return session;
  }

  ended(session: BuildSession): void {
    this.sessions.delete(session);
  }

  /**
   * Deletes the blobs of `client` that no `mirror.json` of its repositories and no open connection's manifest
   * references, unless a build of that client runs.
   */
  pruneBlobs(client: string): void {
    if ([...this.jobs].some((job) => job.client === client)) return;
    const keep = new Set<string>();
    for (const [session, owner] of this.sessions) {
      if (owner === client) for (const sha256 of session.digests()) keep.add(sha256);
    }
    try {
      const repos = join(this.clientDir(client), 'repos');
      const blobs = join(this.clientDir(client), 'blobs');
      for (const repo of readdirSync(repos)) {
        const mirror = join(repos, repo, 'mirror.json');
        if (!existsSync(mirror)) continue;
        const record: unknown = JSON.parse(readFileSync(mirror, 'utf8'));
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
    const removal = this.removeClient(client).finally(() => this.removals.delete(client));
    this.removals.set(client, removal);
    return removal;
  }

  private async removeClient(client: string): Promise<void> {
    for (const [token, entry] of this.retained) if (entry.client === client) this.drop(token);
    const jobs = [...this.jobs].filter((job) => job.client === client);
    for (const job of jobs) job.cancel();
    const queriesSettled = await this.stopQueries(client);
    await Promise.all(jobs.map((job) => job.done));
    if (!queriesSettled) {
      console.error(`stim-server: retaining the build area of ${client} because artifact query cleanup is unresolved.`);
      return;
    }
    let areas: string[];
    try {
      areas = await readdir(join(this.clientDir(client), 'repos'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.error(`stim-server: retaining unreadable build areas of ${client}: ${String(error)}`);
        return;
      }
      areas = [];
    }
    for (const area of areas.filter((name) => name.endsWith('.claims'))) {
      const root = join(this.clientDir(client), 'repos', area);
      const clearance = clearFreeClaimSet({ root, label: 'build worker' });
      if (clearance.status !== 'cleared') {
        console.error(
          `stim-server: retaining the build area of ${client}; ownership at ${root} is ${clearance.status}.`,
        );
        return;
      }
    }
    if (process.platform === 'win32') await this.sweepDaemons(client);
    const removeDir = async (dir: string) => {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 10 });
      } catch (error) {
        console.error(`stim-server: could not delete the build area of ${client}: ${String(error)}`);
      }
    };
    if (process.platform === 'win32') {
      const repos = join(this.clientDir(client), 'repos');
      for (const repo of await readdir(repos).catch(() => [])) {
        const area = join(repos, repo);
        try {
          if (!lstatSync(join(area, 'src')).isSymbolicLink()) continue;
          const checkout = windowsShortDir(realpathSync(area));
          if (realpathSync(join(area, 'src')).toLowerCase() !== checkout.toLowerCase()) continue;
          await removeDir(checkout);
          await rm(`${checkout}.owner`, { force: true });
        } catch {}
      }
      const home = gradleUserHome(this.clientDir(client));
      let marker: string | null = null;
      try {
        marker = readFileSync(`${home}.owner`, 'utf8');
      } catch {}
      if (marker === null || marker === windowsShortDirKey('gradle', this.clientDir(client))) {
        await removeDir(home);
        await rm(`${home}.owner`, { force: true }).catch(() => {});
      }
    }
    await removeDir(this.clientDir(client));
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
    if (this.closed || this.removals.has(client))
      return refusal('build-refused', 'This machine is shutting down or removing this build client.');
    const { declined } = this.capacity();
    if (declined) return refusal('build-busy', `This machine declines the build: ${declined}.`);
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
        return refusal('build-busy', 'Another build of this repository is running on this machine.');
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
        return refusal('build-busy', `This machine declines the build: all ${maxBuilds} build slots busy.`);
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
        env: this.workerEnvironment(clientDir, area),
      });
    } catch (error) {
      releaseClaims();
      return refusal('build-refused', (error as Error).message);
    }
    let treeKilled: Promise<void> | null = null;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        treeKilled ??= killTree(child.pid);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    let killTimer: NodeJS.Timeout | null = null;
    let finished = false;
    const caching = new AbortController();
    const cancel = () => {
      caching.abort();
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
      platform: job.platform,
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
        if (isJsonObject(value.cacheArtifact)) entry.cacheArtifact = value.cacheArtifact;
        if (isJsonObject(value.reactNativeArtifact)) entry.reactNativeArtifact = value.reactNativeArtifact;
        if (isJsonObject(value.swiftpmArtifact)) entry.swiftpmArtifact = value.swiftpmArtifact;
        entry.outcome = workerOutcome(
          value,
          isJsonObject(job.native) && job.native.provider === 'gradle' ? 'gradle' : undefined,
        );
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
        const cancelled = killTimer !== null;
        if (child.pid !== undefined && processGroupAlive(child.pid)) cancel();
        const settle = async () => {
          if (child.pid !== undefined && processGroupAlive(child.pid)) {
            setTimeout(settle, GROUP_POLL_MS).unref();
            return;
          }
          await treeKilled;
          if (killTimer) clearTimeout(killTimer);
          finished = true;
          releaseClaims();
          if (
            entry.outcome?.ok &&
            isJsonObject(job.native) &&
            job.native.provider === 'xcode' &&
            typeof job.native.cacheKey === 'string' &&
            isJsonObject(job.native.parameters) &&
            typeof job.expectedFingerprint === 'string' &&
            entry.outcome.fingerprint === job.expectedFingerprint &&
            entry.outcome.sourceDigest === job.native.sourceDigest
          ) {
            try {
              await this.cache(client, repo).store(
                { cacheKey: job.native.cacheKey, fingerprint: job.expectedFingerprint },
                job.native.parameters,
                entry.archive,
                entry.outcome.artifact,
                caching.signal,
              );
            } catch (error) {
              entry.send({
                event: 'build.progress',
                job: id,
                record: {
                  src: 'build',
                  level: 'debug',
                  msg: `Peer cache: ${error instanceof Error ? error.message : String(error)}`,
                },
              });
            }
          }
          try {
            await this.storeCompletedGradle(client, repo, job, entry, caching.signal);
            await this.storeCompletedSwiftpm(client, repo, job, entry, caching.signal);
            const metadata = entry.reactNativeArtifact;
            const query =
              metadata && isJsonObject(metadata.receipt) ? reactNativeArtifactQuery(metadata.receipt.query) : null;
            if (
              entry.outcome?.ok &&
              job.cacheArtifact === true &&
              !job.native &&
              query &&
              metadata &&
              isJsonObject(metadata.identity) &&
              query.fingerprint === job.expectedFingerprint &&
              entry.outcome.fingerprint === job.expectedFingerprint &&
              query.project === job.project &&
              query.platform === job.platform
            ) {
              const identity = { fingerprint: metadata.identity.hash, cacheKey: metadata.identity.key };
              if (validArtifactIdentity(identity))
                await this.cache(client, repo).storeCompleted(
                  query,
                  identity,
                  metadata.receipt,
                  entry.archive,
                  {
                    ...entry.outcome.artifact,
                    ...(entry.outcome.androidPackage ? { androidPackage: entry.outcome.androidPackage } : {}),
                  },
                  caching.signal,
                );
            }
          } catch (error) {
            console.error(
              `stim-server: could not retain the completed artifact for ${client}/${repo}: ${String(error)}`,
            );
          }
          entry.settled = true;
          this.jobs.delete(entry);
          if (cancelled) void this.sweepDaemons(client);
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
          this.pruneBlobs(client);
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

  /**
   * Deletes a fetched job's output. A native job keeps its staged app for `handoffMs` under a new single-use token,
   * which this returns, in place of any bundle its client still had retained.
   */
  retain(job: Job, artifact: BuildArtifactResult): string | null {
    const dir = dirname(job.archive);
    if (this.closed || basename(artifact.name) !== artifact.name) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    rmSync(job.archive, { force: true });
    for (const [token, entry] of this.retained) if (entry.client === job.client) this.drop(token);
    const token = randomBytes(32).toString('hex');
    const timer = setTimeout(() => this.drop(token), this.limits.handoffMs);
    timer.unref();
    this.retained.set(token, {
      client: job.client,
      dir,
      bundle: join(dir, artifact.name),
      sha256: artifact.sha256,
      timer,
    });
    return token;
  }

  private drop(token: string): void {
    const entry = this.retained.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.retained.delete(token);
    rmSync(entry.dir, { recursive: true, force: true });
  }

  /**
   * Takes the bundle `token` retained once its artifact digest is `sha256` and `accept` admits the client that built it.
   * `release` deletes it.
   */
  takeBundle(
    token: string,
    sha256: string,
    accept: (client: string) => boolean,
  ): { bundle: string; release: () => void } | string {
    const entry = this.retained.get(token);
    if (!entry) return 'This machine no longer holds that build.';
    if (entry.sha256 !== sha256) return 'This machine holds a different build under that handoff.';
    if (!accept(entry.client))
      return 'That build belongs to another machine: its build client and this device-host client have different keys.';
    clearTimeout(entry.timer);
    this.retained.delete(token);
    return { bundle: entry.bundle, release: () => rmSync(entry.dir, { recursive: true, force: true }) };
  }

  /**
   * Cancels the jobs no connection holds, and deletes the retained bundles, of clients `allowed` no longer accepts,
   * such as a revoked one. With `deleteAreas`, the area of each such client this server process served is deleted
   * once its builds end.
   */
  abandonDetached(allowed: (client: string) => boolean, deleteAreas = false): void {
    for (const job of this.owned.values()) {
      if (!job.session && !allowed(job.client)) this.abandon(job);
    }
    for (const entry of this.queries) if (!allowed(entry.client)) entry.run.cancel();
    for (const [token, entry] of this.retained) if (!allowed(entry.client)) this.drop(token);
    for (const client of this.served) {
      if (!deleteAreas || allowed(client)) continue;
      this.served.delete(client);
      void this.remove(client);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const job of this.owned.values()) this.abandon(job);
    for (const token of this.retained.keys()) this.drop(token);
    await this.stopQueries();
    await Promise.all([...this.jobs].map((job) => job.done));
    await this.sweeping;
  }
}

function workerOutcome(value: Record<string, unknown>, native?: 'xcode' | 'gradle'): BuildJobOutcome {
  const timings = isJsonObject(value.timings) ? (value.timings as Record<string, number>) : {};
  const androidPackage =
    typeof value.androidPackage === 'string' && /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value.androidPackage)
      ? value.androidPackage
      : undefined;
  if (value.ok === true && isJsonObject(value.artifact)) {
    const { name, size, sha256 } = value.artifact;
    if (
      typeof name === 'string' &&
      typeof size === 'number' &&
      typeof sha256 === 'string' &&
      (native !== 'gradle' || (value.fingerprint === null && androidPackage !== undefined))
    ) {
      return {
        ok: true,
        artifact: { name, size, sha256 },
        fingerprint: native === 'gradle' ? null : String(value.fingerprint),
        ...(androidPackage ? { androidPackage } : {}),
        ...(typeof value.sourceDigest === 'string' ? { sourceDigest: value.sourceDigest } : {}),
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
  private bytes = 0;
  private done = false;
  private readonly expected = new Map<string, number>();
  private incoming: { sha256: string; size: number; received: number; hash: Hash; tmp: string } | null = null;
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private readonly transfers = new AbortController();
  readonly signal: AbortSignal = this.transfers.signal;
  private readonly host: BuildHost;
  private readonly client: string;
  private readonly socket: BuildSocket;
  private readonly send: (event: BuildProgressEvent) => void;

  constructor(host: BuildHost, client: string, socket: BuildSocket, send: (event: BuildProgressEvent) => void) {
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
    const low = this.host.lowDisk();
    if (low) return refusal('build-busy', `This machine declines the upload: ${low}.`);
    if (this.done || this.repo !== params.repo) {
      this.repo = params.repo;
      this.files = new Map();
      this.bytes = 0;
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
      if (this.bytes + file.size > this.host.limits.maxManifestBytes) {
        return refusal('limit-exceeded', `A manifest holds at most ${gb(this.host.limits.maxManifestBytes)} GB.`);
      }
      this.bytes += file.size;
      this.files.set(file.path, file);
      if (this.expected.has(file.sha256) || existsSync(this.blobPath(file.sha256))) continue;
      this.expected.set(file.sha256, file.size);
      missing.push(file.sha256);
    }
    this.done = params.done;
    return { result: { missing } };
  }

  digests(): string[] {
    return [...this.files.values()].map((file) => file.sha256);
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
      const low = this.host.lowDisk(size);
      if (low) return `this machine declines the upload: ${low}`;
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
    const strings = ['stimBuild'] as const;
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
    let native: BuildStartParams['native'];
    if (params.native !== undefined) {
      const input = params.native;
      if (!isJsonObject(input) || typeof input.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.sourceDigest))
        return refusal('bad-request', 'A native build needs its source transfer digest.');
      if (input.provider === 'gradle') {
        const inputs = input.inputs;
        const cache = input.cache;
        if (
          cache !== undefined &&
          (!isJsonObject(cache) || ['read', 'write', 'remote'].some((key) => typeof cache[key] !== 'boolean'))
        )
          return refusal(
            'bad-request',
            'A native Gradle artifact cache policy needs boolean read, write and remote values.',
          );
        if (
          platform !== 'android' ||
          params.fingerprint !== null ||
          !isJsonObject(inputs) ||
          inputs.complete !== true ||
          Object.keys(inputs).some((key) => !['complete', 'ignored', 'outputs'].includes(key)) ||
          !Array.isArray(inputs.ignored) ||
          !inputs.ignored.every(validBuildPath) ||
          !Array.isArray(inputs.outputs) ||
          !inputs.outputs.every(validBuildPath)
        )
          return refusal(
            'bad-request',
            'A native Gradle build needs declared complete inputs and a null artifact fingerprint.',
          );
      } else {
        const optimizations = params.optimizations;
        if (
          platform !== 'ios' ||
          input.provider !== 'xcode' ||
          typeof input.cacheKey !== 'string' ||
          !input.cacheKey ||
          ![null, 'arm64', 'x86_64'].includes(input.arch as string | null) ||
          !isJsonObject(input.parameters) ||
          !isJsonObject(optimizations) ||
          typeof optimizations.compilationCache !== 'boolean' ||
          typeof optimizations.prefixMapping !== 'boolean' ||
          (optimizations.swiftCompilationCache !== null && typeof optimizations.swiftCompilationCache !== 'boolean')
        )
          return refusal(
            'bad-request',
            'A native Xcode build needs its source digest, cache key, architecture and compiler options.',
          );
      }
      native = input as unknown as NonNullable<BuildStartParams['native']>;
    }
    if (native?.provider !== 'gradle' && (typeof params.fingerprint !== 'string' || !params.fingerprint))
      return refusal('bad-request', 'build.start needs params.fingerprint.');
    const expectedSources = fingerprintSources(params.fingerprintSources);
    if (expectedSources === null)
      return refusal(
        'bad-request',
        `params.fingerprintSources must be at most ${MAX_FINGERPRINT_SOURCES} sources, each an id and a hex hash or null.`,
      );
    if (!native && [...this.files.values()].some((file) => file.kind === 'directory'))
      return refusal('bad-request', 'Directory entries require a native build request.');
    const android = platform === 'android' ? androidOptions(params.android) : null;
    if (platform === 'android' && !android) {
      return refusal(
        'bad-request',
        'An android build needs params.android: variant and abi (string or null), gradleBuildCache, pch and compilerCache.',
      );
    }
    let macos: BuildStartParams['macos'] = null;
    if (platform === 'macos') {
      const parsed = macosBuildOptions(params);
      if ('error' in parsed) return parsed;
      macos = parsed.options;
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
    const toolchain = await this.host.toolchain(null, native?.provider);
    if (this.closed) return refusal('build-refused', 'The connection closed.');
    if (!toolchain || toolchain.stimBuild !== params.stimBuild) {
      return refusal('build-refused', `This machine runs Stim build ${toolchain?.stimBuild ?? 'unknown'}.`);
    }
    const launched = this.host.launch({
      client: this.client,
      repo: params.repo,
      session: this,
      send: this.send,
      job: {
        manifest: [...this.files.values()],
        platform,
        ...(native ? { native } : {}),
        android,
        macos,
        project: params.project,
        isExpo: params.isExpo === true,
        cacheArtifact: params.cacheArtifact === true,
        stimBuild: params.stimBuild,
        configuration: optional(params.configuration),
        scheme: optional(params.scheme),
        iosProjectPath: optional(params.iosProjectPath),
        runtime: optional(params.runtime),
        expectedFingerprint: params.fingerprint as string | null,
        ...(expectedSources ? { expectedSources } : {}),
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
    const streamed = await this.streamArtifact(job.archive, outcome.artifact);
    if (streamed) return streamed;
    const handoff = this.host.retain(job, outcome.artifact);
    this.jobs.delete(job.id);
    this.host.forget(job);
    return { result: { ...outcome.artifact, ...(handoff ? { handoff } : {}) } };
  }

  async cachedArtifact(params: unknown): Promise<{ result: CachedBuildArtifact | null } | Refusal> {
    if (!isJsonObject(params) || !validRepo(params.repo) || !validArtifactIdentity(params.artifact))
      return refusal('bad-request', 'A cached artifact needs its repository and complete identity.');
    if (this.closed) return refusal('build-refused', 'The connection closed.');
    if (
      params.gradleArtifact !== undefined ||
      params.reactNativeArtifact !== undefined ||
      params.swiftpmArtifact !== undefined
    ) {
      if (
        [params.gradleArtifact, params.reactNativeArtifact, params.swiftpmArtifact].filter(
          (value) => value !== undefined,
        ).length > 1
      )
        return refusal('bad-request', 'Choose one completed artifact query.');
      const query =
        params.gradleArtifact !== undefined
          ? gradleArtifactQuery(params.gradleArtifact)
          : params.swiftpmArtifact !== undefined
            ? swiftpmArtifactQuery(params.swiftpmArtifact)
            : reactNativeArtifactQuery(params.reactNativeArtifact);
      if (!query) return refusal('bad-request', 'Choose the completed source and build options.');
      const current =
        'sourceDigest' in query
          ? await this.host.privateArtifact(this.client, params.repo, query, this.transfers.signal)
          : await this.host.cache(this.client, params.repo).lookupReactNative(query, this.transfers.signal);
      if (
        !current ||
        current.fingerprint !== params.artifact.fingerprint ||
        current.cacheKey !== params.artifact.cacheKey
      )
        return { result: null };
    } else if (
      params.artifact.cacheKey.startsWith('react-native-') ||
      params.artifact.cacheKey.startsWith('swiftpm-peer-') ||
      (await this.host.cache(this.client, params.repo).lookup(params.artifact, this.transfers.signal))?.androidPackage
    ) {
      return refusal('bad-request', 'This cached artifact needs a current build query.');
    }
    const area = join(this.host.clientDir(this.client), 'repos', params.repo);
    mkdirSync(area, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(area, '.artifact-fetch-'));
    try {
      const cached = await this.host
        .cache(this.client, params.repo)
        .fetch(params.artifact, temporary, this.transfers.signal);
      if (!cached) return { result: null };
      const streamed = await this.streamArtifact(cached.path, cached.artifact);
      return streamed ?? { result: cached.artifact };
    } catch (error) {
      return refusal(
        'build-refused',
        `The cached artifact could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async streamArtifact(archive: string, artifact: BuildArtifactResult): Promise<Refusal | null> {
    const header = Buffer.from(artifact.sha256, 'hex');
    const fd = openSync(archive, 'r');
    try {
      const buffer = Buffer.alloc(ARTIFACT_CHUNK);
      for (let offset = 0; offset < artifact.size;) {
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
    return null;
  }

  close(dropped: boolean): void {
    this.closed = true;
    this.transfers.abort();
    this.host.ended(this);
    for (const job of this.jobs.values()) {
      if (dropped) this.host.detach(job);
      else this.host.abandon(job);
    }
    this.jobs.clear();
    if (this.incoming) rmSync(this.incoming.tmp, { force: true });
    this.incoming = null;
  }
}
