import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import {
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import {
  buildWorkerRoot,
  isJsonObject,
  liveOffloadedClients,
  loadConfig,
  machineCapacity,
  maxOffloadedBuilds,
  saturation,
  stimBuildId,
  tryAcquireBuildSlotClaim,
} from '@stim-cli/core/state';
import {
  reactNativeArtifactQuery,
  reusableDependencies,
  swiftpmArtifactQuery,
  validMacosResourceDestination,
} from '@stim-cli/core';
import {
  BUILD_REPO_PATTERN,
  BUILD_RUBY_VERSION_PATTERN,
  type BuildAndroidOptions,
  type BuildArtifactIdentity,
  type BuildArtifactResult,
  type BuildAttachResult,
  type BuildCapacity,
  type BuildFile,
  type BuildFingerprintSource,
  type BuildGradleArtifactQuery,
  type BuildJobOutcome,
  type BuildOfferParams,
  type BuildOfferResult,
  type BuildProgressEvent,
  type BuildStartParams,
  type BuildSwiftpmArtifactQuery,
  type BuildSyncResult,
  type BuildToolchain,
  type CachedBuildArtifact,
  type ErrorCode,
  type ProtocolError,
} from '@stim-cli/core/protocol';
import {
  DEFAULT_BUILD_LIMITS,
  dropHandoff,
  gb,
  gradleUserHome,
  handoffTokens,
  killTree,
  listCommandLines,
  ownsWindowsGradleHome,
  probeToolchain,
  readAvailableMemory,
  readHandoff,
  recordAreaUse,
  unknownGradleProcess,
  workerFreeBytes,
  workerGradleDaemons,
  writeHandoff,
  type BuildLimits,
} from '@stim-cli/server/build';
import { SCHEMA } from '../../engine-store/schema.ts';
import { buildClaimRoot } from '../../engine-store/claims.ts';
import { takeLock } from '../../engine-store/locks.ts';
import { readManifest } from '../../engine-store/store.ts';
import { ownStoreEngine } from '../../daemon/engine-switch.ts';
import { getExecutor } from '../../exec.ts';
import { fingerprintEnvName } from '../../fingerprint/env.ts';
import { FINGERPRINT_SCHEMA, fingerprintInputsRow } from '../../fingerprint/key.ts';
import { spawnEntry } from '../../spawn-entry.ts';
import { BuildArtifactCache, validArtifactIdentity } from '../../offload/build-artifact-cache.ts';
import { exactOffloadParam, exactPinsParam, exactToolProblems } from '../../integrations/exact-offload.ts';
import { runArtifactQuery, type ArtifactQueryResult } from './artifact-query.ts';

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

function capacityLine(loadPerCore: number | null | undefined, running: number, diskFreeBytes: number | null): string {
  const disk = diskFreeBytes === null ? 'free disk unknown' : `${gb(diskFreeBytes)} GB free`;
  return `load ${loadPerCore}/core, ${running} offloaded build(s) running, ${disk}`;
}

const optional = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const MAX_FINGERPRINT_SOURCES = 20_000;

function fingerprintSources(value: unknown): BuildFingerprintSource[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FINGERPRINT_SOURCES) return null;
  const names = new Set<string>();
  const valid = value.every((source) => {
    if (
      !isJsonObject(source) ||
      Object.keys(source).some((key) => key !== 'id' && key !== 'kind' && key !== 'hash') ||
      typeof source.id !== 'string' ||
      source.id.length === 0 ||
      source.id.length > MAX_PATH_CHARS ||
      source.id.includes('\0') ||
      names.has(source.id) ||
      typeof source.kind !== 'string' ||
      !['file', 'package', 'config', 'autolinking', 'manifest', 'env'].includes(source.kind) ||
      typeof source.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(source.hash)
    )
      return false;
    names.add(source.id);
    return true;
  });
  return valid ? (value as BuildFingerprintSource[]) : null;
}

function fingerprintEnv(value: unknown): BuildStartParams['fingerprintEnv'] | null {
  if (!isJsonObject(value) || !isJsonObject(value.set) || !Array.isArray(value.absent)) return null;
  if (Object.keys(value).some((key) => key !== 'set' && key !== 'absent')) return null;
  const entries = Object.entries(value.set);
  if (entries.length > MAX_FINGERPRINT_SOURCES || value.absent.length > MAX_FINGERPRINT_SOURCES) return null;
  const names = new Set<string>();
  for (const [name, content] of entries) {
    if (!fingerprintEnvName(name) || name.length > MAX_PATH_CHARS) return null;
    if (typeof content === 'string') {
      if (content.includes('\0')) return null;
    } else if (
      !isJsonObject(content) ||
      Object.keys(content).length !== 1 ||
      typeof content.path !== 'string' ||
      !content.path ||
      content.path.length > MAX_PATH_CHARS ||
      content.path.includes('\0') ||
      content.path.startsWith('outside:') ||
      content.path.startsWith('/') ||
      win32.isAbsolute(content.path) ||
      /^[A-Za-z]:/.test(content.path) ||
      (content.path !== '<install>/' && content.path.split(/[\\/]/).some((part) => part === '..' || part === ''))
    )
      return null;
    names.add(name);
  }
  for (const name of value.absent) {
    if (typeof name !== 'string' || !fingerprintEnvName(name) || name.length > MAX_PATH_CHARS || names.has(name))
      return null;
    names.add(name);
  }
  return value as BuildStartParams['fingerprintEnv'];
}

function fingerprintInputs(
  value: unknown,
  project: unknown,
  sources: BuildFingerprintSource[],
): string[] | null | undefined {
  const row = sources.find((source) => source.id === 'stim:fingerprintInputs');
  if (value === undefined) return row ? null : undefined;
  if (!row || !Array.isArray(value) || value.length > MAX_FINGERPRINT_SOURCES || typeof project !== 'string')
    return null;
  const valid = value.every(
    (path) =>
      typeof path === 'string' &&
      path.length > 0 &&
      path.length <= MAX_PATH_CHARS &&
      !path.includes('\0') &&
      !posix.isAbsolute(path) &&
      !win32.isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !/^\.\.(?:\/|$)/.test(posix.normalize(posix.join(project || '.', path.replaceAll('\\', '/')))),
  );
  if (!valid) return null;
  const paths = value as string[];
  const expected = fingerprintInputsRow(paths);
  return row.kind === expected.kind && row.hash === expected.hash ? paths : null;
}

function fingerprintReplay(
  params: Record<string, unknown>,
  sources: BuildFingerprintSource[] | undefined,
): Pick<
  BuildStartParams,
  | 'fingerprintSchema'
  | 'fingerprintEnv'
  | 'fingerprintNative'
  | 'fingerprintLayout'
  | 'fingerprintRuntime'
  | 'fingerprintInputs'
> | null {
  const env = fingerprintEnv(params.fingerprintEnv);
  const layout = params.fingerprintLayout;
  const runtime = params.fingerprintRuntime;
  const declared = sources && fingerprintInputs(params.fingerprintInputs, params.project, sources);
  if (
    params.fingerprintSchema !== FINGERPRINT_SCHEMA ||
    !sources ||
    declared === null ||
    !env ||
    (params.fingerprintNative !== 'tracked' && params.fingerprintNative !== 'generated') ||
    !isJsonObject(layout) ||
    !['projectPath', 'gradleRoot', 'module'].every((key) => layout[key] === null || typeof layout[key] === 'string') ||
    !isJsonObject(runtime) ||
    typeof runtime.node !== 'string' ||
    !/^\d+\.\d+$/.test(runtime.node) ||
    typeof runtime.evaluator !== 'string' ||
    !/^[0-9a-f]{64}$/.test(runtime.evaluator) ||
    !isJsonObject(runtime.packages) ||
    !Object.values(runtime.packages).every((value) => value === null || typeof value === 'string')
  )
    return null;
  return {
    fingerprintSchema: FINGERPRINT_SCHEMA,
    fingerprintEnv: env,
    fingerprintNative: params.fingerprintNative,
    fingerprintLayout: layout as BuildStartParams['fingerprintLayout'],
    fingerprintRuntime: runtime as BuildStartParams['fingerprintRuntime'],
    ...(declared ? { fingerprintInputs: declared } : {}),
  };
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
          compat: params.compat,
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
    Object.keys(value).some((key) => !['project', 'sourceDigest', 'inputs', 'android', 'jdk'].includes(key)) ||
    (value.jdk !== undefined && (typeof value.jdk !== 'string' || !/^[0-9]{1,3}$/.test(value.jdk)))
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
        ...(typeof value.jdk === 'string' ? { jdk: value.jdk } : {}),
        sourceDigest,
        inputs: { complete: true, ignored: inputs.ignored, outputs: inputs.outputs },
        android: { ...android, variant: android.variant },
      }
    : null;
}

interface Job {
  id: string;
  client: string;
  repo: string;
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
  cleanupSettled: boolean;
  cancel: () => void;
  done: Promise<void>;
  send: (event: BuildProgressEvent) => void;
  session: BuildSession | null;
  grace: NodeJS.Timeout | null;
}

type CachedArtifactRequest = Record<string, unknown> & { repo: string; artifact: BuildArtifactIdentity };

const nowhere = (): void => {};

function podsOnWorkerJob(params: Record<string, unknown>): { podsOnWorker?: true; reuseArtifact?: true } {
  if (params.podsOnWorker !== true) return {};
  return { podsOnWorker: true, ...(params.reuseArtifact === true ? { reuseArtifact: true } : {}) };
}

export interface BuildHostOptions {
  /** The script that runs the offload worker's modes, started as `<node> <worker> ...workerArgs <mode>`. */
  worker: string;
  workerArgs?: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The environment now: the tools installed since `env` was built, such as Homebrew's directory. Absent means `env`. */
  currentEnv?: () => NodeJS.ProcessEnv;
  limits?: Partial<BuildLimits>;
  /** Called once a job ends, for the action log. */
  finished?: (record: { client: string; repo: string; ok: boolean; error?: ProtocolError; durationMs: number }) => void;
}

/** Runs one client's offloaded iOS, Android and macOS builds in its areas under the worker root, for one offload job. */
export class BuildHost {
  readonly limits: BuildLimits;
  private readonly jobs = new Set<Job>();
  private readonly owned = new Map<string, Job>();
  private readonly queries = new Set<{
    client: string;
    repo: string;
    run: ReturnType<typeof runArtifactQuery>;
    settled: boolean;
  }>();
  private closed = false;
  private readonly toolchains = new Map<string, { at: number; value: Promise<BuildToolchain | null> }>();
  private readonly options: BuildHostOptions;

  constructor(options: BuildHostOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_BUILD_LIMITS, ...options.limits };
  }

  private workerCommand(...mode: string[]): string[] {
    return [this.options.worker, ...(this.options.workerArgs ?? []), ...mode];
  }

  private environment(): NodeJS.ProcessEnv {
    return this.options.currentEnv?.() ?? this.options.env;
  }

  private async drainCancelledAndroid(client: string, repo: string): Promise<boolean> {
    try {
      const daemons = workerGradleDaemons(await listCommandLines(), this.root(), process.platform, [
        { client, repo },
      ]).filter((daemon) => daemon.client === client && daemon.repo === repo);
      if (
        process.platform === 'win32' &&
        daemons.length > 0 &&
        !ownsWindowsGradleHome(join(this.clientDir(client), 'repos', repo))
      ) {
        throw new Error('The repository Gradle home has no matching owner key.');
      }
      const identities = daemons.map(({ pid }) => {
        const captured = captureProcessIdentity(pid);
        if (!captured.ok) throw new Error(`Cannot identify Gradle daemon ${pid}.`);
        return { pid, processToken: captured.token };
      });
      const home = gradleUserHome(join(this.clientDir(client), 'repos', repo));
      const known = new Set(identities.map(({ pid }) => pid));
      for (const identity of identities) {
        const state = inspectProcessIdentity(identity);
        if (state === 'gone') continue;
        if (state !== 'same') throw new Error('Gradle daemon identity changed.');
        if (process.platform === 'win32') await killTree(identity.pid);
        else {
          try {
            process.kill(-identity.pid, 'SIGTERM');
          } catch {
            process.kill(identity.pid, 'SIGTERM');
          }
        }
      }
      const deadline = Date.now() + this.limits.killGraceMs;
      let forced = false;
      for (;;) {
        const unknown = unknownGradleProcess(home, known);
        const pending = identities.some(
          (identity) => inspectProcessIdentity(identity) === 'same' || processGroupAlive(identity.pid),
        );
        if (!unknown && !pending) break;
        if (unknown && !pending && !forced && Date.now() >= deadline) throw unknown;
        if (Date.now() >= deadline + 5000) {
          if (unknown) throw unknown;
          return false;
        }
        if (!forced && Date.now() >= deadline) {
          for (const identity of identities) {
            const state = inspectProcessIdentity(identity);
            if (state === 'unknown' || state === 'different') return false;
            if (process.platform !== 'win32') {
              try {
                process.kill(-identity.pid, 'SIGKILL');
              } catch {
                if (state === 'same') process.kill(identity.pid, 'SIGKILL');
              }
            }
          }
          forced = true;
        }
        await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
      }
      return (
        identities.every((identity) => ['gone', 'different'].includes(inspectProcessIdentity(identity))) &&
        !workerGradleDaemons(await listCommandLines(), this.root(), process.platform, [{ client, repo }]).some(
          (daemon) => daemon.client === client && daemon.repo === repo,
        )
      );
    } catch (error) {
      console.error(`stim-server: retaining cancelled Android claims for ${client}/${repo}: ${String(error)}`);
      return false;
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
    const args = native ? [`offer-native-${native}`] : ['offer', ...(rubyVersion ? [rubyVersion] : [])];
    const value = probeToolchain(this.workerCommand(...args), this.environment());
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
    const exactPins = params.exact === undefined ? undefined : exactPinsParam(params.exact);
    if (exactPins === null || (exactPins !== undefined && params.native !== undefined))
      return refusal('bad-request', 'An Exact offer needs the exact2 commit and the Bun and Rust versions.');
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
    const repo = params.repo;
    const lookup = params.artifact;
    const artifact = await (async () =>
      swiftpm !== undefined
        ? this.privateArtifact(client, repo, swiftpm, signal)
        : reactNative !== undefined
          ? this.cache(client, repo).lookupReactNative(reactNative, signal)
          : query !== undefined
            ? this.privateArtifact(client, repo, query, signal)
            : lookup === undefined
              ? undefined
              : this.cache(client, repo).lookup(lookup, signal))();
    if (this.closed || signal.aborted)
      return refusal('build-refused', 'This build connection closed during the offer.');
    const toolchain = await this.toolchain((params.rubyVersion as string | undefined) ?? null, params.native);
    if (this.closed || signal.aborted)
      return refusal('build-refused', 'This build connection closed during the offer.');
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
            reusableDependencies(area, dependencies.project, params.lockfile, this.environment()),
          build: false,
        },
        ...(artifact !== undefined ? { artifact } : {}),
        ...(exactPins ? { exact: { missing: exactToolProblems(exactPins, this.environment()) } } : {}),
      },
    };
  }

  private artifactCacheDir(client: string, repo: string): string {
    return join(this.clientDir(client), 'repos', repo, 'artifact-cache');
  }

  cache(client: string, repo: string): BuildArtifactCache {
    return new BuildArtifactCache(this.artifactCacheDir(client, repo));
  }

  private workerEnvironment(clientDir: string, area: string): NodeJS.ProcessEnv {
    return {
      ...this.environment(),
      STIM_HOME: join(area, 'home'),
      CP_HOME_DIR: join(clientDir, 'cache', 'cocoapods-home'),
      CP_CACHE_DIR: join(clientDir, 'cache', 'cocoapods'),
      npm_config_store_dir: join(clientDir, 'cache', 'pnpm-store'),
      GRADLE_USER_HOME: gradleUserHome(area),
    };
  }

  async privateArtifact(
    client: string,
    repo: string,
    query: BuildGradleArtifactQuery | BuildSwiftpmArtifactQuery,
    signal: AbortSignal,
  ): Promise<CachedBuildArtifact | null> {
    try {
      if (this.closed || this.queries.size >= 4) return null;
      const cache = this.cache(client, repo);
      const receipt = await cache.receipt(query, signal);
      if (!receipt || this.closed || signal.aborted || this.queries.size >= 4) return null;
      const clientDir = this.clientDir(client),
        area = join(clientDir, 'repos', repo);
      const run = runArtifactQuery({
        command: this.workerCommand(),
        area,
        env: this.workerEnvironment(clientDir, area),
        query,
        receipt,
        signal,
        killGraceMs: this.limits.killGraceMs,
      });
      const entry = { client, repo, run, settled: false };
      this.queries.add(entry);
      try {
        const result = await run.done;
        entry.settled = result.settled;
        if (!result.settled)
          throw new Error(
            "Native artifact lookup cleanup is unresolved; inspect this machine's server logs before retrying.",
          );
        if (!result.identity || signal.aborted || this.closed) return null;
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
        'This machine could not verify the completed artifact inputs or their cleanup; inspect its server logs before retrying.',
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
      compat: job.compat,
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

  /** Why the worker root's volume cannot take `bytes` more, or null when it can. */
  lowDisk(bytes = 0): string | null {
    const free = workerFreeBytes(this.root());
    return free !== null && free - bytes < this.limits.minFreeBytes
      ? `${gb(free)} GB free, builds need ${gb(this.limits.minFreeBytes)} GB`
      : null;
  }

  capacity(): BuildCapacity {
    return this.assess().capacity;
  }

  private assess(): { capacity: BuildCapacity; numbers: string | null } {
    const machine = machineCapacity();
    const running = liveOffloadedClients().length + [...this.jobs].filter((job) => !job.slotted).length;
    const max = maxOffloadedBuilds();
    const diskFreeBytes = workerFreeBytes(this.root());
    const builds = machine.builds + [...this.jobs].filter((job) => !job.slotted).length;
    const limit =
      max > 0 && running >= max
        ? `already running ${running} offloaded build(s), its server.maxOffloadedBuilds limit`
        : null;
    const stopped =
      (loadConfig()?.server?.buildsPaused === true
        ? 'Incoming builds are paused; resume with stim settings set server.buildsPaused false'
        : null) ?? (limit ? null : this.lowDisk());
    const busy = stopped ? null : (limit ?? saturation({ ...machine, builds }));
    const capacity: BuildCapacity = {
      running,
      max,
      diskFreeBytes,
      minDiskFreeBytes: this.limits.minFreeBytes,
      cpus: machine.cpus,
      loadPerCore: machine.loadPerCore,
      builds,
      maxBuilds: machine.maxBuilds,
      maxLoadPerCore: machine.maxLoadPerCore,
      declined: stopped ?? busy,
    };
    return { capacity, numbers: busy && capacityLine(machine.loadPerCore, running, diskFreeBytes) };
  }

  session(client: string, socket: BuildSocket, send: (event: BuildProgressEvent) => void): BuildSession {
    return new BuildSession(this, client, socket, send);
  }

  /**
   * Deletes the blobs of `client` that no `mirror.json` of its repositories and no open connection's manifest
   * references, unless a build of that client runs.
   */

  /** Starts the build of one synced manifest; the job belongs to the caller's connection. */
  async launch(options: {
    client: string;
    repo: string;
    job: Record<string, unknown>;
    session: BuildSession;
    send: (event: BuildProgressEvent) => void;
  }): Promise<Job | Refusal> {
    const engine = ownStoreEngine();
    const ownership: { claim: ClaimHandle | null; transferred: boolean } = { claim: null, transferred: false };
    let result: Job | Refusal;
    try {
      result = await (async () => {
        if (this.closed || options.session.signal.aborted)
          return refusal('build-refused', 'This offload job is ending.');
        if (engine) {
          const lock = await takeLock(engine.root, '.lock.sock');
          if (!lock) return refusal('build-busy', 'The engine store is busy; retry the build.');
          try {
            if (this.closed || options.session.signal.aborted)
              return refusal('build-refused', 'This offload job is ending.');
            const tree = join(engine.root, engine.build);
            const manifest = readManifest(tree);
            if (!manifest || manifest.build !== engine.build || !existsSync(join(tree, 'dist', 'cli.mjs')))
              return refusal('build-refused', 'The selected engine is unavailable; update Stim and retry.');
            const attempt = tryAcquireClaim({
              root: buildClaimRoot(engine.root, engine.build),
              mode: 'shared',
              label: 'offload engine',
              details: { drained: false },
            });
            if (attempt.pending) releaseClaim(attempt.pending);
            if (!attempt.acquired) return refusal('build-busy', 'The selected engine is busy; retry the build.');
            ownership.claim = attempt.acquired;
          } finally {
            await lock.release();
          }
        }
        if (this.closed || options.session.signal.aborted)
          return refusal('build-refused', 'This offload job is ending.');
        return this.launchOwned(options, ownership.claim, () => {
          ownership.transferred = true;
        });
      })();
    } catch (error) {
      result = refusal('build-refused', `Cannot retain the selected engine: ${String(error)}`);
    }
    if (!ownership.transferred && ownership.claim && !releaseClaim(ownership.claim))
      return refusal(
        'build-refused',
        `Cannot release the selected engine claim at ${ownership.claim.path}; verify the job stopped and remove that claim before retrying.`,
      );
    return result;
  }

  private launchOwned(
    {
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
    },
    engineClaim: ClaimHandle | null,
    transfer: () => void,
  ): Job | Refusal {
    if (this.closed) return refusal('build-refused', 'This offload job is ending.');
    const { capacity, numbers } = this.assess();
    if (capacity.declined)
      return refusal(
        'build-busy',
        `This machine declines the build: ${capacity.declined}${numbers ? ` (${numbers})` : ''}.`,
      );
    const clientDir = this.clientDir(client);
    const area = join(clientDir, 'repos', repo);
    if (job.platform === 'android') {
      try {
        const unknown = unknownGradleProcess(gradleUserHome(clientDir), new Set());
        if (unknown) throw unknown;
      } catch (error) {
        return refusal('build-busy', `Inspect this client's legacy Gradle processes before retrying: ${String(error)}`);
      }
    }
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
      const slotReleased = !slot || releaseClaim(slot);
      const areaReleased = releaseClaim(claim);
      const engineReleased = !engineClaim || releaseClaim(engineClaim);
      return slotReleased && areaReleased && engineReleased;
    };
    const maxBuilds = machineCapacity().maxBuilds;
    try {
      const taken =
        maxBuilds > 0
          ? tryAcquireBuildSlotClaim({ max: maxBuilds, details: { offloaded: true, client, repo, job: id } })
          : null;
      if (maxBuilds > 0 && !taken) {
        releaseClaim(claim);
        return refusal(
          'build-busy',
          `This machine declines the build: all ${maxBuilds} build slots busy (${capacityLine(capacity.loadPerCore, capacity.running, capacity.diskFreeBytes)}).`,
        );
      }
      slot = taken?.claim ?? null;
    } catch (error) {
      releaseClaim(claim);
      return refusal('build-refused', (error as Error).message);
    }
    try {
      useAreaHome(area);
    } catch (error) {
      releaseClaims();
      return refusal('build-refused', String(error));
    }
    recordAreaUse(area);
    const fingerprintTemp = join(area, 'fingerprint-work', id);
    try {
      mkdirSync(fingerprintTemp, { recursive: true, mode: 0o700 });
    } catch (error) {
      releaseClaims();
      return refusal('build-refused', `Cannot create the fingerprint work directory: ${String(error)}`);
    }
    const started = Date.now();
    try {
      markClaimChildPending(claim);
      if (slot) markClaimChildPending(slot);
      if (engineClaim) markClaimChildPending(engineClaim);
    } catch (error) {
      try {
        rmSync(fingerprintTemp, { recursive: true, force: true });
      } finally {
        releaseClaims();
      }
      return refusal('build-refused', (error as Error).message);
    }
    let child: ChildProcess;
    try {
      child = getExecutor().spawn(process.execPath, this.workerCommand('build'), {
        cwd: area,
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: this.workerEnvironment(clientDir, area),
      });
      transfer();
    } catch (error) {
      try {
        rmSync(fingerprintTemp, { recursive: true, force: true });
      } finally {
        releaseClaims();
      }
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
      if (!captured?.ok) cancel();
    } catch {
      cancel();
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end(
      JSON.stringify({
        ...job,
        job: id,
        area,
        fingerprintTemp,
        blobs: join(clientDir, 'blobs'),
        swiftpmCache: join(clientDir, 'cache', 'swiftpm'),
        artifactCache: this.artifactCacheDir(client, repo),
      }),
    );
    const timeout = setTimeout(cancel, this.limits.timeoutMs);
    const entry: Job = {
      id,
      client,
      repo,
      platform: job.platform,
      child,
      archive: join(area, 'out', id, 'app.tgz'),
      slotted: slot !== null,
      outcome: null,
      settled: false,
      cleanupSettled: false,
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
        entry.cleanupSettled =
          value.fingerprintSettled === true &&
          (value.ok === true
            ? entry.outcome.ok
            : value.ok === false && typeof value.code === 'string' && typeof value.message === 'string');
      }
    });
    this.jobs.add(entry);
    this.owned.set(id, entry);
    entry.done = new Promise<void>((resolve) => {
      let spawnFailed = false;
      child.on('error', () => {
        if (child.pid === undefined) spawnFailed = true;
      });
      child.on('close', () => {
        clearTimeout(timeout);
        const outcome: BuildJobOutcome =
          entry.outcome ??
          (killTimer
            ? { ok: false, code: 'cancelled', message: 'The build was cancelled.' }
            : { ok: false, code: 'worker-exited', message: 'The build process exited without a result.' });
        const abnormal = !entry.outcome;
        entry.outcome = outcome;
        if (child.pid !== undefined && processGroupAlive(child.pid)) cancel();
        const drainAndroid = job.platform === 'android' && (killTimer !== null || abnormal || !outcome.ok);
        const settle = async () => {
          if (child.pid !== undefined && processGroupAlive(child.pid)) {
            setTimeout(settle, GROUP_POLL_MS).unref();
            return;
          }
          await treeKilled;
          if (killTimer) clearTimeout(killTimer);
          finished = true;
          const drained = !drainAndroid || (await this.drainCancelledAndroid(client, repo));
          let released = false;
          if (drained && (entry.cleanupSettled || spawnFailed)) {
            try {
              rmSync(fingerprintTemp, { recursive: true, force: true });
            } catch {}
            released = releaseClaims();
          }
          if (!released) {
            entry.cleanupSettled = false;
            entry.outcome = {
              ok: false,
              code: 'cleanup-unresolved',
              message: `Build cleanup is unresolved. Verify the worker and its descendants have stopped, then remove ${fingerprintTemp} and recover the repository claim at ${claim.path}${slot ? `, build-slot claim at ${slot.path}` : ''}${engineClaim ? `, and engine claim at ${engineClaim.path}` : ''} before retrying.`,
            };
          }
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
              query.fingerprint === entry.outcome.fingerprint &&
              (entry.outcome.fingerprint === job.expectedFingerprint || job.podsOnWorker === true) &&
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

  /** Cancels a job and deletes its archive once its process group is gone. */
  abandon(job: Job): void {
    if (job.grace) clearTimeout(job.grace);
    job.grace = null;
    job.session = null;
    job.send = nowhere;
    job.cancel();
    this.owned.delete(job.id);
    void job.done.then(() => {
      if (job.cleanupSettled) rmSync(dirname(job.archive), { recursive: true, force: true });
      return undefined;
    });
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
   * which this returns, in place of any bundle its client still had retained for the same repository.
   */
  retain(job: Job, artifact: BuildArtifactResult): string | null {
    const dir = dirname(job.archive);
    if (this.closed || basename(artifact.name) !== artifact.name) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    rmSync(job.archive, { force: true });
    const clientDir = this.clientDir(job.client);
    for (const token of handoffTokens(clientDir))
      if (readHandoff(clientDir, token)?.repo === job.repo) dropHandoff(clientDir, token);
    return writeHandoff(clientDir, {
      repo: job.repo,
      dir,
      bundle: join(dir, artifact.name),
      sha256: artifact.sha256,
      expiresAt: Date.now() + this.limits.handoffMs,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.owned.values()) this.abandon(job);
    await this.stopQueries();
    await Promise.all([...this.jobs].map((job) => job.done));
  }
}

// compat C14 permanent
/**
 * Makes the area's Stim home ready for this build, which runs the client's own Stim: `area.json` records the build and
 * home schema that last used it, and a home of another schema is replaced by an empty one.
 */
function useAreaHome(area: string): void {
  const record = join(area, 'area.json');
  let schema: unknown = SCHEMA;
  try {
    schema = (JSON.parse(readFileSync(record, 'utf8')) as { schema?: unknown }).schema;
  } catch {}
  if (schema !== SCHEMA) rmSync(join(area, 'home'), { recursive: true, force: true });
  mkdirSync(join(area, 'home'), { recursive: true, mode: 0o700 });
  writeFileSync(record, `${JSON.stringify({ build: stimBuildId(dirname(spawnEntry('cli'))), schema: SCHEMA })}\n`);
}
// compat end

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
        ...(value.reused === true ? { reused: true } : {}),
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
 * One connection's manifest, blob uploads and jobs. Closing the connection cancels its jobs; stimd keeps the job of a
 * dropped connection for a new connection to take over.
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

  syncedRepo(): string | null {
    return this.repo;
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
        `params.fingerprintSources must contain unique typed inputs with SHA-256 hashes (at most ${MAX_FINGERPRINT_SOURCES}).`,
      );
    let replay: Pick<
      BuildStartParams,
      | 'fingerprintSchema'
      | 'fingerprintEnv'
      | 'fingerprintNative'
      | 'fingerprintLayout'
      | 'fingerprintRuntime'
      | 'fingerprintInputs'
    > = {};
    if (!native && platform !== 'macos') {
      const parsed = fingerprintReplay(params, expectedSources);
      if (!parsed) return refusal('bad-request', 'build.start needs a compatible fingerprint replay description.');
      replay = parsed;
    }
    if (!native && [...this.files.values()].some((file) => file.kind === 'directory'))
      return refusal('bad-request', 'Directory entries require a native build request.');
    const android = platform === 'android' ? androidOptions(params.android) : null;
    if (platform === 'android' && !android) {
      return refusal(
        'bad-request',
        'An android build needs params.android: variant and abi (string or null), gradleBuildCache, pch and compilerCache.',
      );
    }
    const exact = params.exact === undefined ? undefined : exactOffloadParam(params.exact);
    if (exact === null || (exact !== undefined && (platform !== 'ios' || native)))
      return refusal('bad-request', 'An Exact build needs an iOS request with its app name, pins and settings.');
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
    if (typeof params.compat !== 'number') return refusal('bad-request', 'build.start needs params.compat.');
    const compat = params.compat;
    const launched = await this.host.launch({
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
        ...podsOnWorkerJob(params),
        ...(exact ? { exact } : {}),
        stimBuild: params.stimBuild,
        compat,
        ...(typeof params.jdk === 'string' ? { jdk: params.jdk } : {}),
        configuration: optional(params.configuration),
        scheme: optional(params.scheme),
        iosProjectPath: optional(params.iosProjectPath),
        runtime: optional(params.runtime),
        expectedFingerprint: params.fingerprint as string | null,
        ...replay,
        ...(expectedSources ? { expectedSources } : {}),
        optimizations: isJsonObject(params.optimizations) ? params.optimizations : null,
      },
    });
    if ('error' in launched) return launched;
    if (this.closed) {
      this.host.abandon(launched);
      return refusal('build-refused', 'This offload job is ending.');
    }
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
    const request = { ...params, repo: params.repo, artifact: params.artifact };
    return this.serveCachedArtifact(request);
  }

  private async serveCachedArtifact(
    params: CachedArtifactRequest,
  ): Promise<{ result: CachedBuildArtifact | null } | Refusal> {
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
    if (!(await this.host.cache(this.client, params.repo).lookup(params.artifact, this.transfers.signal)))
      return { result: null };
    const area = join(this.host.clientDir(this.client), 'repos', params.repo);
    const temporary = await mkdtemp(join(area, '.artifact-fetch-'));
    try {
      const cached = await this.host
        .cache(this.client, params.repo)
        .fetch(params.artifact, temporary, this.transfers.signal);
      if (!cached) return { result: null };
      recordAreaUse(area);
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

  /** Cancels this session's jobs: the client closed the connection, or the job is ending. */
  close(): void {
    this.closed = true;
    this.transfers.abort();
    for (const job of this.jobs.values()) this.host.abandon(job);
    this.jobs.clear();
    if (this.incoming) rmSync(this.incoming.tmp, { force: true });
    this.incoming = null;
  }
}
