import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type {
  ProtocolError,
  EngineUpdateOutcome,
  EngineUpdatePackage,
  EngineUpdateProgress,
  EngineUpdateStatus,
} from './protocol.ts';
import { compareVersions, validateRelease, type ServerBuild } from './service-plist.ts';
import { serviceManagerOrNull, serviceRoot } from './service-manager.ts';
import { runsAsService } from './service.ts';
import { engineSelectArgs, engineSelectOutcome } from './engine-select.ts';
import type { UpdateSource } from './release-install.ts';

const UPDATE_CHUNK_CHARS = 32 * 1024;
const MAX_PACKAGES = 16;
const MAX_PACKAGE_BYTES = 64 * 1024 ** 2;
const MAX_UPLOAD_BYTES = 128 * 1024 ** 2;
const UPLOAD_IDLE_MS = 10 * 60_000;
const STALE_INCOMING_MS = 60 * 60_000;
const LOG_LINES = 20;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tgz$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Answer = { result: EngineUpdateProgress } | { error: ProtocolError };

export interface EngineUpdateOptions {
  label: string | null;
  port: number;
  build: ServerBuild;
  node: string;
  script: string;
  env: NodeJS.ProcessEnv;
  acceptsClientBuilds: () => boolean;
  drain: (reason: string | null) => void;
  audit: (record: {
    by: EngineUpdateProgress['by'];
    target: string;
    phase: 'started' | 'ended';
    ok: boolean;
    message: string;
  }) => void;
  runsAsService?: (label: string, port: number) => Promise<boolean>;
  /** How to start the updater so it outlives this server's restart; the service manager's way by default. */
  detached?: (node: string, args: string[]) => { file: string; args: string[] };
}

interface Upload {
  packages: (EngineUpdatePackage & { received: number; hash: ReturnType<typeof createHash> })[];
  dir: string;
}

const describeSource = (source: UpdateSource): string =>
  'release' in source ? `release ${source.release}` : `packages in ${source.from}`;

const RUNNING = 'The update is running.';
const outcomeFile = (root: string) => join(root, 'last-update.json');

function recordOutcome(root: string, outcome: EngineUpdateOutcome): void {
  const file = outcomeFile(root);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(outcome)}\n`);
  renameSync(partial, file);
}

/**
 * How the last update of this service ended. An update that switched the engine restarted the server that started
 * it, so its outcome is the result `engine-select` left as the last line of `update.log`.
 */
function readLastUpdate(root: string): EngineUpdateOutcome | null {
  let recorded: EngineUpdateOutcome;
  try {
    const value: unknown = JSON.parse(readFileSync(outcomeFile(root), 'utf8'));
    if (!isJsonObject(value)) return null;
    const { at, target, ok, message } = value;
    if (typeof at !== 'string' || typeof target !== 'string' || typeof ok !== 'boolean' || typeof message !== 'string')
      return null;
    recorded = { at, target, ok, message };
  } catch {
    return null;
  }
  if (recorded.message !== RUNNING) return recorded;
  try {
    const log = join(root, 'update.log');
    const ended = engineSelectOutcome(readFileSync(log, 'utf8'));
    return { ...recorded, ...ended, at: statSync(log).mtime.toISOString() };
  } catch {
    return recorded;
  }
}

/** Whether `script`, the entry stimd runs, is a build in the machine engine's store, which follows `current.json`. */
function runsFromEngine(script: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const root = realpathSync(env.STIM_ENGINE_ROOT || join(homedir(), '.stim', 'engine'));
    const [build, dist] = relative(root, realpathSync(script)).split(sep);
    return /^[0-9a-f]{12}$/.test(build ?? '') && dist === 'dist';
  } catch {
    return false;
  }
}

const refused = (code: ProtocolError['code'], message: string): { error: ProtocolError } => ({
  error: { code, message },
});

/** Parses `engine.update` params, or says why they are refused. */
function parseUpdateStart(params: unknown): { version: string } | { packages: EngineUpdatePackage[] } | string {
  if (!isJsonObject(params)) return 'engine.update takes version or packages.';
  if ('version' in params === 'packages' in params) return 'engine.update takes exactly one of version or packages.';
  if (typeof params.version === 'string') return validateRelease(params.version) ?? { version: params.version };
  if (!Array.isArray(params.packages) || params.packages.length === 0 || params.packages.length > MAX_PACKAGES) {
    return `packages lists 1 to ${MAX_PACKAGES} .tgz files.`;
  }
  const packages: EngineUpdatePackage[] = [];
  for (const entry of params.packages) {
    if (
      !isJsonObject(entry) ||
      typeof entry.name !== 'string' ||
      !PACKAGE_NAME.test(entry.name) ||
      !Number.isInteger(entry.size) ||
      (entry.size as number) < 1 ||
      (entry.size as number) > MAX_PACKAGE_BYTES ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      return `Each package needs a .tgz name, a size of at most ${MAX_PACKAGE_BYTES / 1024 ** 2} MiB and a sha256.`;
    }
    if (packages.some((each) => each.name.toLowerCase() === (entry.name as string).toLowerCase())) {
      return `${entry.name} is listed twice.`;
    }
    packages.push({ name: entry.name, size: entry.size as number, sha256: entry.sha256 });
  }
  if (packages.reduce((sum, each) => sum + each.size, 0) > MAX_UPLOAD_BYTES) {
    return `The packages add up to more than ${MAX_UPLOAD_BYTES / 1024 ** 2} MiB.`;
  }
  return { packages };
}

/**
 * Moves the machine engine for a client this machine approved for builds or device hosting: this build's
 * `engine-select` installs the release or the uploaded packages as an unattended promotion, which the engine's pin,
 * its builds marked bad and the not-newer rule refuse, and which is staged while work runs. It runs detached, with its
 * output in a log file rather than a pipe, so it survives the restart of this server that the switch causes.
 */
export class EngineUpdates {
  private readonly options: EngineUpdateOptions;
  private running: EngineUpdateProgress | null = null;
  private upload: Upload | null = null;
  private idle: NodeJS.Timeout | null = null;
  private ended: EngineUpdateOutcome | null = null;

  constructor(options: EngineUpdateOptions) {
    this.options = options;
    this.sweepIncoming();
  }

  private sweepIncoming(): void {
    const root = this.root();
    if (!root) return;
    const incoming = join(root, 'incoming');
    let entries: string[];
    try {
      entries = readdirSync(incoming);
    } catch {
      return;
    }
    const finished = Date.parse(readLastUpdate(root)?.at ?? '') || 0;
    for (const entry of entries) {
      try {
        const written = statSync(join(incoming, entry)).mtimeMs;
        if (written < finished || Date.now() - written > STALE_INCOMING_MS) {
          rmSync(join(incoming, entry), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  private root(): string | null {
    return this.options.label ? serviceRoot(this.options.label) : null;
  }

  private logFile(): string {
    return join(this.root()!, 'update.log');
  }

  private progress(): EngineUpdateProgress | null {
    if (!this.running) return null;
    let log: string[] = [];
    if (this.running.state === 'installing') {
      try {
        log = readFileSync(this.logFile(), 'utf8').trimEnd().split('\n').filter(Boolean).slice(-LOG_LINES);
      } catch {}
    }
    const missing = (this.upload?.packages ?? [])
      .filter((each) => each.received < each.size)
      .map((each) => ({ name: each.name, offset: each.received }));
    return { ...this.running, missing, log };
  }

  async status(): Promise<EngineUpdateStatus> {
    const label = this.options.label;
    const service = label && (await (this.options.runsAsService ?? runsAsService)(label, this.options.port));
    return {
      server: this.options.build,
      service: service ? label : null,
      acceptsClientBuilds: this.options.acceptsClientBuilds(),
      running: this.progress(),
      last: service && label ? this.latest(readLastUpdate(serviceRoot(label))) : null,
    };
  }

  private latest(recorded: EngineUpdateOutcome | null): EngineUpdateOutcome | null {
    if (!this.ended) return recorded;
    if (!recorded) return this.ended;
    return Date.parse(recorded.at) >= Date.parse(this.ended.at) ? recorded : this.ended;
  }

  async start(by: EngineUpdateProgress['by'], params: unknown): Promise<Answer> {
    const parsed = parseUpdateStart(params);
    if (typeof parsed === 'string') return refused('bad-request', parsed);
    if ('version' in parsed && compareVersions(parsed.version, this.options.build.version) < 0) {
      return refused(
        'bad-request',
        `This server runs ${this.options.build.version}; it does not install the older release ${parsed.version} on a client's request. To downgrade it, run \`stim engine use ${parsed.version}\` on the machine it runs on.`,
      );
    }
    const label = this.options.label;
    if (!label || !(await (this.options.runsAsService ?? runsAsService)(label, this.options.port))) {
      return refused(
        'forbidden',
        'This stim-server was not started by `stim service install`, so it cannot update itself. Update it where it runs.',
      );
    }
    if ('packages' in parsed && !this.options.acceptsClientBuilds()) {
      return refused(
        'forbidden',
        'This machine installs only stim releases from npm. To take this build, run `stim settings set server.acceptClientBuilds true` on it.',
      );
    }
    if (!runsFromEngine(this.options.script, this.options.env))
      return refused(
        'forbidden',
        'This service does not run the Stim engine, so it cannot update itself. On this machine run `stim engine install`, then `stim service install`.',
      );
    if (this.running)
      return refused('action-busy', `An update of this server is already running (${this.running.target}).`);
    const id = randomUUID();
    const base = { id, by, startedAt: new Date().toISOString() };
    if ('version' in parsed) {
      this.running = { ...base, target: `release ${parsed.version}`, state: 'installing', missing: [], log: [] };
      return this.launch({ release: parsed.version }) ?? { result: this.progress()! };
    }
    const incoming = join(this.root()!, 'incoming');
    const dir = join(incoming, id);
    this.running = { ...base, target: `packages from ${by.name}`, state: 'uploading', missing: [], log: [] };
    this.sweepIncoming();
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return this.abandon('action-failed', `Could not write ${dir}: ${(error as Error).message}`);
    }
    this.upload = {
      dir,
      packages: parsed.packages.map(({ name, size, sha256 }) => ({
        name,
        size,
        sha256,
        received: 0,
        hash: createHash('sha256'),
      })),
    };
    this.watchIdle();
    return { result: this.progress()! };
  }

  chunk(client: string, params: unknown): Answer {
    const upload = this.upload;
    if (!upload || !this.running || this.running.by.id !== client) {
      return refused('bad-request', 'No package upload from this machine is running; call engine.update first.');
    }
    if (this.running.state !== 'uploading') {
      return refused('action-busy', 'Every package arrived; the update is installing them.');
    }
    if (
      !isJsonObject(params) ||
      params.id !== this.running.id ||
      typeof params.name !== 'string' ||
      typeof params.data !== 'string' ||
      params.data.length > UPDATE_CHUNK_CHARS ||
      !Number.isInteger(params.offset)
    ) {
      return refused(
        'bad-request',
        `engine.update.chunk takes id, name, offset and at most ${UPDATE_CHUNK_CHARS} characters of base64 data.`,
      );
    }
    const entry = upload.packages.find((each) => each.name === params.name);
    if (!entry) return refused('bad-request', `${params.name} is not one of the packages this update offered.`);
    if (params.offset !== entry.received) {
      return refused(
        'bad-request',
        `${entry.name} continues at offset ${entry.received}, not ${String(params.offset)}.`,
      );
    }
    const bytes = Buffer.from(params.data, 'base64');
    if (bytes.length === 0) return refused('bad-request', 'A chunk carries at least one byte.');
    if (entry.received + bytes.length > entry.size) {
      return this.abandon('bad-request', `${entry.name} is larger than the ${entry.size} bytes it offered.`);
    }
    try {
      appendFileSync(join(upload.dir, entry.name), bytes, { mode: 0o600 });
    } catch (error) {
      return this.abandon('action-failed', `Could not write ${entry.name}: ${(error as Error).message}`);
    }
    entry.hash.update(bytes);
    entry.received += bytes.length;
    this.idle?.refresh();
    if (entry.received === entry.size && entry.hash.digest('hex') !== entry.sha256) {
      return this.abandon('bad-request', `${entry.name} does not match the sha256 it offered.`);
    }
    if (upload.packages.every((each) => each.received === each.size)) {
      this.running.state = 'installing';
      const refusal = this.launch({ from: upload.dir });
      if (refusal) return refusal;
    }
    return { result: this.progress()! };
  }

  private abandon(code: ProtocolError['code'], message: string): { error: ProtocolError } {
    const running = this.running;
    this.clear();
    if (running) this.options.audit({ by: running.by, target: running.target, phase: 'ended', ok: false, message });
    return refused(code, message);
  }

  private clear(): void {
    if (this.upload) rmSync(this.upload.dir, { recursive: true, force: true });
    this.upload = null;
    this.running = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private watchIdle(): void {
    this.idle = setTimeout(() => {
      this.abandon('bad-request', 'The package upload stopped for 10 minutes.');
    }, UPLOAD_IDLE_MS);
    this.idle.unref();
  }

  private launch(source: UpdateSource): { error: ProtocolError } | null {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const running = this.running!;
    const target = describeSource(source);
    const log = this.logFile();
    let out: number;
    try {
      mkdirSync(this.root()!, { recursive: true });
      out = openSync(log, 'w', 0o600);
    } catch (error) {
      return this.abandon('action-failed', `Could not write ${log}: ${(error as Error).message}`);
    }
    this.options.drain(`stim-server is updating to ${running.target}`);
    this.options.audit({
      by: running.by,
      target,
      phase: 'started',
      ok: true,
      message: `Started the update to ${target}.`,
    });
    const detached =
      this.options.detached ??
      serviceManagerOrNull()?.detached ??
      ((file: string, rest: string[]) => ({ file, args: rest }));
    const command = detached(this.options.node, engineSelectArgs(source, 'engine.update', 'from' in source));
    recordOutcome(this.root()!, { at: running.startedAt, target, ok: false, message: RUNNING });
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: this.options.env,
    });
    closeSync(out);
    child.unref();
    const settle = (ok: boolean, message: string) => {
      this.options.drain(null);
      this.clear();
      this.ended = { at: new Date().toISOString(), target, ok, message };
      this.options.audit({ by: running.by, target, phase: 'ended', ok, message });
    };
    child.once('error', (error) => settle(false, `Could not start the update: ${error.message}`));
    child.once('exit', (code) => {
      let output = '';
      try {
        output = readFileSync(log, 'utf8');
      } catch {}
      const ended = engineSelectOutcome(output);
      const message =
        code === 0 || ended.ok
          ? ended.message
          : `The update exited with code ${String(code)}: ${ended.message} See ${log}.`;
      recordOutcome(this.root()!, { at: new Date().toISOString(), target, ok: code === 0 && ended.ok, message });
      settle(code === 0 && ended.ok, message);
    });
    return null;
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.running?.state === 'uploading' && this.upload) rmSync(this.upload.dir, { recursive: true, force: true });
  }
}
