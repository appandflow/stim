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
import { isJsonObject, OFFLOAD_MODES, type BuildMachineCredential, type OffloadMode } from '@stim-cli/core/state';
import type { CompilationCacheActivity } from '../engine/build-facts.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { COMPILATION_CACHE_UNAVAILABLE } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines, pinnedEndpoint, type Endpoint } from './build-machines.ts';
import { iosToolchain, toolchainMismatches, type IosToolchain, type WorkerToolchain } from './toolchain.ts';

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

/**
 * Whether a build goes to a build machine at all, before any machine is asked. `auto` offloads only while every
 * `concurrency.maxBuilds` slot is held by a live build, so an unlimited Mac always builds here.
 */
export function offloadPlacement({
  mode,
  machines,
  liveSlots,
  maxBuilds,
  unsupported,
}: {
  mode: OffloadMode;
  machines: number;
  liveSlots: number;
  maxBuilds: number;
  unsupported: string | null;
}): { offload: boolean; reason: string } {
  if (mode === 'off') return { offload: false, reason: 'offload.mode is off' };
  if (machines === 0) return { offload: false, reason: 'no build machine is paired' };
  if (unsupported) return { offload: false, reason: unsupported };
  if (mode === 'force') return { offload: true, reason: 'offload.mode is force' };
  if (maxBuilds > 0 && liveSlots >= maxBuilds) {
    return { offload: true, reason: `all ${maxBuilds} build slots here are busy` };
  }
  return {
    offload: false,
    reason: maxBuilds > 0 ? `${maxBuilds - liveSlots} of ${maxBuilds} build slots free here` : 'no build limit here',
  };
}

export interface BuildOffer {
  toolchain: WorkerToolchain;
  capacity: { running: number; max: number; diskFreeBytes: number | null; minDiskFreeBytes: number };
  warm: { checkout: boolean; dependencies: boolean; build: boolean };
}

/** Why a machine's offer cannot take this build; null when it can. */
function offerRefusal(offer: BuildOffer, local: IosToolchain, runtime: string): string | null {
  const mismatches = toolchainMismatches(local, offer.toolchain, runtime);
  if (mismatches.length) return `toolchain differs: ${mismatches.join('; ')}`;
  const { running, max, diskFreeBytes, minDiskFreeBytes } = offer.capacity;
  if (running >= max) return `busy with ${running} offloaded build(s)`;
  if (diskFreeBytes !== null && diskFreeBytes < minDiskFreeBytes) {
    return `${(diskFreeBytes / 1024 ** 3).toFixed(1)} GB free, needs ${(minDiskFreeBytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return null;
}

/** The index of the warmest acceptable offer, the least busy among equals; null when none can build. */
export function pickOffer(offers: Array<BuildOffer | null>, local: IosToolchain, runtime: string): number | null {
  let best: { index: number; score: number; running: number } | null = null;
  offers.forEach((offer, index) => {
    if (!offer || offerRefusal(offer, local, runtime)) return;
    const score = Number(offer.warm.checkout) + Number(offer.warm.dependencies) + Number(offer.warm.build);
    const running = offer.capacity.running;
    if (!best || score > best.score || (score === best.score && running < best.running)) {
      best = { index, score, running };
    }
  });
  return (best as { index: number } | null)?.index ?? null;
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

  static open(target: Endpoint, token: string): Promise<BuildConnection | string> {
    return new Promise((resolve) => {
      const options: ClientOptions & ConnectionOptions = {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
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
      const timer = setTimeout(() => fail('no reply in time'), CONNECT_TIMEOUT_MS);
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
      appPath: string;
      compilationCache: CompilationCacheActivity;
      timings: OffloadTimings;
    }
  | { ok: false; machine: string | null; reason: string };

export interface OffloadChoice {
  machine: string;
  local: IosToolchain;
  connection: BuildConnection;
  offerMs: number;
  identity: RepoIdentity;
}

/**
 * Asks every paired machine for an offer in parallel and keeps the connection to the one that takes the build,
 * or returns why none can.
 */
export async function chooseBuildMachine({
  projectRoot,
  runtime,
  note,
  machines = pairedMachines(),
  local = iosToolchain(),
}: {
  projectRoot: string;
  runtime: string;
  note: (line: string) => void;
  machines?: BuildMachineCredential[];
  local?: IosToolchain;
}): Promise<OffloadChoice | string> {
  const started = Date.now();
  let identity: RepoIdentity;
  try {
    identity = repoIdentity(projectRoot);
  } catch (error) {
    return `this app is not in a git checkout (${(error as Error).message.split('\n')[0]})`;
  }
  type Asked =
    | { credential: BuildMachineCredential; failure: string }
    | { credential: BuildMachineCredential; connection: BuildConnection; offer: BuildOffer };
  const asked: Asked[] = await Promise.all(
    machines.map(async (credential): Promise<Asked> => {
      const target = pinnedEndpoint(credential);
      if (typeof target === 'string') return { credential, failure: target };
      const connection = await BuildConnection.open(target, credential.deviceToken);
      if (typeof connection === 'string') return { credential, failure: connection };
      const reply = await connection.request(
        'build.offer',
        { repo: identity.repo, ...(identity.lockfile ? { lockfile: identity.lockfile } : {}) },
        OFFER_TIMEOUT_MS,
      );
      const failure = replyError(reply);
      if (failure || !('result' in reply)) {
        connection.close();
        return { credential, failure: failure ?? 'no offer' };
      }
      return { credential, connection, offer: reply.result as BuildOffer };
    }),
  );
  const offers = asked.map((each) => ('offer' in each ? each.offer : null));
  const chosen = pickOffer(offers, local, runtime);
  const reasons: string[] = [];
  asked.forEach((each, index) => {
    if (index !== chosen && 'connection' in each) each.connection.close();
    const why = 'failure' in each ? each.failure : offers[index] ? offerRefusal(offers[index]!, local, runtime) : null;
    if (why) reasons.push(`${each.credential.machine}: ${why}`);
  });
  if (chosen === null) return reasons.length ? reasons.join('; ') : 'no build machine is paired';
  for (const reason of reasons) note(reason);
  const pick = asked[chosen] as { credential: BuildMachineCredential; connection: BuildConnection };
  return {
    machine: pick.credential.machine,
    local,
    connection: pick.connection,
    offerMs: Date.now() - started,
    identity,
  };
}

/**
 * Builds on the chosen machine and brings the `.app` back into `stagingDir`, verified against the sha256 the
 * machine reports. The caller re-fingerprints and stores it.
 */
export async function offloadIosBuild({
  choice,
  expectedFingerprint,
  runtime,
  configuration,
  scheme,
  isExpo,
  optimizations,
  stagingDir,
  onPhase,
  onRecord,
}: {
  choice: OffloadChoice;
  expectedFingerprint: string;
  runtime: string;
  configuration: string | null;
  scheme: string | null;
  isExpo: boolean;
  optimizations: unknown;
  stagingDir: string;
  onPhase: (phase: string, msg: string) => void;
  onRecord: (record: Record<string, unknown>) => void;
}): Promise<OffloadOutcome> {
  const { machine, connection, identity } = choice;
  const started = Date.now();
  const fail = (reason: string): OffloadOutcome => {
    connection.close();
    return { ok: false, machine, reason: reason.split('\n')[0]!.slice(0, 300) };
  };
  try {
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
      if (event.phase && typeof event.msg === 'string') onPhase(event.phase, event.msg);
    };
    connection.onProgress((event) => (job === null ? early.push(event) : handle(event)));
    const reply = await connection.request('build.start', {
      repo: identity.repo,
      project: identity.project,
      platform: 'ios',
      configuration,
      scheme,
      runtime,
      fingerprint: expectedFingerprint,
      packageName: packageName(join(identity.repoRoot, identity.project)),
      isExpo,
      optimizations: isJsonObject(optimizations) ? optimizations : null,
      stimBuild: choice.local.stimBuild,
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
    if (!/^[^/]+\.app$/.test(name) || typeof artifact.sha256 !== 'string') {
      return fail('the machine reported no .app artifact');
    }

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
    const appPath = join(stagingDir, name);
    if (!existsSync(join(appPath, 'Info.plist'))) return fail(`fetch: ${name} has no Info.plist`);
    const fetchMs = Date.now() - fetchStarted;
    connection.close();
    return {
      ok: true,
      machine,
      appPath,
      compilationCache: compilationActivity(result.compilationCache),
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

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Live build slots here, for `offloadPlacement`. */
export function liveBuildSlots(): number {
  return listBuildSlots().filter((slot) => slot.alive).length;
}

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
