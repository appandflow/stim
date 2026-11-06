import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { JobFrameReader, jobFrame } from '@stim-cli/core/noise-session';
import { isJsonObject, loadConfig, stimBuildId } from '@stim-cli/core/state';
import {
  OFFLOAD_JOB_KINDS,
  STIM_BUILD_ID_PATTERN,
  BUILD_REPO_PATTERN,
  type JobStartResult,
  type OffloadJobKind,
  type ProtocolError,
} from './protocol.ts';
import type { BuildLimits } from './build.ts';
import type { ServerSocket as NoiseSocket } from './handlers/context.ts';

const MAX_PACKAGE_BYTES = 256 * 1024 ** 2;
const MAX_BUFFERED = 16 * 1024 * 1024;
const BUFFER_POLL_MS = 10;
const STOP_GRACE_MS = 10_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CLOSE_ABNORMAL = 1006;
const CLOSE_BAD_REQUEST = 4400;
const JOB_BAD_REQUEST = 64;
const FAILED_FETCH_MS = 10 * 60_000;
const NOT_ACCEPTED =
  'This machine takes only published Stim builds. To take this build, run stim settings set server.acceptClientBuilds true on it.';

/** Why an install failed; `mismatch` when npm holds no release of this exact build. */
type InstallFailure = { failure: string; mismatch: boolean } | null;

type Answer = { result: JobStartResult } | { error: ProtocolError };

const refused = (code: ProtocolError['code'], message: string): Answer => ({ error: { code, message } });

/** A connection's client: its build approval's id and name. */
export interface JobClient {
  id: string;
  name: string;
}

interface Job {
  id: string;
  kind: OffloadJobKind;
  client: string;
  repo: string;
  child: ChildProcess;
  socket: NoiseSocket | null;
  grace: NodeJS.Timeout | null;
  exited?: Promise<void>;
}

interface Upload {
  id: string;
  dir: string;
  name: string;
  size: number;
  sha256: string;
  received: number;
  hash: Hash;
}

export interface OffloadJobsOptions {
  /** This build's `dist/cli.mjs`, which fetches client builds into the engine store. */
  stimCli: string;
  /** This machine's name, for refusals. */
  machine: string;
  /** The environment jobs start with, read at each start so they see tools installed since. */
  env: () => NodeJS.ProcessEnv;
  limits: BuildLimits;
  /** Called before each job starts: why it cannot start now, or null. */
  admit: (client: string) => string | null;
  /** Called after the last job of `client` exits. */
  idle: (client: string) => void;
}

// compat C14 permanent
/** Whether this Node meets `engines`' `>=X.Y.Z` floor; another form is not checked. */
function meetsNode(engines: unknown): boolean {
  const [, a = '0', b = '0', c = '0'] = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(String(engines).trim()) ?? [];
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
  return major * 1e6 + minor * 1e3 + patch >= Number(a) * 1e6 + Number(b) * 1e3 + Number(c);
}
// compat end

/**
 * The offload jobs of this stimd: each runs a client's exact Stim build as `<node> <entry>/dist/cli.mjs __job <kind>`
 * and owns the client's connection after `job.start`. Each Noise message the client sends goes to the job's stdin as
 * one frame, and each frame the job writes to stdout goes back as one Noise message; stimd parses neither. A closed
 * connection ends the job's stdin, a dropped one keeps the job for `detachGraceMs` for `job.start {attach}`, and
 * SIGTERM cancels it.
 */
export class OffloadJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly spliced = new WeakMap<object, Job>();
  private readonly uploads = new WeakMap<object, Upload>();
  private readonly fetches = new Map<string, Promise<InstallFailure>>();
  private readonly failed = new Map<string, { failure: InstallFailure; at: number }>();
  private readonly options: OffloadJobsOptions;
  private closed = false;
  private own: string | null = null;

  constructor(options: OffloadJobsOptions) {
    this.options = options;
  }

  private root(): string {
    return this.options.env().STIM_ENGINE_ROOT || join(homedir(), '.stim', 'engine');
  }

  /** The repositories the running jobs use, by client. */
  live(): { client: string; repo: string }[] {
    return [...this.jobs.values()].map(({ client, repo }) => ({ client, repo }));
  }

  /** The `offload-build` jobs running now. */
  running(): number {
    return [...this.jobs.values()].filter((job) => job.kind === 'offload-build').length;
  }

  /** Whether `socket` belongs to a job now; its messages then go to {@link deliver}. */
  owns(socket: object): boolean {
    return this.spliced.has(socket);
  }

  // compat C14 permanent
  /** Passes one decrypted message of `socket` to its job unread, pausing `socket` while the job's stdin is full. */
  deliver(socket: NoiseSocket, data: Buffer, binary: boolean): void {
    const job = this.spliced.get(socket);
    if (!job?.child.stdin || job.child.stdin.destroyed) return;
    if (!job.child.stdin.write(jobFrame(data, binary))) {
      socket.pause();
      job.child.stdin.once('drain', () => socket.resume());
    }
  }

  // compat end
  /** Takes one binary message of an upload `job.start` asked for; false when `socket` has none. */
  receive(socket: object, frame: Buffer): boolean | string {
    const upload = this.uploads.get(socket);
    if (!upload) return false;
    if (upload.received + frame.length > upload.size) return `${upload.name} is larger than it said`;
    appendFileSync(join(upload.dir, upload.name), frame, { mode: 0o600 });
    upload.hash.update(frame);
    upload.received += frame.length;
    return true;
  }

  /** Ends the job of a closed connection: its stdin ends, or after `detachGraceMs` when the connection dropped. */
  disconnected(socket: object, code: number): void {
    const upload = this.uploads.get(socket);
    if (upload) rmSync(upload.dir, { recursive: true, force: true });
    this.uploads.delete(socket);
    const job = this.spliced.get(socket);
    if (!job) return;
    this.spliced.delete(socket);
    job.socket = null;
    if (code !== CLOSE_ABNORMAL || this.closed) return void job.child.stdin?.end();
    job.grace = setTimeout(() => job.child.stdin?.end(), this.options.limits.detachGraceMs);
    job.grace.unref();
  }

  async start(client: JobClient, socket: NoiseSocket, params: unknown): Promise<Answer> {
    if (this.spliced.has(socket)) return refused('bad-request', 'This connection already runs a job.');
    if (isJsonObject(params) && typeof params.attach === 'string') return this.attach(client, socket, params.attach);
    if (
      !isJsonObject(params) ||
      !(OFFLOAD_JOB_KINDS as readonly unknown[]).includes(params.kind) ||
      typeof params.stim !== 'string' ||
      !VERSION.test(params.stim) ||
      typeof params.build !== 'string' ||
      !new RegExp(STIM_BUILD_ID_PATTERN).test(params.build) ||
      typeof params.repo !== 'string' ||
      !new RegExp(BUILD_REPO_PATTERN).test(params.repo)
    )
      return refused('bad-request', 'job.start needs kind, stim, a 12-hex build and repo, or attach.');
    const kind = params.kind as OffloadJobKind;
    const { stim, build, repo } = params;
    const why = this.refusal(client);
    if (why) return refused('build-busy', why);
    let entry = this.entry(build);
    if (!entry) {
      const upload = this.uploads.get(socket);
      if (typeof params.upload === 'string') {
        if (!upload || upload.id !== params.upload) return refused('bad-request', 'No such upload on this connection.');
        this.uploads.delete(socket);
        if (upload.received !== upload.size || upload.hash.digest('hex') !== upload.sha256) {
          rmSync(upload.dir, { recursive: true, force: true });
          return refused('bad-request', `${upload.name} did not arrive whole.`);
        }
        const failed = await this.install(build, ['from', upload.dir]).finally(() =>
          rmSync(upload.dir, { recursive: true, force: true }),
        );
        if (failed) return refused('job-refused', this.cannotInstall(stim, failed.failure));
      } else if (params.package !== undefined) return this.prepareUpload(socket, params.package);
      else if (params.pack === true) {
        return this.acceptsClientBuilds()
          ? refused('job-needs-package', `${this.options.machine} runs only builds it is sent for this Stim.`)
          : refused('forbidden', NOT_ACCEPTED);
      } else {
        const recent = this.failed.get(build);
        const fetching = recent && Date.now() - recent.at < FAILED_FETCH_MS ? null : this.fetch(stim, build);
        if (fetching && params.wait !== true)
          return refused(
            'job-unavailable',
            `${this.options.machine} is installing stim ${stim} to run this Mac's builds; it takes them once that finishes.`,
          );
        const failed = fetching ? await fetching : recent!.failure;
        if (failed?.mismatch)
          return this.acceptsClientBuilds()
            ? refused('job-needs-package', `${this.options.machine} cannot fetch this build of stim ${stim} from npm.`)
            : refused('forbidden', NOT_ACCEPTED);
        if (failed) return refused('job-refused', this.cannotInstall(stim, failed.failure));
      }
      entry = this.entry(build);
      if (!entry) return refused('job-refused', this.cannotInstall(stim, 'the installed build is gone'));
    }
    if (typeof entry === 'string') return refused('job-refused', entry);
    const late = this.refusal(client);
    if (late) return refused('build-busy', late);
    if (socket.readyState !== socket.OPEN) return refused('build-refused', 'The connection closed.');
    const job = this.spawn(kind, client, repo, entry);
    this.attachSocket(job, socket);
    return { result: { job: job.id } };
  }

  private refusal(client: JobClient): string | null {
    return this.closed ? 'This machine is stopping.' : this.options.admit(client.id);
  }

  private cannotInstall(stim: string, failure: string): string {
    const machine = this.options.machine;
    return `worker ${machine} cannot install stim ${stim} (${failure}); building locally. On ${machine} run: stim engine install ${stim}`;
  }

  // compat C14 permanent
  /** The CLI script of `build` and the Node to run it with, why it cannot run, or null when it is not installed. */
  private entry(build: string): { cli: string; node: string } | string | null {
    this.own ??= stimBuildId(dirname(this.options.stimCli));
    if (this.own === build) return { cli: this.options.stimCli, node: process.execPath };
    const tree = join(this.root(), build);
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(tree, '.stim-manifest.json'), 'utf8'));
    } catch {
      return null;
    }
    if (!isJsonObject(manifest) || manifest.build !== build) return null;
    if (!meetsNode(manifest.engines))
      return `${this.options.machine} runs Node ${process.versions.node}; stim ${String(manifest.version)} needs Node ${String(manifest.engines)}. Update Node on ${this.options.machine}.`;
    return { cli: join(tree, 'dist', 'cli.mjs'), node: process.execPath };
  }
  // compat end

  private acceptsClientBuilds(): boolean {
    return loadConfig()?.server?.acceptClientBuilds === true;
  }

  private prepareUpload(socket: NoiseSocket, value: unknown): Answer {
    if (!this.acceptsClientBuilds()) return refused('forbidden', NOT_ACCEPTED);
    if (
      !isJsonObject(value) ||
      typeof value.name !== 'string' ||
      !/^[A-Za-z0-9._-]{1,200}\.tgz$/.test(value.name) ||
      typeof value.size !== 'number' ||
      !Number.isInteger(value.size) ||
      value.size <= 0 ||
      value.size > MAX_PACKAGE_BYTES ||
      typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    )
      return refused(
        'bad-request',
        `A package is a .tgz name, a size up to ${MAX_PACKAGE_BYTES} bytes and its sha256.`,
      );
    const previous = this.uploads.get(socket);
    if (previous) rmSync(previous.dir, { recursive: true, force: true });
    const id = randomUUID();
    const dir = join(this.root(), `.tmp-${process.pid}-upload-${id}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.uploads.set(socket, {
      id,
      dir,
      name: value.name,
      size: value.size,
      sha256: value.sha256,
      received: 0,
      hash: createHash('sha256'),
    });
    return { result: { upload: id } };
  }

  // compat C14 permanent
  /** Installs `stim@<stim>` once per build however many connections ask; resolves why it failed, or null. */
  private fetch(stim: string, build: string): Promise<InstallFailure> {
    let fetching = this.fetches.get(build);
    if (!fetching) {
      fetching = this.install(build, ['release', stim]).then((failure) => {
        this.fetches.delete(build);
        if (failure) this.failed.set(build, { failure, at: Date.now() });
        else this.failed.delete(build);
        return failure;
      });
      this.fetches.set(build, fetching);
    }
    return fetching;
  }

  private install(build: string, source: [string, string]): Promise<InstallFailure> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.options.stimCli, '__job', 'install', this.root(), build, ...source], {
        env: this.options.env(),
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (out += chunk));
      child.on('error', (error) => resolve({ failure: error.message, mismatch: false }));
      child.on('close', () => {
        let reply: Record<string, unknown> = {};
        try {
          reply = JSON.parse(out);
        } catch {}
        if (reply.build === build) return resolve(null);
        resolve({ failure: String(reply.error ?? 'the install failed'), mismatch: reply.mismatch === true });
      });
    });
  }
  // compat end

  // compat C14 permanent
  private spawn(kind: OffloadJobKind, client: JobClient, repo: string, entry: { cli: string; node: string }): Job {
    const spec = { client: client.id, clientName: client.name, limits: this.options.limits };
    const child = spawn(entry.node, [entry.cli, '__job', kind], {
      env: { ...this.options.env(), STIM_JOB_SPEC: JSON.stringify(spec) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const job: Job = { id: randomUUID(), kind, client: client.id, repo, child, socket: null, grace: null };
    this.jobs.set(job.id, job);
    child.stdin.on('error', () => {});
    const reader = new JobFrameReader();
    child.stdout.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        return void child.kill('SIGTERM');
      }
      const socket = job.socket;
      if (!socket) return;
      for (const frame of frames) socket.send(frame.data, { binary: frame.binary });
      if (socket.bufferedAmount <= MAX_BUFFERED) return;
      child.stdout.pause();
      const wait = setInterval(() => {
        if (job.socket === socket && socket.readyState === socket.OPEN && socket.bufferedAmount > MAX_BUFFERED) return;
        clearInterval(wait);
        child.stdout.resume();
      }, BUFFER_POLL_MS);
    });
    job.exited = new Promise((resolve) => {
      child.on('error', () => {});
      child.on('close', (code) => {
        if (job.grace) clearTimeout(job.grace);
        this.jobs.delete(job.id);
        const socket = job.socket;
        if (socket) {
          this.spliced.delete(socket);
          socket.close(code === 0 ? 1000 : code === JOB_BAD_REQUEST ? CLOSE_BAD_REQUEST : 1011, 'job ended');
        }
        if (![...this.jobs.values()].some((each) => each.client === job.client)) this.options.idle(job.client);
        resolve();
      });
    });
    return job;
  }
  // compat end

  private attachSocket(job: Job, socket: NoiseSocket): void {
    if (job.grace) clearTimeout(job.grace);
    job.grace = null;
    job.socket = socket;
    this.spliced.set(socket, job);
  }

  private attach(client: JobClient, socket: NoiseSocket, id: string): Answer {
    const job = this.jobs.get(id);
    if (!job || job.client !== client.id || !job.child.stdin?.writable)
      return refused('bad-request', 'No such job for this device; it ended.');
    if (job.socket) this.spliced.delete(job.socket);
    this.attachSocket(job, socket);
    return { result: { job: job.id } };
  }

  /** Cancels the jobs of `client` with SIGTERM, resolving once each has exited. */
  stop(client: string | null): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => client === null || job.client === client);
    for (const job of jobs) {
      job.child.kill('SIGTERM');
      setTimeout(() => job.child.kill('SIGKILL'), STOP_GRACE_MS).unref();
    }
    return Promise.all(jobs.map((job) => job.exited)).then(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop(null);
  }
}
