import { readFile, readlink, realpath } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { WebSocket } from 'ws';
import {
  automaticMachineEnabled,
  requireAutomaticMachine,
  isJsonObject,
  runId,
  OFFLOAD_MODES,
  saturation,
  type BuildMachineCredential,
  type MachineCapacity,
  type OffloadMode,
} from '@stim-cli/core/state';
import type { CcacheActivity, CompilationCacheActivity } from '../engine/build-facts.ts';
import { CCACHE_NOT_RUN, CCACHE_UNAVAILABLE } from '../engine/ccache.ts';
import { COMPILATION_CACHE_NOT_RUN, COMPILATION_CACHE_UNAVAILABLE } from '../engine/xcode.ts';
import { COMPILATION_CACHE_CORRUPT } from '../cache/compilation-cache-corruption.ts';
import { debugLog } from '../debug-log.ts';
import { reportRemoteFailure } from '../remote-log.ts';
import { getExecutor } from '../exec.ts';
import { git, gitAsync } from '../workspace/git.ts';
import { reportSignal } from '../report-runtime.ts';
import { readRubyVersion } from '../engine/deps.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { operationState } from '../engine/operation-state.ts';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines, resolveEndpoint, type Endpoint } from './build-machines.ts';
import { openAuthenticated, sayHello, type ConnectFailure } from './tailnet.ts';
import type { NoiseSocket } from '@stim-cli/core/noise-session';
import { manifestDigest } from './manifest.ts';
import {
  checkNativeTransferMembership,
  gitVisiblePaths,
  nativeTransferManifest,
  sourceManifest,
  type NativeTransferFile,
} from './native-source.ts';
import { nativeGradleTransfer, type GradleTransfer } from '../integrations/native-gradle-inputs.ts';
import type { NativeInputSnapshot } from '../integrations/native-inputs.ts';
import type { FingerprintSource } from '@expo/fingerprint';
import { reactNativeBuildQuery } from './react-native-artifact.ts';
import { namedBuildMachine, OffloadRefusal, workerFailureReason } from './selection.ts';
import type { PlacementCandidate } from '../placement-log.ts';
import {
  toolchainMismatches,
  toolchainNotes,
  cocoapodsDifference,
  type BuildTarget,
  type OffloadProblem,
  type WorkerToolchain,
} from './toolchain.ts';
import { ambientContext, dependencyLockfile, swiftpmArtifactQuery, type StimContext } from '@stim-cli/core';
import type {
  BuildArtifactIdentity,
  BuildOfferParams,
  BuildGradleArtifactQuery,
  BuildReactNativeArtifactQuery,
  BuildSwiftpmArtifactQuery,
  CachedBuildArtifact,
} from '@stim-cli/core/protocol';

const CONNECT_TIMEOUT_MS = 10_000;
const OFFER_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 65 * 60_000;
const PING_MS = 15_000;
const SILENT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2000;
const CLOSE_ABNORMAL = 1006;
const TURNED_AWAY = new Set(['unauthorized', 'forbidden', 'protocol-unsupported', 'server-key-mismatch']);
const RESUME_WINDOW_MS = 3 * 60_000;
const RESUME_DELAY_MS = 2000;
const RESUME_MAX_DELAY_MS = 15_000;
const PAGE_BYTES = 48 * 1024;
const CHUNK_BYTES = 60 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const DIGEST_BYTES = 32;

function offloadMode(env: NodeJS.ProcessEnv = ambientContext()?.env ?? process.env): OffloadMode {
  const raw = env.STIM_REMOTE_BUILD_MODE || loadConfig()?.remote?.buildMode;
  return OFFLOAD_MODES.includes(raw as OffloadMode) ? (raw as OffloadMode) : 'auto';
}

export function buildPlacementCandidates(selected: string): {
  mode: OffloadMode;
  machines: BuildMachineCredential[];
  localEnabled: boolean;
} {
  const config = loadConfig();
  return {
    localEnabled: selected !== 'auto' || automaticMachineEnabled('build', 'local', config),
    mode: selected === 'local' ? 'off' : offloadMode(),
    machines:
      selected === 'local'
        ? []
        : namedBuildMachine(selected)
          ? pairedMachines([selected]).slice(0, 1)
          : pairedMachines().filter((entry) => automaticMachineEnabled('build', entry.machine, config)),
  };
}

export function remotePhaseText(name: string, msg: string, machine: string): string {
  const text = msg.trim();
  return `${text.startsWith(`${name} `) ? text.slice(name.length).trimStart() : text} (on ${machine})`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function capacityText(capacity: Pick<MachineCapacity, 'loadPerCore' | 'builds' | 'maxBuilds'>): string {
  const builds =
    capacity.maxBuilds > 0
      ? `${capacity.builds} of ${capacity.maxBuilds} build slots busy`
      : plural(capacity.builds, 'build');
  return `load ${capacity.loadPerCore}/core, ${builds}`;
}

export function placementLoad(choice: { offer: BuildOffer }): string {
  const { loadPerCore, builds, maxBuilds } = choice.offer.capacity;
  if (typeof loadPerCore !== 'number' || typeof builds !== 'number') return '';
  return `; ${capacityText({ loadPerCore, builds, maxBuilds: maxBuilds ?? 0 })} there`;
}

/**
 * Whether a build may go to a remote machine at all, before any machine is asked. `auto` keeps the build here while
 * this machine has a free `concurrency.maxBuilds` slot and its load per core is under `server.maxLoadPerCore`.
 * A named selection ignores local capacity and mode, and refuses an unsupported build or missing pairing.
 */
export function offloadPlacement({
  mode,
  machines,
  here,
  unsupported,
  localEnabled = true,
  selected = 'auto',
}: {
  selected?: string;
  mode: OffloadMode;
  machines: number;
  here: MachineCapacity;
  unsupported: string | null;
  localEnabled?: boolean;
}): { offload: boolean; code: string; reason: string } {
  if (namedBuildMachine(selected)) {
    if (unsupported) throw new OffloadRefusal(selected, `${unsupported}, so a named remote machine cannot take it`);
    if (machines === 0) throw new OffloadRefusal(selected, 'no remote machine is paired');
    return { offload: true, code: 'named', reason: `selected with --remote-build ${selected}` };
  }
  if (selected === 'local') return { offload: false, code: 'local-selected', reason: '--remote-build local' };
  if (!localEnabled) {
    const reason =
      mode === 'off'
        ? 'remote.buildMode is off'
        : (unsupported ?? (machines === 0 ? 'no enabled remote machine is paired' : null));
    if (reason) throw new OffloadRefusal('auto', `${reason}; local is disabled in remote.buildPoolDisabled`);
    return { offload: true, code: 'local-disabled', reason: 'local is disabled in remote.buildPoolDisabled' };
  }
  if (mode === 'off') return { offload: false, code: 'mode-off', reason: 'remote.buildMode is off' };
  if (machines === 0) return { offload: false, code: 'no-remote-mac', reason: 'no remote machine is paired' };
  if (unsupported) return { offload: false, code: 'unsupported', reason: unsupported };
  if (mode === 'force') return { offload: true, code: 'forced', reason: 'remote.buildMode is force' };
  const busy = saturation(here);
  return busy
    ? { offload: true, code: 'this-mac-busy', reason: `this machine is busy: ${busy} (${capacityText(here)})` }
    : { offload: false, code: 'this-mac-free', reason: `${capacityText(here)} here` };
}

export interface BuildOffer {
  toolchain: WorkerToolchain;
  capacity: {
    running: number;
    max: number;
    diskFreeBytes: number | null;
    minDiskFreeBytes: number;
    cpus?: number;
    loadPerCore?: number;
    builds?: number;
    maxBuilds?: number;
    maxLoadPerCore?: number;
    memoryUsedBytes?: number;
    memoryTotalBytes?: number;
    declined?: string | null;
  };
  warm: { checkout: boolean; dependencies: boolean; build: boolean };
  artifact?: CachedBuildArtifact | null;
}

type ArtifactLookup = BuildArtifactIdentity | 'swiftpm' | 'native-gradle' | 'react-native-ios' | 'react-native-android';

function matchingArtifact(offer: BuildOffer, identity?: ArtifactLookup): CachedBuildArtifact | null {
  const cached = offer.artifact;
  if (
    !identity ||
    !cached ||
    typeof cached.name !== 'string' ||
    basename(cached.name) !== cached.name ||
    !Number.isSafeInteger(cached.size) ||
    cached.size <= 0 ||
    typeof cached.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cached.sha256)
  )
    return null;
  if (identity === 'react-native-ios' || identity === 'react-native-android') {
    const platform = identity === 'react-native-ios' ? 'ios' : 'android';
    return ARTIFACT_NAME[platform].test(cached.name) &&
      /^[a-f0-9]{64}$/.test(cached.fingerprint) &&
      cached.cacheKey === `react-native-${platform}-${cached.fingerprint}` &&
      (platform === 'ios' || ANDROID_PACKAGE.test(String(cached.androidPackage ?? '')))
      ? cached
      : null;
  }
  if (identity === 'swiftpm')
    return cached.name.endsWith('.app') &&
      typeof cached.fingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(cached.fingerprint) &&
      cached.cacheKey === `swiftpm-peer-${cached.fingerprint}`
      ? cached
      : null;
  if (identity === 'native-gradle')
    return cached.name.endsWith('.apk') &&
      typeof cached.fingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(cached.fingerprint) &&
      typeof cached.cacheKey === 'string' &&
      cached.cacheKey.length > 0 &&
      cached.cacheKey.length <= 1024 &&
      typeof cached.androidPackage === 'string' &&
      ANDROID_PACKAGE.test(cached.androidPackage)
      ? cached
      : null;
  return cached.name.endsWith('.app') &&
    cached.cacheKey === identity.cacheKey &&
    cached.fingerprint === identity.fingerprint
    ? cached
    : null;
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** Every reason a machine's offer cannot take this build, in either mode; empty when it can. */
export function offerProblems(offer: BuildOffer, target: BuildTarget, named = false): OffloadProblem[] {
  const problems = toolchainMismatches(target, offer.toolchain);
  const pods =
    !named && target.platform === 'ios' && !problems.some(({ code }) => code === 'platform')
      ? cocoapodsDifference(target, offer.toolchain)
      : null;
  if (pods) problems.push(pods);
  const capacity = offer.capacity;
  const { running, max, diskFreeBytes, minDiskFreeBytes, declined } = capacity;
  if (diskFreeBytes !== null && diskFreeBytes < minDiskFreeBytes) {
    problems.push({ code: 'disk', reason: `${gb(diskFreeBytes)} GB free, needs ${gb(minDiskFreeBytes)} GB` });
  } else if (declined || (declined === undefined && running >= max)) {
    const why = declined ?? `already running ${running} offloaded build(s), its limit`;
    const known = typeof capacity.loadPerCore === 'number' && typeof capacity.builds === 'number';
    const load = known
      ? `; ${capacityText({ loadPerCore: capacity.loadPerCore!, builds: capacity.builds!, maxBuilds: capacity.maxBuilds ?? 0 })}`
      : '';
    problems.push({ code: 'busy', reason: `busy (${why}${load})` });
  }
  return problems;
}

/**
 * The asked machines that can take the build, best first, and one reason per machine that cannot. A machine with any
 * `offerProblems` never takes it. In `auto`, a machine must also be expected to build faster than this machine: while
 * every local build slot is busy any machine that accepts will do, otherwise its load per core must be lower than
 * this machine's. A named selection considers only that machine and skips this local-capacity gating.
 * A machine that reports no load (a stim-server older than capacity) takes an `auto` build only while
 * every local slot is busy. Matching dependency installations rank first, then load.
 */
export function pickOffer({
  mode,
  here,
  offers,
  target,
  localEnabled = true,
  selected = 'auto',
  artifact,
  cacheOnly = false,
}: {
  mode: OffloadMode;
  here: MachineCapacity;
  selected?: string;
  localEnabled?: boolean;
  offers: Array<{ machine: string; offer: BuildOffer | null; failure?: string }>;
  target: BuildTarget;
  artifact?: ArtifactLookup;
  cacheOnly?: boolean;
}): { order: number[]; reasons: string[]; candidates: PlacementCandidate[] } {
  const slotsFull = here.maxBuilds > 0 && here.builds >= here.maxBuilds;
  const reasons: string[] = [];
  const candidates: PlacementCandidate[] = [];
  const skip = (machine: string, code: string, msg: string, detail?: string[]) => {
    reasons.push(`${machine}: ${msg}`);
    candidates.push({ machine, code, msg, ...(detail ? { detail } : {}) });
  };
  const ranked: Array<{ index: number; score: number; load: number }> = [];
  offers.forEach(({ machine, offer, failure }, index) => {
    if (namedBuildMachine(selected) && machine !== selected) return;
    if (!offer) return skip(machine, 'unreachable', failure ?? 'no offer');
    if (
      matchingArtifact(offer, artifact) &&
      (artifact !== 'swiftpm' || toolchainMismatches(target, offer.toolchain).length === 0)
    ) {
      ranked.push({ index, score: Number.POSITIVE_INFINITY, load: 0 });
      candidates.push({ machine, code: 'artifact-hit', msg: 'has the exact completed artifact' });
      return;
    }
    if (cacheOnly) return skip(machine, 'artifact-miss', 'no matching completed artifact');
    const problems = offerProblems(offer, target, namedBuildMachine(selected));
    if (problems.length) {
      return skip(
        machine,
        problemCode(problems[0]!),
        problems.map((problem) => problem.reason).join('; '),
        problems.map((problem) => problem.code),
      );
    }
    const load = offer.capacity.loadPerCore;
    if (selected === 'auto' && localEnabled && mode === 'auto' && !slotsFull) {
      if (typeof load !== 'number') {
        return skip(machine, 'load', 'capacity unknown (older stim-server) while this machine has a free slot');
      }
      if (load >= here.loadPerCore) {
        return skip(machine, 'load', `no less loaded (load ${load}/core there, ${here.loadPerCore}/core here)`);
      }
    }
    const score = Number(offer.warm.dependencies);
    ranked.push({ index, score, load: typeof load === 'number' ? load : Number.POSITIVE_INFINITY });
    const notes = toolchainNotes(target, offer.toolchain).map((each) => each.reason);
    candidates.push({
      machine,
      code: 'accepted',
      msg: [
        typeof load === 'number' ? `can take the build (load ${load}/core there)` : 'can take the build',
        ...notes,
      ].join('; '),
    });
  });
  ranked.sort((a, b) => b.score - a.score || a.load - b.load);
  return { order: ranked.map((each) => each.index), reasons, candidates };
}

function problemCode({ code }: OffloadProblem): string {
  return code === 'disk' || code === 'busy' || code === 'unreachable'
    ? code
    : code === 'runtime'
      ? 'no-matching-device'
      : 'version-mismatch';
}

export type Reply = { result: unknown } | { error: { code: string; message: string } };

type ProgressEvent = {
  job: string;
  phase?: string;
  msg?: string;
  record?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
};

function closeOnExit(socket: NoiseSocket, context: StimContext | undefined): (() => void) | undefined {
  if (!context) return;
  const state = operationState(context);
  if (!state.takesSignals) return;
  const close = () => socket.close(1000);
  const unregister = () => state.exitCleanups.delete(close);
  state.exitCleanups.add(close);
  socket.once('close', unregister);
  return unregister;
}

/**
 * One authenticated connection to another machine's stim-server, for build offload or device hosting. Closing it cancels
 * its build jobs there; a connection that drops, or that stays silent for `SILENT_MS` after `watch()`, leaves them
 * running for a while so a new connection can `build.attach` to them.
 */
export class BuildConnection {
  private nextId = 2;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private readonly writeWaiters = new Set<() => void>();
  private progress: ((event: ProgressEvent) => void) | null = null;
  private binary: ((frame: Buffer) => void) | null = null;
  private closed: string | null = null;
  private heard = Date.now();
  private watched = false;
  private ended = false;
  private readonly keepalive: NodeJS.Timeout;
  private readonly socket: NoiseSocket;
  private readonly features: readonly string[];
  private readonly context: StimContext | undefined;
  private readonly unregisterExitCleanup: (() => void) | undefined;

  private constructor(socket: NoiseSocket, features: readonly string[], context: StimContext | undefined) {
    this.socket = socket;
    this.features = features;
    this.context = context;
    this.unregisterExitCleanup = closeOnExit(socket, context);
    this.keepalive = setInterval(() => {
      if (this.watched && Date.now() - this.heard > SILENT_MS) return void socket.terminate();
      socket.ping();
    }, PING_MS);
    this.keepalive.unref();
    socket.on('pong', () => (this.heard = Date.now()));
    socket.on('message', (data, isBinary) => {
      this.heard = Date.now();
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      if (isBinary) return this.binary?.(frame);
      let message: unknown;
      try {
        message = JSON.parse(frame.toString('utf8'));
      } catch {
        return;
      }
      if (!isJsonObject(message)) return;
      if (message.event === 'build.progress') return this.progress?.(message as unknown as ProgressEvent);
      const resolve = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (resolve) {
        this.pending.delete(message.id as number);
        resolve(message as unknown as Reply);
      }
    });
    socket.on('close', (code, reason) => {
      clearInterval(this.keepalive);
      this.closed = `the connection closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`;
      for (const wake of this.writeWaiters) wake();
      for (const resolve of this.pending.values()) resolve({ error: { code: 'closed', message: this.closed } });
      this.pending.clear();
      const dropped = code === CLOSE_ABNORMAL;
      this.progress?.({ job: '', outcome: { ok: false, code: dropped ? 'dropped' : 'closed', message: this.closed } });
    });
    socket.on('error', () => {});
  }

  /** Resolves why it could not connect; `refused` when the machine answered and turned this machine away. */
  static async open(
    target: Endpoint,
    serverKey: string,
    timeoutMs: number,
    capability: 'build' | 'device-host' = 'build',
    signal?: AbortSignal,
  ): Promise<BuildConnection | ConnectFailure> {
    const context = ambientContext();
    const started = performance.now();
    const result = await BuildConnection.connect(target, serverKey, timeoutMs, capability, signal, context);
    const ms = Math.round(performance.now() - started);
    debugLog.log('remote_connect', {
      host: target.host,
      capability,
      ms,
      timeoutMs,
      ...(result instanceof BuildConnection ? { ok: true } : { ok: false, failure: result.failure, code: result.code }),
    });
    if (!(result instanceof BuildConnection))
      reportRemoteFailure(context, 'remote_connect_failed', {
        host: target.host,
        capability,
        ms,
        timeoutMs,
        msg: result.failure,
        code: result.code,
      });
    return result;
  }

  private static async connect(
    target: Endpoint,
    serverKey: string,
    timeoutMs: number,
    capability: 'build' | 'device-host',
    signal?: AbortSignal,
    context?: StimContext,
  ): Promise<BuildConnection | ConnectFailure> {
    const started = Date.now();
    const socket = await openAuthenticated(target, { access: capability, serverKey }, timeoutMs, signal, context);
    if (!('send' in socket)) return socket;
    const reply = await sayHello(
      socket,
      { client: { name: 'stim', version: '1', runId: runId() }, access: capability },
      Math.max(1, timeoutMs - (Date.now() - started)),
    );
    if ('error' in reply) {
      socket.terminate();
      return { failure: reply.error.message, refused: TURNED_AWAY.has(reply.error.code), code: reply.error.code };
    }
    const capabilities = reply.result.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.includes(capability)) {
      socket.terminate();
      return {
        failure: `it has not granted this machine ${capability === 'build' ? 'build' : 'hosting'} access`,
        refused: true,
        code: 'forbidden',
      };
    }
    const features = reply.result.features;
    return new BuildConnection(
      socket,
      Array.isArray(features) ? features.filter((each): each is string => typeof each === 'string') : [],
      context,
    );
  }

  supports(feature: string): boolean {
    return this.features.includes(feature);
  }

  request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Reply> {
    if (this.closed) return Promise.resolve({ error: { code: 'closed', message: this.closed } });
    const id = this.nextId++;
    const started = performance.now();
    const done = (reply: Reply): Reply => {
      const ms = Math.round(performance.now() - started);
      debugLog.log('remote_request', {
        method,
        ms,
        ...('error' in reply ? { ok: false, code: reply.error.code } : { ok: true }),
      });
      if ('error' in reply)
        reportRemoteFailure(this.context, 'remote_request_failed', {
          method,
          ms,
          code: reply.error.code,
          msg: reply.error.message,
        });
      return reply;
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(done({ error: { code: 'timeout', message: `${method} got no reply in ${timeoutMs / 1000} s` } }));
      }, timeoutMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(done(reply));
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async sendBinary(frame: Buffer): Promise<void> {
    if (this.closed) return;
    let completed = false;
    let resume: (() => void) | undefined;
    this.socket.send(frame, { binary: true }, () => {
      completed = true;
      resume?.();
    });
    if (completed || this.closed || this.socket.bufferedAmount <= MAX_BUFFERED) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        this.writeWaiters.delete(wake);
        resolve();
      };
      resume = wake;
      this.writeWaiters.add(wake);
    });
  }

  onProgress(listener: ((event: ProgressEvent) => void) | null): void {
    this.progress = listener;
  }

  onBinary(listener: ((frame: Buffer) => void) | null): void {
    this.binary = listener;
  }

  get failure(): string | null {
    return this.closed;
  }

  /**
   * Treats `SILENT_MS` without a frame as a dropped connection from now on. Only while waiting on a job: a long
   * upload or this process hashing the checkout can delay pongs without anything being wrong.
   */
  watch(): void {
    this.heard = Date.now();
    this.watched = true;
  }

  /** Closes with a close frame, which tells the machine to cancel this connection's jobs. */
  close(): void {
    if (this.ended) return;
    this.forget();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const timer = setTimeout(() => this.socket.terminate(), CLOSE_TIMEOUT_MS);
    this.socket.once('close', () => clearTimeout(timer));
    this.socket.close(1000);
  }

  /** Ends the connection without a close frame, which leaves its jobs on the machine for a new connection. */
  drop(): void {
    if (this.ended) return;
    this.forget();
    this.socket.terminate();
  }

  private forget(): void {
    this.ended = true;
    this.closed ??= 'the connection was closed by this client';
    for (const wake of this.writeWaiters) wake();
    for (const resolve of this.pending.values()) resolve({ error: { code: 'closed', message: this.closed } });
    this.pending.clear();
    this.progress = null;
    this.binary = null;
    clearInterval(this.keepalive);
    this.socket.removeAllListeners('close');
    this.unregisterExitCleanup?.();
  }
}

function replyError(reply: Reply): string | null {
  return 'error' in reply ? `${reply.error.code}: ${reply.error.message}` : null;
}

interface RepoIdentity {
  repoRoot: string;
  project: string;
  repo: string;
  lockfile: string | null;
}

/** The repository on the remote machine: one area per git common dir, shared by all its worktrees. */
function repoIdentity(projectRoot: string): RepoIdentity {
  const repoRoot = realpathSync(git(projectRoot, ['rev-parse', '--show-toplevel']));
  const common = realpathSync(git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return repositoryIdentity(projectRoot, repoRoot, common);
}

function repositoryIdentity(projectRoot: string, repoRoot: string, common: string): RepoIdentity {
  const digest = createHash('sha256').update(common).digest('hex').slice(0, 12);
  const name = (basename(dirname(common)) || 'repo').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  const project = relative(repoRoot, realpathSync(projectRoot));
  const lock = dependencyLockfile(repoRoot, project);
  return {
    repoRoot,
    project,
    repo: `${name.slice(0, 60) || 'repo'}-${digest}`,
    lockfile: lock
      ? createHash('sha256')
          .update(readFileSync(join(repoRoot, lock.dir, lock.file)))
          .digest('hex')
      : null,
  };
}

function dependencySelection(identity: RepoIdentity, target: BuildTarget): BuildOfferParams['dependencies'] {
  if (!identity.lockfile || target.platform === 'macos' || target.native) return undefined;
  return {
    project: identity.project.split(sep).join('/'),
    packageName: packageName(join(identity.repoRoot, identity.project)),
  };
}

type ManifestFile = NativeTransferFile;

/** Why the native inputs cannot be sent to a remote machine, such as an ignored file among them, or null when they can. */
export async function nativeTransferRefusal(
  repoRoot: string,
  snapshot: NativeInputSnapshot,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    checkNativeTransferMembership(snapshot, await gitVisiblePaths(repoRoot, signal));
    return null;
  } catch (error) {
    signal?.throwIfAborted();
    return (error as Error).message.split('\n')[0]!;
  }
}

async function blobContent(repoRoot: string, file: ManifestFile, signal?: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const absolute = join(repoRoot, file.path);
  return file.kind === 'directory'
    ? Buffer.alloc(0)
    : file.kind === 'link'
      ? Buffer.from(await readlink(absolute))
      : await readFile(absolute, { signal });
}

interface OffloadTimings {
  offerMs: number;
  syncMs: number;
  workerMs: number;
  fetchMs: number;
  totalMs: number;
  worker: Record<string, number>;
  uploadedBytes: number;
  artifactBytes: number;
}

/** A native build the remote machine keeps for a while, which a hosted session on the same stim-server can take. */
export interface BuildHandoff {
  /** The pinned server key of the machine that built it. */
  serverKey: string;
  token: string;
  sha256: string;
}

export type OffloadOutcome =
  | {
      ok: true;
      machine: string;
      /** The `.app` directory or the `.apk` file, under the staging directory. */
      artifactPath: string;
      cacheHit?: boolean;
      androidPackage?: string;
      compilationCache: CompilationCacheActivity;
      ccache: CcacheActivity;
      timings: OffloadTimings;
      handoff?: BuildHandoff;
    }
  | {
      ok: false;
      machine: string | null;
      reason: string;
      /** The worker's message when its build failed on a corrupt compilation cache. */
      compilationCacheCorrupt?: string;
    };

interface OfferingMachine {
  machine: string;
  credential: BuildMachineCredential;
  connection: BuildConnection;
  offer: BuildOffer;
}

/**
 * The machine a build goes to, and the other machines that can take it, best first, whose connections stay open
 * until one of them starts the build. A strict choice has no runners up and never moves; otherwise, when a machine
 * refuses `build.start`, `offloadBuild` moves this choice to the next one in place.
 */
export interface OffloadChoice extends OfferingMachine {
  mode: OffloadMode;
  here: MachineCapacity;
  target: BuildTarget;
  offerMs: number;
  identity: RepoIdentity;
  runnersUp: OfferingMachine[];
  automatic?: boolean;
  cacheOnly?: boolean;
  gradleArtifact?: BuildGradleArtifactQuery;
  reactNativeArtifact?: BuildReactNativeArtifactQuery;
  swiftpmArtifact?: BuildSwiftpmArtifactQuery;
}

/** Closes every connection the choice still holds. */
export function closeOffload(choice: OffloadChoice): void {
  choice.connection.close();
  for (const each of choice.runnersUp.splice(0)) each.connection.close();
}

const NATIVE_BUILD_FEATURE = { xcode: 'native-xcode-build', gradle: 'native-gradle-build' } as const;

const unsupportedNative = (provider: 'xcode' | 'gradle'): string =>
  `This worker does not support native ${provider === 'xcode' ? 'Xcode' : 'Gradle'} builds.`;

const ANDROID_PACKAGE = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/;

function nativeTransferInput(
  native: Extract<BuildRequest, { platform: 'ios' | 'android' }>['native'],
): NativeInputSnapshot | GradleTransfer | undefined {
  return native?.provider === 'xcode' ? native.snapshot : native?.transfer;
}

type MachineProbe =
  | { credential: BuildMachineCredential; failure: string }
  | { credential: BuildMachineCredential; connection: BuildConnection; offer: BuildOffer };

/** Connects to one paired machine and asks it for an offer; the caller closes the connection it returns. */
async function probeMachine(
  credential: BuildMachineCredential,
  identity: Pick<RepoIdentity, 'repo' | 'lockfile'> & {
    dependencies?: BuildOfferParams['dependencies'];
    rubyVersion?: string;
    native?: 'xcode' | 'gradle';
    artifact?: BuildArtifactIdentity;
    gradleArtifact?: BuildGradleArtifactQuery;
    reactNativeArtifact?: BuildReactNativeArtifactQuery;
    swiftpmArtifact?: BuildSwiftpmArtifactQuery;
  },
  { connectMs = CONNECT_TIMEOUT_MS, offerMs = OFFER_TIMEOUT_MS }: { connectMs?: number; offerMs?: number } = {},
): Promise<MachineProbe> {
  const target = await resolveEndpoint(credential, undefined, reportSignal(ambientContext()));
  if (typeof target === 'string') return { credential, failure: target };
  const connection = await BuildConnection.open(
    target,
    credential.serverKey!,
    connectMs,
    'build',
    reportSignal(ambientContext()),
  );
  if (!(connection instanceof BuildConnection)) return { credential, failure: connection.failure };
  if (identity.native && !connection.supports(NATIVE_BUILD_FEATURE[identity.native])) {
    connection.close();
    return { credential, failure: unsupportedNative(identity.native) };
  }
  const native =
    identity.native === 'gradle' || (identity.native && connection.supports('native-xcode-toolchain'))
      ? identity.native
      : undefined;
  const reply = await connection.request(
    'build.offer',
    {
      repo: identity.repo,
      ...(identity.lockfile ? { lockfile: identity.lockfile } : {}),
      ...(identity.dependencies && connection.supports('build-dependency-cache')
        ? { dependencies: identity.dependencies }
        : {}),
      ...(native ? { native } : identity.rubyVersion ? { rubyVersion: identity.rubyVersion } : {}),
      ...(native === 'xcode' && identity.artifact && connection.supports('build-artifact-cache')
        ? { artifact: identity.artifact }
        : {}),
      ...(identity.swiftpmArtifact && queriesPeerCache(connection, 'swiftpm-peer-cache')
        ? { swiftpmArtifact: identity.swiftpmArtifact }
        : {}),
      ...(identity.reactNativeArtifact && queriesPeerCache(connection, 'react-native-peer-cache')
        ? { reactNativeArtifact: identity.reactNativeArtifact }
        : {}),
      ...(native === 'gradle' && identity.gradleArtifact && connection.supports('native-gradle-peer-cache')
        ? { gradleArtifact: identity.gradleArtifact }
        : {}),
    },
    offerMs,
  );
  const failure = replyError(reply);
  if (failure || !('result' in reply)) {
    connection.close();
    return { credential, failure: failure ?? 'no offer' };
  }
  const reported = reply.result as BuildOffer;
  const offer = {
    ...reported,
    warm: {
      ...reported.warm,
      dependencies:
        identity.dependencies !== undefined &&
        connection.supports('build-dependency-cache') &&
        reported.warm.dependencies,
    },
  };
  return {
    credential,
    connection,
    offer:
      (identity.swiftpmArtifact && !queriesPeerCache(connection, 'swiftpm-peer-cache')) ||
      (identity.reactNativeArtifact && !queriesPeerCache(connection, 'react-native-peer-cache')) ||
      (native === 'gradle' && (!identity.gradleArtifact || !connection.supports('native-gradle-peer-cache')))
        ? { ...offer, artifact: null }
        : offer,
  };
}

/**
 * Asks every paired machine for an offer in parallel and keeps the connection to the one `pickOffer` chooses, or
 * returns why none takes the build. A named selection probes only its credential and skips auto load gating.
 */
export async function chooseBuildMachine({
  projectRoot,
  target,
  mode,
  here,
  note,
  machines = pairedMachines(),
  selected = 'auto',
  onCandidates,
  artifact,
  gradleArtifact,
  reactNativeArtifact,
  swiftpmArtifact,
  cacheOnly = false,
}: {
  projectRoot: string;
  target: BuildTarget;
  mode: OffloadMode;
  here: MachineCapacity;
  note: (line: string) => void;
  machines?: BuildMachineCredential[];
  selected?: string;
  onCandidates?: (candidates: PlacementCandidate[]) => void;
  artifact?: BuildArtifactIdentity;
  gradleArtifact?: Omit<BuildGradleArtifactQuery, 'project'>;
  reactNativeArtifact?: { request: BuildRequest; fingerprint: string };
  swiftpmArtifact?: Extract<BuildRequest, { platform: 'macos' }>;
  cacheOnly?: boolean;
}): Promise<OffloadChoice | string> {
  const started = Date.now();
  let identity: RepoIdentity;
  try {
    identity = repoIdentity(projectRoot);
  } catch (error) {
    return `this app is not in a git checkout (${(error as Error).message.split('\n')[0]})`;
  }
  if (namedBuildMachine(selected)) machines = machines.filter((each) => each.machine === selected).slice(0, 1);
  else machines = machines.filter((each) => automaticMachineEnabled('build', each.machine));
  const rubyVersion = readRubyVersion(projectRoot) ?? undefined;
  const gradleQuery = gradleArtifact ? { ...gradleArtifact, project: identity.project } : undefined;
  const reactNativeQuery = reactNativeArtifact
    ? reactNativeBuildQuery(
        reactNativeArtifact.request,
        reactNativeArtifact.fingerprint,
        identity.project,
        target.local,
      )
    : null;
  const swiftpmQuery = swiftpmArtifact?.artifactInputs
    ? swiftpmArtifactQuery({
        project: identity.project,
        sourceDigest: manifestDigest(
          await sourceManifest(
            identity.repoRoot,
            true,
            runCancellationSignal(ambientContext()) ?? ambientContext()?.signal,
          ),
        ),
        compat: target.local.compat,
        inputs: swiftpmArtifact.artifactInputs,
        build: {
          product: swiftpmArtifact.product,
          infoPlist: swiftpmArtifact.infoPlist,
          resources: swiftpmArtifact.resources ?? {},
          assetCatalog: swiftpmArtifact.assetCatalog ?? null,
        },
      })
    : null;
  const asked = await Promise.all(
    machines.map((credential) =>
      probeMachine(credential, {
        ...identity,
        rubyVersion,
        dependencies: dependencySelection(identity, target),
        ...(target.platform !== 'macos' ? { native: target.native } : {}),
        ...(artifact ? { artifact } : {}),
        ...(gradleQuery ? { gradleArtifact: gradleQuery } : {}),
        ...(reactNativeQuery ? { reactNativeArtifact: reactNativeQuery } : {}),
        ...(swiftpmQuery ? { swiftpmArtifact: swiftpmQuery } : {}),
      }),
    ),
  );
  const { order, reasons, candidates } = pickOffer({
    localEnabled: selected !== 'auto' || automaticMachineEnabled('build', 'local'),
    selected,
    mode,
    here,
    target,
    artifact: swiftpmQuery
      ? 'swiftpm'
      : reactNativeQuery
        ? `react-native-${reactNativeQuery.platform}`
        : gradleQuery
          ? 'native-gradle'
          : artifact,
    cacheOnly,
    offers: asked.map((each) => ({
      machine: each.credential.machine,
      offer: 'offer' in each ? each.offer : null,
      ...('failure' in each ? { failure: each.failure } : {}),
    })),
  });
  asked.forEach((each, at) => {
    if (!order.includes(at) && 'connection' in each) each.connection.close();
  });
  onCandidates?.(candidates);
  if (order.length === 0) return reasons.length ? reasons.join('; ') : 'no remote machine is paired';
  for (const reason of reasons) note(reason);
  const [first, ...rest] = order.map((at) => {
    const pick = asked[at] as { credential: BuildMachineCredential; connection: BuildConnection; offer: BuildOffer };
    return {
      machine: pick.credential.machine,
      credential: pick.credential,
      connection: pick.connection,
      offer: pick.offer,
    };
  });
  return {
    ...first!,
    mode,
    here,
    target,
    offerMs: Date.now() - started,
    identity,
    runnersUp: rest,
    automatic: selected === 'auto',
    cacheOnly,
    ...(gradleQuery ? { gradleArtifact: gradleQuery } : {}),
    ...(reactNativeQuery ? { reactNativeArtifact: reactNativeQuery } : {}),
    ...(swiftpmQuery ? { swiftpmArtifact: swiftpmQuery } : {}),
  };
}

/** The Gradle choices that shape the APK, so the machine builds what this machine's cache key describes. */
export interface AndroidBuildOptions {
  variant: string | null;
  abi: string | null;
  gradleBuildCache: boolean;
  pch: 'auto' | 'on' | 'off';
  compilerCache: 'ccache' | 'none';
  gradleRoot?: string | null;
  module?: string | null;
}

/** What `build.start` builds besides the synced checkout. */
export type BuildRequest =
  | {
      platform: 'ios';
      cacheArtifact?: boolean;
      native?: { provider: 'xcode'; snapshot: NativeInputSnapshot; cacheKey: string; arch: 'arm64' | 'x86_64' | null };
      runtime: string;
      configuration: string | null;
      scheme: string | null;
      iosProjectPath?: string;
      isExpo: boolean;
      optimizations: unknown;
    }
  | {
      platform: 'android';
      cacheArtifact?: boolean;
      native?: {
        provider: 'gradle';
        transfer: GradleTransfer;
        cache?: { read: boolean; write: boolean; remote: boolean };
      };
      isExpo: boolean;
      android: AndroidBuildOptions;
    }
  | {
      platform: 'macos';
      cacheArtifact?: boolean;
      artifactInputs?: BuildSwiftpmArtifactQuery['inputs'];
      product: string;
      infoPlist: string;
      bundleId: string;
      resources?: Record<string, string>;
      assetCatalog?: string | null;
    };

function startJdk(choice: OffloadChoice): { jdk?: string } {
  const { target, connection } = choice;
  return target.platform === 'android' && target.local.jdk && connection.supports('build-jdk')
    ? { jdk: target.local.jdk }
    : {};
}

function startCompat(choice: OffloadChoice): { compat?: number } {
  return choice.connection.supports('build-compat') ? { compat: choice.target.local.compat } : {};
}

/** Peer artifact queries carry `compat`, which a stim-server without `build-compat` refuses. */
function queriesPeerCache(
  connection: BuildConnection,
  feature: 'swiftpm-peer-cache' | 'react-native-peer-cache',
): boolean {
  return connection.supports(feature) && connection.supports('build-compat');
}

function macosBuildParameters(request: Extract<BuildRequest, { platform: 'macos' }>, peerCache: boolean) {
  return {
    ...(request.cacheArtifact === true && peerCache ? { cacheArtifact: true } : {}),
    macos: {
      ...(request.artifactInputs && peerCache ? { artifactInputs: request.artifactInputs } : {}),
      product: request.product,
      infoPlist: request.infoPlist,
      bundleId: request.bundleId,
      ...(request.resources !== undefined ? { resources: request.resources } : {}),
      ...(request.assetCatalog !== undefined ? { assetCatalog: request.assetCatalog } : {}),
    },
  };
}

function validArtifactIdentity(request: BuildRequest, fingerprint: string | null | undefined): boolean {
  if (request.platform === 'macos') return true;
  return request.native?.provider === 'gradle'
    ? fingerprint === null
    : typeof fingerprint === 'string' && fingerprint.length > 0;
}

const ARTIFACT_NAME = { ios: /^[^/]+\.app$/, android: /^[^/]+\.apk$/, macos: /^[^/]+\.app$/ } as const;

async function peerArtifact(
  choice: OffloadChoice,
  request: BuildRequest,
  fingerprint: string | null | undefined,
): Promise<CachedBuildArtifact | null> {
  const swiftpm = choice.swiftpmArtifact;
  if (swiftpm) {
    if (
      request.platform !== 'macos' ||
      !isDeepStrictEqual(
        swiftpm,
        swiftpmArtifactQuery({
          ...swiftpm,
          inputs: request.artifactInputs,
          build: {
            product: request.product,
            infoPlist: request.infoPlist,
            resources: request.resources ?? {},
            assetCatalog: request.assetCatalog ?? null,
          },
        }),
      )
    )
      throw new Error('The SwiftPM artifact query does not match the build request.');
    if (
      !queriesPeerCache(choice.connection, 'swiftpm-peer-cache') ||
      manifestDigest(
        await sourceManifest(
          choice.identity.repoRoot,
          true,
          runCancellationSignal(ambientContext()) ?? ambientContext()?.signal,
        ),
      ) !== swiftpm.sourceDigest
    )
      return null;
    return matchingArtifact(choice.offer, 'swiftpm');
  }
  const reactNative = choice.reactNativeArtifact;
  if (reactNative) {
    if (
      typeof fingerprint !== 'string' ||
      !isDeepStrictEqual(
        reactNative,
        reactNativeBuildQuery(request, fingerprint, choice.identity.project, choice.target.local),
      )
    )
      throw new Error('The React Native artifact query does not match the build request.');
    return queriesPeerCache(choice.connection, 'react-native-peer-cache')
      ? matchingArtifact(choice.offer, `react-native-${reactNative.platform}`)
      : null;
  }
  const query = choice.gradleArtifact;
  if (query) {
    if (
      request.platform !== 'android' ||
      request.native?.provider !== 'gradle' ||
      !request.native.cache?.read ||
      !request.native.cache.remote ||
      query.project !== choice.identity.project ||
      query.sourceDigest !== request.native.transfer.digest ||
      !isDeepStrictEqual(query.inputs, request.native.transfer.declaration) ||
      !isDeepStrictEqual(query.android, request.android)
    )
      throw new Error('The Gradle artifact query does not match the build request.');
    return choice.connection.supports('native-gradle-peer-cache')
      ? matchingArtifact(choice.offer, 'native-gradle')
      : null;
  }
  if (
    request.platform === 'ios' &&
    request.native &&
    typeof fingerprint === 'string' &&
    choice.connection.supports('build-artifact-cache')
  )
    return matchingArtifact(choice.offer, { fingerprint, cacheKey: request.native.cacheKey });
  return null;
}

/**
 * Reconnects to the machine that runs `job` and takes the job over with `build.attach`, retrying until
 * `RESUME_WINDOW_MS`, shorter than the machine's grace for a dropped connection, has passed. Returns why it
 * could not.
 */
async function resumeJob(
  credential: BuildMachineCredential,
  job: string,
  abandoned: () => boolean,
  signal: AbortSignal | undefined,
  native?: 'xcode' | 'gradle',
): Promise<{ connection: BuildConnection; outcome: Record<string, unknown> | null; early: ProgressEvent[] } | string> {
  const deadline = Date.now() + RESUME_WINDOW_MS;
  let delay = RESUME_DELAY_MS;
  let last = 'no attempt';
  while (!abandoned()) {
    const target = await resolveEndpoint(credential);
    const connection =
      typeof target === 'string'
        ? { failure: target, refused: false }
        : await BuildConnection.open(target, credential.serverKey!, CONNECT_TIMEOUT_MS);
    if (!(connection instanceof BuildConnection)) {
      if (connection.refused) return `it turned this machine away (${connection.failure})`;
      last = connection.failure;
    } else {
      if (abandoned()) {
        connection.close();
        break;
      }
      if (native && !connection.supports(NATIVE_BUILD_FEATURE[native])) {
        connection.close();
        return unsupportedNative(native);
      }
      const early: ProgressEvent[] = [];
      connection.onProgress((event) => early.push(event));
      const cancel = () => connection.close();
      signal?.addEventListener('abort', cancel, { once: true });
      const reply = await connection.request('build.attach', { job }, OFFER_TIMEOUT_MS);
      signal?.removeEventListener('abort', cancel);
      if (abandoned()) {
        connection.close();
        break;
      }
      if ('result' in reply) {
        const outcome = isJsonObject(reply.result) ? reply.result.outcome : null;
        return { connection, outcome: isJsonObject(outcome) ? outcome : null, early };
      }
      last = replyError(reply)!;
      if (reply.error.code !== 'closed' && reply.error.code !== 'timeout') {
        connection.close();
        return `the machine did not hand the build back (${last})`;
      }
      connection.drop();
    }
    if (abandoned() || Date.now() + delay > deadline) break;
    await wait(delay, undefined, { signal }).catch(() => {});
    delay = Math.min(delay * 2, RESUME_MAX_DELAY_MS);
  }
  return `no connection to it within ${RESUME_WINDOW_MS / 60_000} min (${last})`;
}

/** Mirrors the checkout on the machine: the manifest in pages, then every blob it lacks. */
async function syncSource(
  connection: BuildConnection,
  identity: RepoIdentity,
  onEnter: (phase: string) => void,
  native?: NativeInputSnapshot | GradleTransfer,
  signal?: AbortSignal,
  ignored: readonly string[] = [],
): Promise<
  { files: number; uploaded: number; uploadedBytes: number; syncMs: number; digest: string } | { failure: string }
> {
  onEnter('sync');
  const syncStarted = Date.now();
  const ignoredPaths: string[] = [];
  for (const path of ignored) {
    const inRepo = relative(identity.repoRoot, join(await realpath(dirname(path)), basename(path)));
    if (inRepo && !isAbsolute(inRepo) && inRepo !== '..' && !inRepo.startsWith(`..${sep}`))
      ignoredPaths.push(inRepo.split(sep).join('/'));
  }
  const manifest =
    native && 'declaration' in native
      ? (await nativeGradleTransfer(join(identity.repoRoot, identity.project), native.declaration, signal)).files
      : native
        ? await nativeTransferManifest(
            identity.repoRoot,
            native,
            await sourceManifest(identity.repoRoot, false, signal),
            signal,
          )
        : await sourceManifest(identity.repoRoot, false, signal, ignoredPaths);
  if (native && 'declaration' in native && manifestDigest(manifest) !== native.digest)
    return { failure: 'The native Gradle source changed before upload.' };
  const bySha = new Map(manifest.map((file) => [file.sha256, file]));
  const missing: string[] = [];
  for (let index = 0; index < manifest.length || index === 0;) {
    const page: ManifestFile[] = [];
    let bytes = 0;
    while (index < manifest.length && (page.length === 0 || bytes < PAGE_BYTES)) {
      const file = manifest[index++]!;
      bytes += Buffer.byteLength(JSON.stringify(file)) + 1;
      page.push(file);
    }
    const done = index >= manifest.length;
    const reply = await connection.request('build.sync', { repo: identity.repo, files: page, done });
    const failure = replyError(reply);
    if (failure || !('result' in reply)) return { failure: `sync: ${failure ?? 'no reply'}` };
    missing.push(...((reply.result as { missing?: string[] }).missing ?? []));
    if (done) break;
  }
  let uploadedBytes = 0;
  for (const digest of missing) {
    const file = bySha.get(digest);
    if (!file) return { failure: `sync: the machine asked for an unknown blob ${digest}` };
    const content = await blobContent(identity.repoRoot, file, signal);
    if (Buffer.from(await webcrypto.subtle.digest('SHA-256', content)).toString('hex') !== digest)
      return { failure: `sync: ${file.path} changed while syncing` };
    const header = Buffer.from(digest, 'hex');
    for (let offset = 0; offset < content.length || offset === 0; offset += CHUNK_BYTES) {
      await connection.sendBinary(Buffer.concat([header, content.subarray(offset, offset + CHUNK_BYTES)]));
      if (content.length === 0) break;
    }
    uploadedBytes += content.length;
    if (connection.failure) return { failure: `sync: ${connection.failure}` };
  }
  return {
    files: manifest.length,
    uploaded: missing.length,
    uploadedBytes,
    syncMs: Date.now() - syncStarted,
    digest: manifestDigest(manifest),
  };
}

function stagedArtifactEscapes(stagingDir: string, artifactPath: string, hasContents: boolean): boolean {
  const paths = hasContents ? [artifactPath, join(artifactPath, 'Contents')] : [artifactPath];
  if (paths.some((path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())) return true;
  if (!existsSync(artifactPath)) return false;
  const inside = relative(realpathSync(stagingDir), realpathSync(artifactPath));
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}

async function fetchArtifact({
  connection,
  method,
  params,
  artifact,
  request,
  stagingDir,
  machine,
  cacheHit,
  checkCancelled,
}: {
  connection: BuildConnection;
  method: string;
  params: unknown;
  artifact: { name: string; size?: unknown; sha256: string };
  request: BuildRequest;
  stagingDir: string;
  machine: string;
  cacheHit: boolean;
  checkCancelled: () => void;
}): Promise<
  { artifactPath: string; digest: string; received: number; declared: { handoff?: unknown } } | { failure: string }
> {
  const name = artifact.name;
  const archive = join(stagingDir, 'app.tgz');
  const fd = openSync(archive, 'w');
  const hash = createHash('sha256');
  let received = 0;
  let badFrame = false;
  connection.onBinary((frame) => {
    if (frame.length < DIGEST_BYTES || frame.subarray(0, DIGEST_BYTES).toString('hex') !== artifact.sha256) {
      badFrame = true;
      return;
    }
    const data = frame.subarray(DIGEST_BYTES);
    if (cacheHit && received + data.length > Number(artifact.size)) {
      badFrame = true;
      return;
    }
    try {
      writeSync(fd, data);
    } catch {
      badFrame = true;
      return;
    }
    hash.update(data);
    received += data.length;
  });
  const fetched = await connection.request(method, params, 15 * 60_000);
  connection.onBinary(null);
  closeSync(fd);
  checkCancelled();
  const fetchFailure = replyError(fetched);
  if (fetchFailure || !('result' in fetched) || fetched.result === null) {
    const reason = `fetch: ${fetchFailure ?? 'the cached artifact was removed'}`;
    return { failure: reason };
  }
  const digest = hash.digest('hex');
  const declared = fetched.result as { size?: unknown; sha256?: unknown; handoff?: unknown };
  if (badFrame) {
    const reason = 'fetch: an artifact frame had another digest or could not be written here';
    return { failure: reason };
  }
  if (digest !== artifact.sha256 || declared.sha256 !== digest || declared.size !== received) {
    const reason = `fetch: the artifact's sha256 ${digest.slice(0, 12)} does not match ${String(artifact.sha256).slice(0, 12)}`;
    return { failure: reason };
  }
  if (cacheHit) {
    const members = (await getExecutor().runFileAsync('tar', ['-tf', archive], { timeoutMs: 600_000 }))
      .split('\n')
      .filter(Boolean);
    if (
      members.some((member) => {
        const clean = member.replace(/^\.\//, '');
        return !(clean === name || clean.startsWith(`${name}/`)) || clean.split('/').includes('..');
      })
    )
      return { failure: 'fetch: the archive contains paths outside its app' };
  }
  await getExecutor().runFileAsync('tar', ['-xf', archive, '-C', stagingDir], { timeoutMs: 600_000 });
  checkCancelled();
  rmSync(archive, { force: true });
  const artifactPath = join(stagingDir, name);
  if (stagedArtifactEscapes(stagingDir, artifactPath, request.platform === 'macos')) {
    return {
      failure: `fetch: ${machine} returned ${name} as or through a symbolic link or outside the staging directory`,
    };
  }
  if (cacheHit) {
    const pending = [artifactPath];
    const root = realpathSync(artifactPath);
    for (const path of pending) {
      const stat = lstatSync(path);
      if (stat.isDirectory()) pending.push(...readdirSync(path).map((entry) => join(path, entry)));
      else if (stat.isSymbolicLink()) {
        const inside = relative(root, realpathSync(path));
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
          return { failure: 'fetch: an app link resolves outside its bundle' };
      }
    }
  }
  if (request.platform === 'ios' && !existsSync(join(artifactPath, 'Info.plist'))) {
    return { failure: `fetch: ${name} has no Info.plist` };
  }
  if (request.platform === 'android' && !(lstatSync(artifactPath, { throwIfNoEntry: false })?.isFile() ?? false)) {
    return { failure: `fetch: ${name} is not a file` };
  }
  if (request.platform === 'macos') {
    for (const segments of [
      ['Contents', 'Info.plist'],
      ['Contents', 'MacOS', request.product],
    ]) {
      if (!lstatSync(join(artifactPath, ...segments), { throwIfNoEntry: false })?.isFile())
        return { failure: `fetch: ${name} has no regular ${segments.join('/')}` };
    }
  }
  return { artifactPath, digest, received, declared };
}

interface FingerprintInputs {
  sources: readonly FingerprintSource[];
  ignored: readonly string[];
  /** The paths, relative to the project, that this Mac's git ignores for the fingerprint. */
  ignoredPaths?: readonly string[];
  /** The top-level entries, relative to the project, that this Mac's git tracks although an ignore pattern matches them. */
  trackedPaths?: readonly string[];
}

function fingerprintSourcesParam(inputs: FingerprintInputs | null, connection: BuildConnection) {
  if (!inputs || !connection.supports('fingerprint-sources')) return {};
  return {
    fingerprintSources: inputs.sources.map((source) => ({
      id: source.type === 'contents' ? source.id : source.filePath,
      hash: source.hash,
    })),
  };
}

function fingerprintIgnoredParam(inputs: FingerprintInputs | null, connection: BuildConnection) {
  if (!inputs?.ignoredPaths?.length || !connection.supports('fingerprint-ignored')) return {};
  return { fingerprintIgnored: [...inputs.ignoredPaths] };
}

function fingerprintTrackedParam(inputs: FingerprintInputs | null, connection: BuildConnection) {
  if (!inputs?.trackedPaths?.length || !connection.supports('fingerprint-tracked')) return {};
  return { fingerprintTracked: [...inputs.trackedPaths] };
}

function keepCorruptCacheMessage(
  failed: Extract<OffloadOutcome, { ok: false }>,
  result: Record<string, unknown>,
): Extract<OffloadOutcome, { ok: false }> {
  return result.code === COMPILATION_CACHE_CORRUPT
    ? { ...failed, compilationCacheCorrupt: String(result.message ?? '') }
    : failed;
}

/**
 * Builds on the chosen machine and brings the `.app` or `.apk` back into `stagingDir`, verified against the
 * sha256 the machine reports. The caller re-fingerprints and stores it.
 */
export async function offloadBuild(
  input: {
    choice: OffloadChoice;
    stagingDir: string;
    onPhase: (phase: string, msg: string) => void;
    onEnter: (phase: string) => void;
    onRecord: (record: Record<string, unknown>) => void;
    /** One line about where the build goes, such as the next machine after a refusal. */
    note: (line: string) => void;
    /** The fingerprint sources behind `expectedFingerprint` and the gitignored files they read, as absolute paths. */
    fingerprintInputs?: () => Promise<FingerprintInputs>;
  } & (
    | { request: Extract<BuildRequest, { platform: 'macos' }>; expectedFingerprint?: never }
    | { request: Exclude<BuildRequest, { platform: 'macos' }>; expectedFingerprint: string | null }
  ),
): Promise<OffloadOutcome> {
  const { choice, expectedFingerprint, request, stagingDir, onPhase, onEnter, onRecord, note } = input;
  let cacheHit = false;
  let keepStaging = false;
  const { identity } = choice;
  const native = request.platform !== 'macos' ? request.native : undefined;
  let sourceDigest: string | null = null;
  const started = Date.now();
  const fail = (reason: string): Extract<OffloadOutcome, { ok: false }> => {
    closeOffload(choice);
    return { ok: false, machine: choice.machine, reason: reason.split('\n')[0]!.slice(0, 300) };
  };
  const signal = runCancellationSignal(ambientContext());
  const checkCancelled = () => throwIfCancelled(signal, 'offloaded build');
  let settle!: (outcome: Record<string, unknown>) => void;
  let settled = false;
  const outcome = new Promise<Record<string, unknown>>((resolve) => {
    settle = (value) => {
      settled = true;
      resolve(value);
    };
  });
  const cancel = () => {
    settle({ ok: false, code: 'cancelled' });
    closeOffload(choice);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const retryCachedMiss = async (reason: string): Promise<OffloadOutcome> => {
    checkCancelled();
    note(`cache: ${choice.machine}: ${reason}`);
    const next = choice.runnersUp.shift();
    if (next) {
      choice.connection.close();
      Object.assign(choice, next);
    } else {
      if (choice.cacheOnly) return fail(reason);
      choice.connection.close();
      const probe = await probeMachine(choice.credential, {
        ...identity,
        dependencies: dependencySelection(identity, choice.target),
        ...(native ? { native: native.provider } : {}),
      });
      if ('failure' in probe) return fail(probe.failure);
      const placement = pickOffer({
        mode: choice.mode,
        here: choice.here,
        target: choice.target,
        selected: choice.automatic ? 'auto' : choice.machine,
        localEnabled: !choice.automatic || automaticMachineEnabled('build', 'local'),
        offers: [{ machine: choice.machine, offer: probe.offer }],
      });
      if (placement.order.length === 0) {
        probe.connection.close();
        return fail(placement.reasons.join('; '));
      }
      Object.assign(choice, probe, { offer: { ...probe.offer, artifact: null } });
    }
    const retried = await offloadBuild(input);
    keepStaging = retried.ok;
    return retried;
  };
  try {
    checkCancelled();
    if (!validArtifactIdentity(request, expectedFingerprint))
      return fail('The build request has an invalid reusable artifact identity.');
    if (native?.provider === 'xcode' && native.snapshot.hash !== expectedFingerprint)
      return fail('The native source snapshot does not match the requested artifact identity.');
    let cached: CachedBuildArtifact | null = null;
    let job: string | null = null;
    let early: ProgressEvent[] = [];
    let resuming = false;
    const reattach = async (why: string) => {
      if (resuming || settled) return;
      resuming = true;
      note(`offload: the connection to ${choice.machine} dropped (${why}); reattaching to the build there`);
      const resumed = await resumeJob(choice.credential, job!, () => settled, signal, native?.provider);
      resuming = false;
      if (settled) {
        if (typeof resumed !== 'string') resumed.connection.close();
        return;
      }
      if (typeof resumed === 'string') return settle({ ok: false, code: 'closed', message: `${why}; ${resumed}` });
      choice.connection = resumed.connection;
      resumed.connection.watch();
      note(`offload: reattached to the build on ${choice.machine}`);
      resumed.connection.onProgress(handle);
      if (resumed.outcome) settle(resumed.outcome);
      for (const event of resumed.early.splice(0)) handle(event);
    };
    const handle = (event: ProgressEvent) => {
      if (event.job && event.job !== job) return;
      if (event.outcome?.code === 'dropped' && !event.job && job !== null) {
        return void reattach(String(event.outcome.message));
      }
      if (event.outcome) return settle(event.outcome);
      if (event.record) onRecord(event.record);
      if (event.phase && typeof event.msg === 'string') {
        onEnter(event.phase);
        onPhase(event.phase, event.msg);
      }
    };
    let syncMs = 0;
    let uploadedBytes = 0;
    let workerStarted = 0;
    let fingerprintInputs: Promise<FingerprintInputs | null> | undefined;
    const readFingerprintInputs = () =>
      (fingerprintInputs ??=
        !native && request.platform !== 'macos' && input.fingerprintInputs
          ? input.fingerprintInputs()
          : Promise.resolve(null));
    const moveOn = (why: string): boolean => {
      const next = choice.runnersUp.shift();
      if (!next) return false;
      note(`placement: ${next.machine} (${choice.machine} could not take the build: ${why})`);
      choice.connection.close();
      Object.assign(choice, next);
      return true;
    };
    for (;;) {
      if (choice.automatic && !automaticMachineEnabled('build', choice.machine)) {
        const reason = `${choice.machine} is disabled in remote.buildPoolDisabled`;
        if (moveOn(reason)) continue;
        return fail(reason);
      }
      if (native && !choice.connection.supports(NATIVE_BUILD_FEATURE[native.provider])) {
        const reason = unsupportedNative(native.provider);
        if (moveOn(reason)) continue;
        return fail(reason);
      }
      cached = await peerArtifact(choice, request, expectedFingerprint);
      if (cached) {
        cacheHit = true;
        settle({
          ok: true,
          artifact: cached,
          fingerprint: expectedFingerprint,
          androidPackage: cached.androidPackage,
        });
        break;
      }
      if (choice.cacheOnly) return fail('The exact artifact is no longer available.');
      const inputs = await readFingerprintInputs();
      const synced = await syncSource(
        choice.connection,
        identity,
        onEnter,
        nativeTransferInput(native),
        signal,
        inputs?.ignored,
      );
      checkCancelled();
      if ('failure' in synced) {
        if (moveOn(synced.failure)) continue;
        return fail(synced.failure);
      }
      ({ syncMs, uploadedBytes } = synced);
      sourceDigest = synced.digest;
      onPhase(
        'sync',
        `${synced.files} files, uploaded ${synced.uploaded} (${mb(uploadedBytes)}) in ${seconds(syncMs)}`,
      );
      workerStarted = Date.now();
      early = [];
      choice.connection.onProgress((event) => (job === null ? early.push(event) : handle(event)));
      if (choice.automatic) requireAutomaticMachine('build', choice.machine);
      checkCancelled();
      const reply = await choice.connection.request('build.start', {
        repo: identity.repo,
        project: identity.project,
        platform: request.platform,
        fingerprint: request.platform === 'macos' ? synced.digest : expectedFingerprint,
        ...fingerprintSourcesParam(inputs, choice.connection),
        ...fingerprintIgnoredParam(inputs, choice.connection),
        ...fingerprintTrackedParam(inputs, choice.connection),
        ...(native
          ? {
              native: {
                provider: native.provider,
                sourceDigest: synced.digest,
                ...(native.provider === 'xcode'
                  ? { cacheKey: native.cacheKey, arch: native.arch, parameters: native.snapshot.parameters }
                  : {
                      inputs: native.transfer.declaration,
                      ...(choice.connection.supports('native-gradle-artifact-cache') ? { cache: native.cache } : {}),
                    }),
              },
            }
          : {}),
        ...(request.platform === 'macos'
          ? macosBuildParameters(request, queriesPeerCache(choice.connection, 'swiftpm-peer-cache'))
          : {
              configuration: request.platform === 'ios' ? request.configuration : null,
              scheme: request.platform === 'ios' ? request.scheme : null,
              iosProjectPath: request.platform === 'ios' ? (request.iosProjectPath ?? null) : null,
              runtime: request.platform === 'ios' ? request.runtime : null,
              packageName: packageName(join(identity.repoRoot, identity.project)),
              isExpo: request.isExpo,
              ...(!native &&
              request.cacheArtifact === true &&
              queriesPeerCache(choice.connection, 'react-native-peer-cache')
                ? { cacheArtifact: true }
                : {}),
              optimizations:
                request.platform === 'ios' && isJsonObject(request.optimizations) ? request.optimizations : null,
              ...(request.platform === 'android' ? { android: request.android } : {}),
            }),
        stimBuild: choice.target.local.stimBuild,
        ...startCompat(choice),
        ...startJdk(choice),
      });
      checkCancelled();
      if ('result' in reply) {
        job = (reply.result as { job: string }).job;
        break;
      }
      const refused = `start: ${replyError(reply)}`;
      if (reply.error.code === 'bad-request' || !moveOn(refused)) return fail(refused);
    }
    if (!cacheHit) for (const each of choice.runnersUp.splice(0)) each.connection.close();
    choice.connection.watch();
    for (const event of early.splice(0)) handle(event);
    const timer = setTimeout(
      () => settle({ ok: false, code: 'timeout', message: 'the build did not finish in time' }),
      JOB_TIMEOUT_MS,
    );
    const result = await outcome;
    clearTimeout(timer);
    checkCancelled();
    const { connection, machine } = choice;
    connection.onProgress(null);
    const workerMs = cacheHit ? 0 : Date.now() - workerStarted;
    if (result.ok !== true)
      return keepCorruptCacheMessage(fail(workerFailureReason(result.code, result.message)), result);
    if (!cacheHit && native && (result.sourceDigest !== sourceDigest || result.fingerprint !== expectedFingerprint))
      return fail('The worker returned a different native source or artifact identity.');
    if (native?.provider === 'gradle' && !ANDROID_PACKAGE.test(String(result.androidPackage ?? '')))
      return fail('The worker returned no verified native APK package.');
    const artifact = result.artifact as { name?: unknown; size?: unknown; sha256?: unknown };
    const name = typeof artifact?.name === 'string' ? artifact.name : '';
    if (!ARTIFACT_NAME[request.platform].test(name) || typeof artifact.sha256 !== 'string') {
      return fail(`the machine reported no .${request.platform === 'android' ? 'apk' : 'app'} artifact`);
    }

    onEnter('fetch');
    checkCancelled();
    const fetchStarted = Date.now();
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    const downloaded = await fetchArtifact({
      connection,
      artifact: { name, size: artifact.size, sha256: artifact.sha256 },
      request,
      stagingDir,
      machine,
      cacheHit,
      checkCancelled,
      method: cacheHit ? 'build.cached-artifact' : 'build.artifact',
      params: cached
        ? {
            repo: identity.repo,
            artifact: {
              fingerprint: cached.fingerprint,
              cacheKey: cached.cacheKey,
            },
            ...(choice.gradleArtifact ? { gradleArtifact: choice.gradleArtifact } : {}),
            ...(choice.reactNativeArtifact ? { reactNativeArtifact: choice.reactNativeArtifact } : {}),
            ...(choice.swiftpmArtifact ? { swiftpmArtifact: choice.swiftpmArtifact } : {}),
          }
        : { job },
    });
    if ('failure' in downloaded) return cacheHit ? await retryCachedMiss(downloaded.failure) : fail(downloaded.failure);
    if (cacheHit && choice.swiftpmArtifact && !(await peerArtifact(choice, request, expectedFingerprint)))
      return await retryCachedMiss('The SwiftPM source changed during artifact transfer.');
    const { artifactPath, digest, received, declared } = downloaded;
    const fetchMs = Date.now() - fetchStarted;
    closeOffload(choice);
    keepStaging = true;
    return {
      ok: true,
      ...(cacheHit ? { cacheHit: true } : {}),
      machine,
      artifactPath,
      ...(typeof declared.handoff === 'string' && /^[0-9a-f]{64}$/.test(declared.handoff)
        ? { handoff: { serverKey: choice.credential.serverKey!, token: declared.handoff, sha256: digest } }
        : {}),
      ...offloadCacheActivity(request.platform, result.compilationCache, cacheHit),
      ...(native?.provider === 'gradle' ? { androidPackage: result.androidPackage as string } : {}),
      timings: {
        offerMs: choice.offerMs,
        syncMs,
        workerMs,
        fetchMs,
        totalMs: Date.now() - started + choice.offerMs,
        worker: isJsonObject(result.timings) ? (result.timings as Record<string, number>) : {},
        uploadedBytes,
        artifactBytes: received,
      },
    };
  } catch (error) {
    checkCancelled();
    const reason = (error as Error).message.split('\n')[0] ?? String(error);
    return cacheHit ? await retryCachedMiss(reason) : fail(reason);
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!keepStaging) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function offloadCacheActivity(
  platform: BuildRequest['platform'],
  activity: unknown,
  cacheHit: boolean,
): Pick<Extract<OffloadOutcome, { ok: true }>, 'compilationCache' | 'ccache'> {
  if (cacheHit) return { compilationCache: COMPILATION_CACHE_NOT_RUN, ccache: CCACHE_NOT_RUN };
  return {
    compilationCache: platform === 'ios' ? compilationActivity(activity) : COMPILATION_CACHE_UNAVAILABLE,
    ccache: platform === 'android' ? ccacheActivity(activity) : CCACHE_UNAVAILABLE,
  };
}

function packageName(projectRoot: string): string | null {
  try {
    const name = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

const numberOrNull = (field: unknown): number | null => (typeof field === 'number' ? field : null);

function compilationActivity(value: unknown): CompilationCacheActivity {
  if (!isJsonObject(value) || value.status !== 'reported') return COMPILATION_CACHE_UNAVAILABLE;
  return {
    status: 'reported',
    hits: numberOrNull(value.hits),
    cacheableTasks: numberOrNull(value.cacheableTasks),
    hitRatePercent: numberOrNull(value.hitRatePercent),
  };
}

function ccacheActivity(value: unknown): CcacheActivity {
  if (!isJsonObject(value) || value.status !== 'reported') return CCACHE_UNAVAILABLE;
  return {
    status: 'reported',
    hits: numberOrNull(value.hits),
    misses: numberOrNull(value.misses),
    hitRatePercent: numberOrNull(value.hitRatePercent),
  };
}

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function simulatorRuntime(udid: string): string | null {
  try {
    const listed = JSON.parse(
      getExecutor().runFileQuiet('xcrun', ['simctl', 'list', 'devices', '-j'], { timeoutMs: 20_000 }) ?? '{}',
    ) as { devices?: Record<string, Array<{ udid: string }>> };
    for (const [runtime, devices] of Object.entries(listed.devices ?? {})) {
      if (devices.some((device) => device.udid === udid)) return runtime;
    }
  } catch {}
  return null;
}

/**
 * Every reason a machine's offer would not take this app's builds, judged for each of `targets`. A target the machine
 * cannot build at all, such as iOS on Linux, is left out while it can build another of them. With several targets, a
 * reason only one platform has names it.
 */
export function machineProblems(offer: BuildOffer, targets: BuildTarget[]): OffloadProblem[] {
  const judged = targets.map((target) => ({ target, found: offerProblems(offer, target) }));
  const buildable = judged.filter(({ found }) => !found.some((problem) => problem.code === 'platform'));
  const problems: OffloadProblem[] = [];
  for (const { target, found } of buildable.length ? buildable : judged) {
    for (const problem of found) {
      const labeled =
        targets.length > 1 && !SHARED_PROBLEMS.has(problem.code)
          ? { ...problem, reason: `${PLATFORM_LABEL[target.platform]}: ${problem.reason}` }
          : problem;
      if (!problems.some((each) => each.code === labeled.code && each.reason === labeled.reason))
        problems.push(labeled);
    }
  }
  return problems;
}

/** What a build on a machine that would take it does beyond the match, for each of `targets`, labeled like `machineProblems`. */
export function machineNotes(offer: BuildOffer, targets: BuildTarget[]): OffloadProblem[] {
  const notes: OffloadProblem[] = [];
  if (machineProblems(offer, targets).length) return notes;
  for (const target of targets) {
    for (const note of toolchainNotes(target, offer.toolchain)) {
      notes.push(targets.length > 1 ? { ...note, reason: `${PLATFORM_LABEL[target.platform]}: ${note.reason}` } : note);
    }
  }
  return notes;
}

const DOCTOR_CONNECT_MS = 5000;
const DOCTOR_OFFER_MS = 8000;
const PLATFORM_LABEL = { ios: 'iOS', android: 'Android', macos: 'macOS' } as const;
const SHARED_PROBLEMS: ReadonlySet<OffloadProblem['code']> = new Set(['stim-build', 'disk', 'busy']);

/**
 * Doctor's offload check for `projectRoot`: one bounded offer per machine, judged by `machineProblems` for the builds
 * `targets` returns. No build runs.
 */
export function offloadCheck(
  projectRoot: string,
  targets: () => Promise<BuildTarget[]>,
): (
  credential: BuildMachineCredential,
) => Promise<{ capacity: BuildOffer['capacity'] | null; problems: OffloadProblem[]; notes?: OffloadProblem[] }> {
  let identity: Promise<RepoIdentity | string> | undefined;
  const readIdentity = async (): Promise<RepoIdentity | string> => {
    try {
      const repoRoot = realpathSync(await gitAsync(projectRoot, ['rev-parse', '--show-toplevel']));
      const common = realpathSync(
        await gitAsync(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      return repositoryIdentity(projectRoot, repoRoot, common);
    } catch (error) {
      reportSignal(ambientContext())?.throwIfAborted();
      return error instanceof Error ? (error.message.split('\n')[0] ?? 'git failed') : 'git failed';
    }
  };
  let resolved: Promise<BuildTarget[]> | null = null;
  return async (credential) => {
    const repository = await (identity ??= readIdentity());
    if (typeof repository === 'string') {
      return {
        capacity: null,
        problems: [{ code: 'checkout', reason: `this app is not in a git checkout (${repository})` }],
      };
    }
    const probe = await probeMachine(
      credential,
      { ...repository, rubyVersion: readRubyVersion(projectRoot) ?? undefined },
      { connectMs: DOCTOR_CONNECT_MS, offerMs: DOCTOR_OFFER_MS },
    );
    if ('failure' in probe) return { capacity: null, problems: [{ code: 'unreachable', reason: probe.failure }] };
    probe.connection.close();
    resolved ??= targets();
    const judged = await resolved;
    return {
      capacity: probe.offer.capacity,
      problems: machineProblems(probe.offer, judged),
      notes: machineNotes(probe.offer, judged),
    };
  };
}
