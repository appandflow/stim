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
import { toolchainMismatches, type BuildTarget, type OffloadProblem, type WorkerToolchain } from './toolchain.ts';

const CONNECT_TIMEOUT_MS = 10_000;
const OFFER_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 65 * 60_000;
const PAGE_BYTES = 48 * 1024;
const CHUNK_BYTES = 60 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const DIGEST_BYTES = 32;

export function offloadMode(env: NodeJS.ProcessEnv = process.env): OffloadMode {
  const raw = env.STIM_OFFLOAD_MODE || loadConfig()?.offload?.mode;
  return OFFLOAD_MODES.includes(raw as OffloadMode) ? (raw as OffloadMode) : 'auto';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `load 0.4/core, 1 build`, with the slot count when the Mac caps its builds. */
export function capacityText(capacity: Pick<MachineCapacity, 'loadPerCore' | 'builds' | 'maxBuilds'>): string {
  const builds =
    capacity.maxBuilds > 0
      ? `${capacity.builds} of ${capacity.maxBuilds} build slots busy`
      : plural(capacity.builds, 'build');
  return `load ${capacity.loadPerCore}/core, ${builds}`;
}

/**
 * Whether a build may go to a build machine at all, before any machine is asked. `auto` keeps the build here while
 * this Mac has a free `concurrency.maxBuilds` slot and its load per core is under `offload.maxLoadPerCore`.
 */
export function offloadPlacement({
  mode,
  machines,
  here,
  unsupported,
}: {
  mode: OffloadMode;
  machines: number;
  here: MachineCapacity;
  unsupported: string | null;
}): { offload: boolean; reason: string } {
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
 * Which asked machine takes the build, or none, and one reason per machine that does not. A machine with any
 * `offerProblems` never takes it. In `auto`, a machine must also be expected to build faster than this Mac: while
 * every local build slot is busy any machine that accepts will do, otherwise its load per core must be lower than
 * this Mac's. A machine that reports no load (a stim-server older than capacity) takes an `auto` build only while
 * every local slot is busy. Among the rest, the warmest wins, then the least loaded.
 */
export function pickOffer({
  mode,
  here,
  offers,
  target,
}: {
  mode: OffloadMode;
  here: MachineCapacity;
  offers: Array<{ machine: string; offer: BuildOffer | null; failure?: string }>;
  target: BuildTarget;
}): { index: number | null; reasons: string[] } {
  const slotsFull = here.maxBuilds > 0 && here.builds >= here.maxBuilds;
  const reasons: string[] = [];
  let best: { index: number; score: number; load: number } | null = null;
  offers.forEach(({ machine, offer, failure }, index) => {
    if (!offer) return void reasons.push(`${machine}: ${failure ?? 'no offer'}`);
    const problems = offerProblems(offer, target);
    if (problems.length) {
      return void reasons.push(`${machine}: ${problems.map((problem) => problem.reason).join('; ')}`);
    }
    const load = offer.capacity.loadPerCore;
    if (mode === 'auto' && !slotsFull) {
      if (typeof load !== 'number') {
        return void reasons.push(`${machine}: capacity unknown (older stim-server) while this Mac has a free slot`);
      }
      if (load >= here.loadPerCore) {
        return void reasons.push(`${machine}: no less loaded (load ${load}/core there, ${here.loadPerCore}/core here)`);
      }
    }
    const score = Number(offer.warm.checkout) + Number(offer.warm.dependencies) + Number(offer.warm.build);
    const rank = typeof load === 'number' ? load : Number.POSITIVE_INFINITY;
    if (!best || score > best.score || (score === best.score && rank < best.load)) {
      best = { index, score, load: rank };
    }
  });
  return { index: (best as { index: number } | null)?.index ?? null, reasons };
}

type Reply = { result: unknown } | { error: { code: string; message: string } };

type ProgressEvent = {
  job: string;
  phase?: string;
  msg?: string;
  record?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
};

/** One authenticated connection to a build machine's stim-server. Closing it cancels its jobs there. */
class BuildConnection {
  private nextId = 2;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private progress: ((event: ProgressEvent) => void) | null = null;
  private binary: ((frame: Buffer) => void) | null = null;
  private closed: string | null = null;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
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
      this.closed = `the connection closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`;
      for (const resolve of this.pending.values()) resolve({ error: { code: 'closed', message: this.closed } });
      this.pending.clear();
      this.progress?.({ job: '', outcome: { ok: false, code: 'closed', message: this.closed } });
    });
    socket.on('error', () => {});
  }

  static open(target: Endpoint, token: string, timeoutMs: number): Promise<BuildConnection | string> {
    return new Promise((resolve) => {
      const options: ClientOptions & ConnectionOptions = {
        handshakeTimeout: timeoutMs,
        servername: target.servername,
        headers: { Host: target.host },
      };
      const socket = new WebSocket(target.url, options);
      const fail = (reason: string) => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.terminate();
        resolve(reason);
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
        if (isJsonObject(reply) && isJsonObject(reply.error)) return fail(String(reply.error.message));
        const capabilities = isJsonObject(reply) && isJsonObject(reply.result) ? reply.result.capabilities : null;
        if (!Array.isArray(capabilities) || !capabilities.includes('build')) {
          return fail('it has not granted this Mac build access');
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

  close(): void {
    this.socket.removeAllListeners('close');
    this.socket.terminate();
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

export type OffloadOutcome =
  | {
      ok: true;
      machine: string;
      /** The `.app` directory or the `.apk` file, under the staging directory. */
      artifactPath: string;
      compilationCache: CompilationCacheActivity;
      ccache: CcacheActivity;
      timings: OffloadTimings;
    }
  | { ok: false; machine: string | null; reason: string };

export interface OffloadChoice {
  machine: string;
  target: BuildTarget;
  connection: BuildConnection;
  offerMs: number;
  identity: RepoIdentity;
  offer: BuildOffer;
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
  if (typeof connection === 'string') return { credential, failure: connection };
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
 * returns why none takes the build.
 */
export async function chooseBuildMachine({
  projectRoot,
  target,
  mode,
  here,
  note,
  machines = pairedMachines(),
}: {
  projectRoot: string;
  target: BuildTarget;
  mode: OffloadMode;
  here: MachineCapacity;
  note: (line: string) => void;
  machines?: BuildMachineCredential[];
}): Promise<OffloadChoice | string> {
  const started = Date.now();
  let identity: RepoIdentity;
  try {
    identity = repoIdentity(projectRoot);
  } catch (error) {
    return `this app is not in a git checkout (${(error as Error).message.split('\n')[0]})`;
  }
  const asked = await Promise.all(machines.map((credential) => probeMachine(credential, identity)));
  const { index, reasons } = pickOffer({
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
    if (at !== index && 'connection' in each) each.connection.close();
  });
  if (index === null) return reasons.length ? reasons.join('; ') : 'no build machine is paired';
  for (const reason of reasons) note(reason);
  const pick = asked[index] as { credential: BuildMachineCredential; connection: BuildConnection; offer: BuildOffer };
  return {
    machine: pick.credential.machine,
    target,
    connection: pick.connection,
    offerMs: Date.now() - started,
    identity,
    offer: pick.offer,
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
  | { platform: 'android'; isExpo: boolean; android: AndroidBuildOptions };

const ARTIFACT_NAME = { ios: /^[^/]+\.app$/, android: /^[^/]+\.apk$/ } as const;

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
}: {
  choice: OffloadChoice;
  expectedFingerprint: string;
  request: BuildRequest;
  stagingDir: string;
  onPhase: (phase: string, msg: string) => void;
  /** Called as the build enters each remote phase: sync, then the worker's own phases, then fetch. */
  onEnter: (phase: string) => void;
  onRecord: (record: Record<string, unknown>) => void;
}): Promise<OffloadOutcome> {
  const { machine, connection, identity } = choice;
  const started = Date.now();
  const fail = (reason: string): OffloadOutcome => {
    connection.close();
    return { ok: false, machine, reason: reason.split('\n')[0]!.slice(0, 300) };
  };
  try {
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
      if (failure || !('result' in reply)) return fail(`sync: ${failure ?? 'no reply'}`);
      missing.push(...((reply.result as { missing?: string[] }).missing ?? []));
      if (done) break;
    }
    let uploadedBytes = 0;
    for (const digest of missing) {
      const file = bySha.get(digest);
      if (!file) return fail(`sync: the machine asked for an unknown blob ${digest}`);
      const content = blobContent(identity.repoRoot, file);
      if (sha256(content) !== digest) return fail(`sync: ${file.path} changed while syncing`);
      const header = Buffer.from(digest, 'hex');
      for (let offset = 0; offset < content.length || offset === 0; offset += CHUNK_BYTES) {
        await connection.sendBinary(Buffer.concat([header, content.subarray(offset, offset + CHUNK_BYTES)]));
        if (content.length === 0) break;
      }
      uploadedBytes += content.length;
      if (connection.failure) return fail(`sync: ${connection.failure}`);
    }
    const syncMs = Date.now() - syncStarted;
    onPhase(
      'sync',
      `${manifest.length} files, uploaded ${missing.length} (${mb(uploadedBytes)}) in ${seconds(syncMs)}`,
    );

    const workerStarted = Date.now();
    let job: string | null = null;
    const early: ProgressEvent[] = [];
    let settle!: (outcome: Record<string, unknown>) => void;
    const outcome = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve;
    });
    const handle = (event: ProgressEvent) => {
      if (event.job && event.job !== job) return;
      if (event.outcome) return settle(event.outcome);
      if (event.record) onRecord(event.record);
      if (event.phase && typeof event.msg === 'string') {
        onEnter(event.phase);
        onPhase(event.phase, event.msg);
      }
    };
    connection.onProgress((event) => (job === null ? early.push(event) : handle(event)));
    const reply = await connection.request('build.start', {
      repo: identity.repo,
      project: identity.project,
      platform: request.platform,
      configuration: request.platform === 'ios' ? request.configuration : null,
      scheme: request.platform === 'ios' ? request.scheme : null,
      runtime: request.platform === 'ios' ? request.runtime : null,
      fingerprint: expectedFingerprint,
      packageName: packageName(join(identity.repoRoot, identity.project)),
      isExpo: request.isExpo,
      optimizations: request.platform === 'ios' && isJsonObject(request.optimizations) ? request.optimizations : null,
      ...(request.platform === 'android' ? { android: request.android } : {}),
      stimBuild: choice.target.local.stimBuild,
    });
    const refused = replyError(reply);
    if (refused || !('result' in reply)) return fail(`start: ${refused ?? 'no reply'}`);
    job = (reply.result as { job: string }).job;
    for (const event of early.splice(0)) handle(event);
    const timer = setTimeout(
      () => settle({ ok: false, code: 'timeout', message: 'the build did not finish in time' }),
      JOB_TIMEOUT_MS,
    );
    const result = await outcome;
    clearTimeout(timer);
    connection.onProgress(null);
    const workerMs = Date.now() - workerStarted;
    if (result.ok !== true) return fail(`${String(result.code ?? 'failed')}: ${String(result.message ?? '')}`);
    const artifact = result.artifact as { name?: unknown; size?: unknown; sha256?: unknown };
    const name = typeof artifact?.name === 'string' ? artifact.name : '';
    if (!ARTIFACT_NAME[request.platform].test(name) || typeof artifact.sha256 !== 'string') {
      return fail(`the machine reported no .${request.platform === 'ios' ? 'app' : 'apk'} artifact`);
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
    const declared = fetched.result as { size?: unknown; sha256?: unknown };
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
    const fetchMs = Date.now() - fetchStarted;
    connection.close();
    return {
      ok: true,
      machine,
      artifactPath,
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
const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' } as const;
const SHARED_PROBLEMS: ReadonlySet<OffloadProblem['code']> = new Set(['stim-build', 'arch', 'disk', 'busy']);

/**
 * Doctor's offload check for `projectRoot`: one bounded offer per machine, judged for each build `targets` returns
 * by `offerProblems` exactly as placement judges it. No build runs. With several targets, a problem that only
 * one platform has names it.
 */
export function offloadCheck(
  projectRoot: string,
  targets: () => BuildTarget[],
): (credential: BuildMachineCredential) => Promise<{ capacity: BuildOffer['capacity'] | null; problems: OffloadProblem[] }> {
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
