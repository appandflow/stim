import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import {
  isJsonObject,
  OFFLOAD_MODES,
  saturation,
  type BuildMachineCredential,
  type MachineCapacity,
  type OffloadMode,
} from '@stim-cli/core/state';
import type { CcacheActivity, CompilationCacheActivity } from '../engine/build-facts.ts';
import { CCACHE_UNAVAILABLE } from '../engine/ccache.ts';
import { COMPILATION_CACHE_UNAVAILABLE } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines, pinnedEndpoint, type Endpoint } from './build-machines.ts';
import { manifestDigest } from './manifest.ts';
import { namedBuildMachine, OffloadRefusal } from './selection.ts';
import { toolchainMismatches, type BuildTarget, type OffloadProblem, type WorkerToolchain } from './toolchain.ts';

const CONNECT_TIMEOUT_MS = 10_000;
const OFFER_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 65 * 60_000;
const PING_MS = 15_000;
const SILENT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2000;
const CLOSE_ABNORMAL = 1006;
const TURNED_AWAY = new Set(['unauthorized', 'forbidden', 'approval-pending', 'protocol-unsupported']);
const RESUME_WINDOW_MS = 3 * 60_000;
const RESUME_DELAY_MS = 2000;
const RESUME_MAX_DELAY_MS = 15_000;
const PAGE_BYTES = 48 * 1024;
const CHUNK_BYTES = 60 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const DIGEST_BYTES = 32;

function offloadMode(env: NodeJS.ProcessEnv = process.env): OffloadMode {
  const raw = env.STIM_OFFLOAD_MODE || loadConfig()?.offload?.mode;
  return OFFLOAD_MODES.includes(raw as OffloadMode) ? (raw as OffloadMode) : 'auto';
}

export function buildPlacementCandidates(selected: string): { mode: OffloadMode; machines: BuildMachineCredential[] } {
  return {
    mode: selected === 'local' ? 'off' : offloadMode(),
    machines:
      selected === 'local'
        ? []
        : namedBuildMachine(selected)
          ? pairedMachines([selected]).slice(0, 1)
          : pairedMachines(),
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
 * Whether a build may go to a build machine at all, before any machine is asked. `auto` keeps the build here while
 * this Mac has a free `concurrency.maxBuilds` slot and its load per core is under `offload.maxLoadPerCore`.
 * A named selection ignores local capacity and mode, and refuses an unsupported build or missing pairing.
 */
export function offloadPlacement({
  mode,
  machines,
  here,
  unsupported,
  selected = 'auto',
}: {
  selected?: string;
  mode: OffloadMode;
  machines: number;
  here: MachineCapacity;
  unsupported: string | null;
}): { offload: boolean; reason: string } {
  if (namedBuildMachine(selected)) {
    if (unsupported) throw new OffloadRefusal(selected, `${unsupported}, so a named build machine cannot take it`);
    if (machines === 0) throw new OffloadRefusal(selected, 'no build machine is paired');
    return { offload: true, reason: `selected with --build-machine ${selected}` };
  }
  if (selected === 'local') return { offload: false, reason: '--build-machine local' };
  if (mode === 'off') return { offload: false, reason: 'offload.mode is off' };
  if (machines === 0) return { offload: false, reason: 'no build machine is paired' };
  if (unsupported) return { offload: false, reason: unsupported };
  if (mode === 'force') return { offload: true, reason: 'offload.mode is force' };
  const busy = saturation(here);
  return busy
    ? { offload: true, reason: `this Mac is busy: ${busy} (${capacityText(here)})` }
    : { offload: false, reason: `${capacityText(here)} here` };
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
    declined?: string | null;
  };
  warm: { checkout: boolean; dependencies: boolean; build: boolean };
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** Every reason a machine's offer cannot take this build, in either mode; empty when it can. */
export function offerProblems(offer: BuildOffer, target: BuildTarget): OffloadProblem[] {
  const problems = toolchainMismatches(target, offer.toolchain);
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
 * `offerProblems` never takes it. In `auto`, a machine must also be expected to build faster than this Mac: while
 * every local build slot is busy any machine that accepts will do, otherwise its load per core must be lower than
 * this Mac's. A named selection considers only that machine and skips this local-capacity gating.
 * A machine that reports no load (a stim-server older than capacity) takes an `auto` build only while
 * every local slot is busy. The rest rank warmest first, then least loaded.
 */
export function pickOffer({
  mode,
  here,
  offers,
  target,
  selected = 'auto',
}: {
  mode: OffloadMode;
  here: MachineCapacity;
  selected?: string;
  offers: Array<{ machine: string; offer: BuildOffer | null; failure?: string }>;
  target: BuildTarget;
}): { order: number[]; reasons: string[] } {
  const slotsFull = here.maxBuilds > 0 && here.builds >= here.maxBuilds;
  const reasons: string[] = [];
  const ranked: Array<{ index: number; score: number; load: number }> = [];
  offers.forEach(({ machine, offer, failure }, index) => {
    if (namedBuildMachine(selected) && machine !== selected) return;
    if (!offer) return void reasons.push(`${machine}: ${failure ?? 'no offer'}`);
    const problems = offerProblems(offer, target);
    if (problems.length) {
      return void reasons.push(`${machine}: ${problems.map((problem) => problem.reason).join('; ')}`);
    }
    const load = offer.capacity.loadPerCore;
    if (selected === 'auto' && mode === 'auto' && !slotsFull) {
      if (typeof load !== 'number') {
        return void reasons.push(`${machine}: capacity unknown (older stim-server) while this Mac has a free slot`);
      }
      if (load >= here.loadPerCore) {
        return void reasons.push(`${machine}: no less loaded (load ${load}/core there, ${here.loadPerCore}/core here)`);
      }
    }
    const score = Number(offer.warm.checkout) + Number(offer.warm.dependencies) + Number(offer.warm.build);
    ranked.push({ index, score, load: typeof load === 'number' ? load : Number.POSITIVE_INFINITY });
  });
  ranked.sort((a, b) => b.score - a.score || a.load - b.load);
  return { order: ranked.map((each) => each.index), reasons };
}

export type Reply = { result: unknown } | { error: { code: string; message: string } };

type ProgressEvent = {
  job: string;
  phase?: string;
  msg?: string;
  record?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
};

const openSockets = new Set<WebSocket>();
let closingOnExit = false;

/**
 * A close frame on every connection still open when this process exits, as on an interrupt, so the machine cancels
 * its builds instead of keeping them for a new connection.
 */
function closeOnExit(socket: WebSocket): void {
  if (!closingOnExit) {
    closingOnExit = true;
    process.once('exit', () => {
      for (const each of openSockets) each.close(1000);
    });
  }
  openSockets.add(socket);
  socket.once('close', () => openSockets.delete(socket));
}

/**
 * One authenticated connection to another Mac's stim-server, for build offload or device hosting. Closing it cancels
 * its build jobs there; a connection that drops, or that stays silent for `SILENT_MS` after `watch()`, leaves them
 * running for a while so a new connection can `build.attach` to them.
 */
export class BuildConnection {
  private nextId = 2;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private progress: ((event: ProgressEvent) => void) | null = null;
  private binary: ((frame: Buffer) => void) | null = null;
  private closed: string | null = null;
  private heard = Date.now();
  private watched = false;
  private ended = false;
  private readonly keepalive: NodeJS.Timeout;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    closeOnExit(socket);
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
      for (const resolve of this.pending.values()) resolve({ error: { code: 'closed', message: this.closed } });
      this.pending.clear();
      const dropped = code === CLOSE_ABNORMAL;
      this.progress?.({ job: '', outcome: { ok: false, code: dropped ? 'dropped' : 'closed', message: this.closed } });
    });
    socket.on('error', () => {});
  }

  /** Resolves why it could not connect; `refused` when the machine answered and turned this Mac away. */
  static open(
    target: Endpoint,
    token: string,
    timeoutMs: number,
    capability: 'build' | 'device-host' = 'build',
  ): Promise<BuildConnection | { failure: string; refused: boolean; code?: string }> {
    return new Promise((resolve) => {
      const options: ClientOptions & ConnectionOptions = {
        handshakeTimeout: timeoutMs,
        servername: target.servername,
        headers: { Host: target.host },
      };
      const socket = new WebSocket(target.url, options);
      const fail = (reason: string, refused = false, code?: string) => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.terminate();
        resolve({ failure: reason, refused, ...(code ? { code } : {}) });
      };
      const timer = setTimeout(() => fail('no reply in time'), timeoutMs);
      socket.once('error', (error) =>
        fail(
          /Unexpected server response: 502/.test(error.message)
            ? 'no stim-server answers behind its tailscale serve route (HTTP 502)'
            : error.message,
        ),
      );
      socket.once('close', () => fail('the connection closed before hello'));
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'hello',
            params: { protocol: 1, client: { name: 'stim', version: '1' }, auth: { deviceToken: token } },
          }),
        );
      });
      socket.once('message', (data) => {
        clearTimeout(timer);
        socket.removeAllListeners();
        let reply: unknown;
        try {
          reply = JSON.parse(String(data));
        } catch {
          return fail('the reply was not a hello result');
        }
        if (isJsonObject(reply) && isJsonObject(reply.error)) {
          return fail(String(reply.error.message), TURNED_AWAY.has(String(reply.error.code)), String(reply.error.code));
        }
        const capabilities = isJsonObject(reply) && isJsonObject(reply.result) ? reply.result.capabilities : null;
        if (!Array.isArray(capabilities) || !capabilities.includes(capability)) {
          return fail(
            `it has not granted this Mac ${capability === 'build' ? 'build' : 'hosting'} access`,
            true,
            'forbidden',
          );
        }
        resolve(new BuildConnection(socket));
      });
    });
  }

  request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Reply> {
    if (this.closed) return Promise.resolve({ error: { code: 'closed', message: this.closed } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: 'timeout', message: `${method} got no reply in ${timeoutMs / 1000} s` } });
      }, timeoutMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async sendBinary(frame: Buffer): Promise<void> {
    this.socket.send(frame, { binary: true });
    while (this.socket.bufferedAmount > MAX_BUFFERED && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
    clearInterval(this.keepalive);
    this.socket.removeAllListeners('close');
    openSockets.delete(this.socket);
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

/** The repository on the build machine: one area per git common dir, shared by all its worktrees. */
function repoIdentity(projectRoot: string): RepoIdentity {
  const run = getExecutor().runFile;
  const repoRoot = realpathSync(run('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel']));
  const common = realpathSync(run('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
  const digest = createHash('sha256').update(common).digest('hex').slice(0, 12);
  const name = (basename(dirname(common)) || 'repo').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  const lock = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find((file) => existsSync(join(repoRoot, file)));
  return {
    repoRoot,
    project: relative(repoRoot, realpathSync(projectRoot)),
    repo: `${name.slice(0, 60) || 'repo'}-${digest}`,
    lockfile: lock
      ? createHash('sha256')
          .update(readFileSync(join(repoRoot, lock)))
          .digest('hex')
      : null,
  };
}

interface ManifestFile {
  path: string;
  kind: 'file' | 'exec' | 'link';
  size: number;
  sha256: string;
}

/** The exact source a build needs: tracked and untracked, not ignored, as `git ls-files -co --exclude-standard`. */
function sourceManifest(repoRoot: string): ManifestFile[] {
  const listed = getExecutor().runFile('git', ['-C', repoRoot, 'ls-files', '-z', '-co', '--exclude-standard'], {
    untrimmed: true,
    timeoutMs: 120_000,
  });
  const files: ManifestFile[] = [];
  for (const path of new Set(listed.split('\0').filter(Boolean))) {
    const absolute = join(repoRoot, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(readlinkSync(absolute));
      files.push({ path, kind: 'link', size: target.length, sha256: sha256(target) });
    } else if (stat.isFile()) {
      const content = readFileSync(absolute);
      files.push({ path, kind: stat.mode & 0o111 ? 'exec' : 'file', size: content.length, sha256: sha256(content) });
    }
  }
  return files;
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function blobContent(repoRoot: string, file: ManifestFile): Buffer {
  const absolute = join(repoRoot, file.path);
  return file.kind === 'link' ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
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

/** A macOS build the build machine keeps for a while, which a hosted session on that tailnet node can take. */
export interface BuildHandoff {
  nodeId: string;
  token: string;
  sha256: string;
}

export type OffloadOutcome =
  | {
      ok: true;
      machine: string;
      /** The `.app` directory or the `.apk` file, under the staging directory. */
      artifactPath: string;
      compilationCache: CompilationCacheActivity;
      ccache: CcacheActivity;
      timings: OffloadTimings;
      handoff?: BuildHandoff;
    }
  | { ok: false; machine: string | null; reason: string };

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
  target: BuildTarget;
  offerMs: number;
  identity: RepoIdentity;
  runnersUp: OfferingMachine[];
}

/** Closes every connection the choice still holds. */
export function closeOffload(choice: OffloadChoice): void {
  choice.connection.close();
  for (const each of choice.runnersUp.splice(0)) each.connection.close();
}

type MachineProbe =
  | { credential: BuildMachineCredential; failure: string }
  | { credential: BuildMachineCredential; connection: BuildConnection; offer: BuildOffer };

/** Connects to one paired machine and asks it for an offer; the caller closes the connection it returns. */
async function probeMachine(
  credential: BuildMachineCredential,
  identity: Pick<RepoIdentity, 'repo' | 'lockfile'>,
  { connectMs = CONNECT_TIMEOUT_MS, offerMs = OFFER_TIMEOUT_MS }: { connectMs?: number; offerMs?: number } = {},
): Promise<MachineProbe> {
  const target = pinnedEndpoint(credential);
  if (typeof target === 'string') return { credential, failure: target };
  const connection = await BuildConnection.open(target, credential.deviceToken, connectMs);
  if (!(connection instanceof BuildConnection)) return { credential, failure: connection.failure };
  const reply = await connection.request(
    'build.offer',
    { repo: identity.repo, ...(identity.lockfile ? { lockfile: identity.lockfile } : {}) },
    offerMs,
  );
  const failure = replyError(reply);
  if (failure || !('result' in reply)) {
    connection.close();
    return { credential, failure: failure ?? 'no offer' };
  }
  return { credential, connection, offer: reply.result as BuildOffer };
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
}: {
  projectRoot: string;
  target: BuildTarget;
  mode: OffloadMode;
  here: MachineCapacity;
  note: (line: string) => void;
  machines?: BuildMachineCredential[];
  selected?: string;
}): Promise<OffloadChoice | string> {
  const started = Date.now();
  let identity: RepoIdentity;
  try {
    identity = repoIdentity(projectRoot);
  } catch (error) {
    return `this app is not in a git checkout (${(error as Error).message.split('\n')[0]})`;
  }
  if (namedBuildMachine(selected)) machines = machines.filter((each) => each.machine === selected).slice(0, 1);
  const asked = await Promise.all(machines.map((credential) => probeMachine(credential, identity)));
  const { order, reasons } = pickOffer({
    selected,
    mode,
    here,
    target,
    offers: asked.map((each) => ({
      machine: each.credential.machine,
      offer: 'offer' in each ? each.offer : null,
      ...('failure' in each ? { failure: each.failure } : {}),
    })),
  });
  asked.forEach((each, at) => {
    if (!order.includes(at) && 'connection' in each) each.connection.close();
  });
  if (order.length === 0) return reasons.length ? reasons.join('; ') : 'no build machine is paired';
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
    target,
    offerMs: Date.now() - started,
    identity,
    runnersUp: rest,
  };
}

/** The Gradle choices that shape the APK, so the machine builds what this Mac's cache key describes. */
export interface AndroidBuildOptions {
  variant: string | null;
  abi: string | null;
  gradleBuildCache: boolean;
  pch: 'auto' | 'on' | 'off';
  compilerCache: 'ccache' | 'none';
}

/** What `build.start` builds besides the synced checkout. */
export type BuildRequest =
  | {
      platform: 'ios';
      runtime: string;
      configuration: string | null;
      scheme: string | null;
      isExpo: boolean;
      optimizations: unknown;
    }
  | { platform: 'android'; isExpo: boolean; android: AndroidBuildOptions }
  | {
      platform: 'macos';
      product: string;
      infoPlist: string;
      bundleId: string;
      resources?: Record<string, string>;
      assetCatalog?: string | null;
    };

const ARTIFACT_NAME = { ios: /^[^/]+\.app$/, android: /^[^/]+\.apk$/, macos: /^[^/]+\.app$/ } as const;

/**
 * Reconnects to the machine that runs `job` and takes the job over with `build.attach`, retrying until
 * `RESUME_WINDOW_MS`, shorter than the machine's grace for a dropped connection, has passed. Returns why it
 * could not.
 */
async function resumeJob(
  credential: BuildMachineCredential,
  job: string,
  abandoned: () => boolean,
): Promise<{ connection: BuildConnection; outcome: Record<string, unknown> | null; early: ProgressEvent[] } | string> {
  const deadline = Date.now() + RESUME_WINDOW_MS;
  let delay = RESUME_DELAY_MS;
  let last = 'no attempt';
  while (!abandoned()) {
    const target = pinnedEndpoint(credential);
    const connection =
      typeof target === 'string'
        ? { failure: target, refused: false }
        : await BuildConnection.open(target, credential.deviceToken, CONNECT_TIMEOUT_MS);
    if (!(connection instanceof BuildConnection)) {
      if (connection.refused) return `the machine turned this Mac away (${connection.failure})`;
      last = connection.failure;
    } else {
      const early: ProgressEvent[] = [];
      connection.onProgress((event) => early.push(event));
      const reply = await connection.request('build.attach', { job }, OFFER_TIMEOUT_MS);
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
    if (Date.now() + delay > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, RESUME_MAX_DELAY_MS);
  }
  return `no connection to it within ${RESUME_WINDOW_MS / 60_000} min (${last})`;
}

/** Mirrors the checkout on the machine: the manifest in pages, then every blob it lacks. */
async function syncSource(
  connection: BuildConnection,
  identity: RepoIdentity,
  onEnter: (phase: string) => void,
): Promise<
  { files: number; uploaded: number; uploadedBytes: number; syncMs: number; digest: string } | { failure: string }
> {
  onEnter('sync');
  const syncStarted = Date.now();
  const manifest = sourceManifest(identity.repoRoot);
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
    const content = blobContent(identity.repoRoot, file);
    if (sha256(content) !== digest) return { failure: `sync: ${file.path} changed while syncing` };
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

/**
 * Builds on the chosen machine and brings the `.app` or `.apk` back into `stagingDir`, verified against the
 * sha256 the machine reports. The caller re-fingerprints and stores it.
 */
export async function offloadBuild({
  choice,
  expectedFingerprint,
  request,
  stagingDir,
  onPhase,
  onEnter,
  onRecord,
  note,
}: {
  choice: OffloadChoice;
  stagingDir: string;
  onPhase: (phase: string, msg: string) => void;
  onEnter: (phase: string) => void;
  onRecord: (record: Record<string, unknown>) => void;
  /** One line about where the build goes, such as the next machine after a refusal. */
  note: (line: string) => void;
} & (
  | { request: Extract<BuildRequest, { platform: 'macos' }>; expectedFingerprint?: never }
  | { request: Exclude<BuildRequest, { platform: 'macos' }>; expectedFingerprint: string }
)): Promise<OffloadOutcome> {
  const { identity } = choice;
  const started = Date.now();
  const fail = (reason: string): OffloadOutcome => {
    closeOffload(choice);
    return { ok: false, machine: choice.machine, reason: reason.split('\n')[0]!.slice(0, 300) };
  };
  try {
    let job: string | null = null;
    let early: ProgressEvent[] = [];
    let settle!: (outcome: Record<string, unknown>) => void;
    let settled = false;
    const outcome = new Promise<Record<string, unknown>>((resolve) => {
      settle = (value) => {
        settled = true;
        resolve(value);
      };
    });
    let resuming = false;
    const reattach = async (why: string) => {
      if (resuming || settled) return;
      resuming = true;
      note(`offload: the connection to ${choice.machine} dropped (${why}); reattaching to the build there`);
      const resumed = await resumeJob(choice.credential, job!, () => settled);
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
    const moveOn = (why: string): boolean => {
      const next = choice.runnersUp.shift();
      if (!next) return false;
      note(`placement: ${next.machine} (${choice.machine} could not take the build: ${why})`);
      choice.connection.close();
      Object.assign(choice, next);
      return true;
    };
    for (;;) {
      const synced = await syncSource(choice.connection, identity, onEnter);
      if ('failure' in synced) {
        if (moveOn(synced.failure)) continue;
        return fail(synced.failure);
      }
      ({ syncMs, uploadedBytes } = synced);
      onPhase(
        'sync',
        `${synced.files} files, uploaded ${synced.uploaded} (${mb(uploadedBytes)}) in ${seconds(syncMs)}`,
      );
      workerStarted = Date.now();
      early = [];
      choice.connection.onProgress((event) => (job === null ? early.push(event) : handle(event)));
      const reply = await choice.connection.request('build.start', {
        repo: identity.repo,
        project: identity.project,
        platform: request.platform,
        fingerprint: request.platform === 'macos' ? synced.digest : expectedFingerprint,
        ...(request.platform === 'macos'
          ? {
              macos: {
                product: request.product,
                infoPlist: request.infoPlist,
                bundleId: request.bundleId,
                ...(request.resources !== undefined ? { resources: request.resources } : {}),
                ...(request.assetCatalog !== undefined ? { assetCatalog: request.assetCatalog } : {}),
              },
            }
          : {
              configuration: request.platform === 'ios' ? request.configuration : null,
              scheme: request.platform === 'ios' ? request.scheme : null,
              runtime: request.platform === 'ios' ? request.runtime : null,
              packageName: packageName(join(identity.repoRoot, identity.project)),
              isExpo: request.isExpo,
              optimizations:
                request.platform === 'ios' && isJsonObject(request.optimizations) ? request.optimizations : null,
              ...(request.platform === 'android' ? { android: request.android } : {}),
            }),
        stimBuild: choice.target.local.stimBuild,
      });
      if ('result' in reply) {
        job = (reply.result as { job: string }).job;
        break;
      }
      const refused = `start: ${replyError(reply)}`;
      if (reply.error.code === 'bad-request' || !moveOn(refused)) return fail(refused);
    }
    for (const each of choice.runnersUp.splice(0)) each.connection.close();
    choice.connection.watch();
    for (const event of early.splice(0)) handle(event);
    const timer = setTimeout(
      () => settle({ ok: false, code: 'timeout', message: 'the build did not finish in time' }),
      JOB_TIMEOUT_MS,
    );
    const result = await outcome;
    clearTimeout(timer);
    const { connection, machine } = choice;
    connection.onProgress(null);
    const workerMs = Date.now() - workerStarted;
    if (result.ok !== true) return fail(`${String(result.code ?? 'failed')}: ${String(result.message ?? '')}`);
    const artifact = result.artifact as { name?: unknown; size?: unknown; sha256?: unknown };
    const name = typeof artifact?.name === 'string' ? artifact.name : '';
    if (!ARTIFACT_NAME[request.platform].test(name) || typeof artifact.sha256 !== 'string') {
      return fail(`the machine reported no .${request.platform === 'android' ? 'apk' : 'app'} artifact`);
    }

    onEnter('fetch');
    const fetchStarted = Date.now();
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
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
      try {
        writeSync(fd, data);
      } catch {
        badFrame = true;
        return;
      }
      hash.update(data);
      received += data.length;
    });
    const fetched = await connection.request('build.artifact', { job }, 15 * 60_000);
    connection.onBinary(null);
    closeSync(fd);
    const fetchFailure = replyError(fetched);
    if (fetchFailure || !('result' in fetched)) return fail(`fetch: ${fetchFailure ?? 'no reply'}`);
    const digest = hash.digest('hex');
    const declared = fetched.result as { size?: unknown; sha256?: unknown; handoff?: unknown };
    if (badFrame) return fail('fetch: an artifact frame had another digest or could not be written here');
    if (digest !== artifact.sha256 || declared.sha256 !== digest || declared.size !== received) {
      return fail(
        `fetch: the artifact's sha256 ${digest.slice(0, 12)} does not match ${String(artifact.sha256).slice(0, 12)}`,
      );
    }
    await getExecutor().runFileAsync('tar', ['-xf', archive, '-C', stagingDir], { timeoutMs: 600_000 });
    rmSync(archive, { force: true });
    const artifactPath = join(stagingDir, name);
    if (request.platform === 'ios' && !existsSync(join(artifactPath, 'Info.plist'))) {
      return fail(`fetch: ${name} has no Info.plist`);
    }
    if (request.platform === 'android' && !(lstatSync(artifactPath, { throwIfNoEntry: false })?.isFile() ?? false)) {
      return fail(`fetch: ${name} is not a file`);
    }
    if (request.platform === 'macos') {
      for (const segments of [
        ['Contents', 'Info.plist'],
        ['Contents', 'MacOS', request.product],
      ]) {
        if (!lstatSync(join(artifactPath, ...segments), { throwIfNoEntry: false })?.isFile())
          return fail(`fetch: ${name} has no regular ${segments.join('/')}`);
      }
    }
    const fetchMs = Date.now() - fetchStarted;
    connection.close();
    return {
      ok: true,
      machine,
      artifactPath,
      ...(request.platform === 'macos' &&
      typeof declared.handoff === 'string' &&
      /^[0-9a-f]{64}$/.test(declared.handoff)
        ? { handoff: { nodeId: choice.credential.nodeId, token: declared.handoff, sha256: digest } }
        : {}),
      compilationCache:
        request.platform === 'ios' ? compilationActivity(result.compilationCache) : COMPILATION_CACHE_UNAVAILABLE,
      ccache: request.platform === 'android' ? ccacheActivity(result.compilationCache) : CCACHE_UNAVAILABLE,
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
    return fail((error as Error).message.split('\n')[0] ?? String(error));
  }
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

const DOCTOR_CONNECT_MS = 5000;
const DOCTOR_OFFER_MS = 8000;
const PLATFORM_LABEL = { ios: 'iOS', android: 'Android', macos: 'macOS' } as const;
const SHARED_PROBLEMS: ReadonlySet<OffloadProblem['code']> = new Set(['stim-build', 'arch', 'disk', 'busy']);

/**
 * Doctor's offload check for `projectRoot`: one bounded offer per machine, judged for each build `targets` returns
 * by `offerProblems` exactly as placement judges it. No build runs. With several targets, a problem that only
 * one platform has names it.
 */
export function offloadCheck(
  projectRoot: string,
  targets: () => BuildTarget[],
): (
  credential: BuildMachineCredential,
) => Promise<{ capacity: BuildOffer['capacity'] | null; problems: OffloadProblem[] }> {
  let identity: RepoIdentity | string;
  try {
    identity = repoIdentity(projectRoot);
  } catch (error) {
    identity = (error as Error).message.split('\n')[0] ?? 'git failed';
  }
  let resolved: BuildTarget[] | null = null;
  return async (credential) => {
    if (typeof identity === 'string') {
      return {
        capacity: null,
        problems: [{ code: 'checkout', reason: `this app is not in a git checkout (${identity})` }],
      };
    }
    const probe = await probeMachine(credential, identity, { connectMs: DOCTOR_CONNECT_MS, offerMs: DOCTOR_OFFER_MS });
    if ('failure' in probe) return { capacity: null, problems: [{ code: 'unreachable', reason: probe.failure }] };
    probe.connection.close();
    resolved ??= targets();
    const problems: OffloadProblem[] = [];
    for (const target of resolved) {
      for (const problem of offerProblems(probe.offer, target)) {
        const labeled =
          resolved.length > 1 && !SHARED_PROBLEMS.has(problem.code)
            ? { ...problem, reason: `${PLATFORM_LABEL[target.platform]}: ${problem.reason}` }
            : problem;
        if (!problems.some((each) => each.code === labeled.code && each.reason === labeled.reason)) {
          problems.push(labeled);
        }
      }
    }
    return { capacity: probe.offer.capacity, problems };
  };
}
