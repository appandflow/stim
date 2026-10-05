import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { ProtocolError, ServerUpdatePackage, ServerUpdateProgress, ServerUpdateStatus } from './protocol.ts';
import { validateRelease, type ServerBuild } from './service-plist.ts';
import { describeSource, readLastUpdate, runsAsService, serviceRoot, type UpdateSource } from './service.ts';

const UPDATE_CHUNK_CHARS = 32 * 1024;
const MAX_PACKAGES = 8;
const MAX_PACKAGE_BYTES = 64 * 1024 ** 2;
const MAX_UPLOAD_BYTES = 128 * 1024 ** 2;
const UPLOAD_IDLE_MS = 10 * 60_000;
const STALE_INCOMING_MS = 60 * 60_000;
const LOG_LINES = 20;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tgz$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Answer = { result: ServerUpdateProgress } | { error: ProtocolError };

export interface ServerUpdateOptions {
  label: string | null;
  port: number;
  build: ServerBuild;
  node: string;
  script: string;
  env: NodeJS.ProcessEnv;
  acceptsClientBuilds: () => boolean;
  drain: (reason: string | null) => void;
  audit: (record: {
    by: ServerUpdateProgress['by'];
    target: string;
    phase: 'started' | 'ended';
    ok: boolean;
    message: string;
  }) => void;
  runsAsService?: (label: string, port: number) => Promise<boolean>;
}

interface Upload {
  packages: (ServerUpdatePackage & { received: number; hash: ReturnType<typeof createHash> })[];
  dir: string;
  touched: number;
}

const refused = (code: ProtocolError['code'], message: string): { error: ProtocolError } => ({
  error: { code, message },
});

/** Parses `server.update.start` params, or says why they are refused. */
export function parseUpdateStart(params: unknown): { release: string } | { packages: ServerUpdatePackage[] } | string {
  if (!isJsonObject(params)) return 'server.update.start takes release or packages.';
  if ('release' in params === 'packages' in params)
    return 'server.update.start takes exactly one of release or packages.';
  if (typeof params.release === 'string') return validateRelease(params.release) ?? { release: params.release };
  if (!Array.isArray(params.packages) || params.packages.length === 0 || params.packages.length > MAX_PACKAGES) {
    return `packages lists 1 to ${MAX_PACKAGES} .tgz files.`;
  }
  const packages: ServerUpdatePackage[] = [];
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
 * Runs `stim-server service update` for a client this Mac approved for builds or device hosting. The update runs
 * as a detached process with this server's own node and script, so it survives the restart it causes; its output
 * goes to a log file rather than a pipe, which would break when this server exits.
 */
export class ServerUpdates {
  private readonly options: ServerUpdateOptions;
  private running: ServerUpdateProgress | null = null;
  private upload: Upload | null = null;
  private idle: NodeJS.Timeout | null = null;

  constructor(options: ServerUpdateOptions) {
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
    const finished = Date.parse(readLastUpdate(this.options.label!)?.at ?? '') || 0;
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

  private progress(): ServerUpdateProgress | null {
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

  async status(): Promise<ServerUpdateStatus> {
    const label = this.options.label;
    const service = label && (await (this.options.runsAsService ?? runsAsService)(label, this.options.port));
    return {
      server: this.options.build,
      service: service ? label : null,
      acceptsClientBuilds: this.options.acceptsClientBuilds(),
      running: this.progress(),
      last: service && label ? readLastUpdate(label) : null,
    };
  }

  async start(by: ServerUpdateProgress['by'], params: unknown): Promise<Answer> {
    const parsed = parseUpdateStart(params);
    if (typeof parsed === 'string') return refused('bad-request', parsed);
    const label = this.options.label;
    if (!label || !(await (this.options.runsAsService ?? runsAsService)(label, this.options.port))) {
      return refused(
        'forbidden',
        'This stim-server does not run as a `stim-server service` LaunchAgent, so it cannot update itself. Update it where it runs.',
      );
    }
    if ('packages' in parsed && !this.options.acceptsClientBuilds()) {
      return refused(
        'forbidden',
        'This Mac installs only stim-server releases from npm. To take this build, run `stim settings set server.acceptClientBuilds true` on it.',
      );
    }
    if (this.running)
      return refused('action-busy', `An update of this server is already running (${this.running.target}).`);
    const id = randomUUID();
    const base = { id, by, startedAt: new Date().toISOString() };
    if ('release' in parsed) {
      this.running = { ...base, target: `release ${parsed.release}`, state: 'installing', missing: [], log: [] };
      return this.launch(parsed) ?? { result: this.progress()! };
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
      touched: Date.now(),
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
      return refused('bad-request', 'No package upload from this Mac is running; call server.update.start first.');
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
        `server.update.chunk takes id, name, offset and at most ${UPDATE_CHUNK_CHARS} characters of base64 data.`,
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
    upload.touched = Date.now();
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
    if (this.idle) clearInterval(this.idle);
    this.idle = null;
  }

  private watchIdle(): void {
    this.idle = setInterval(() => {
      if (this.upload && this.running?.state === 'uploading' && Date.now() - this.upload.touched > UPLOAD_IDLE_MS) {
        this.abandon('bad-request', 'The package upload stopped for 10 minutes.');
      }
    }, 30_000);
    this.idle.unref();
  }

  private launch(source: UpdateSource): { error: ProtocolError } | null {
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
    const args = [this.options.script, 'service', 'update', '--label', this.options.label!];
    const child = spawn(
      this.options.node,
      'release' in source ? [...args, '--release', source.release] : [...args, '--from', source.from],
      { detached: true, stdio: ['ignore', out, out], env: this.options.env },
    );
    closeSync(out);
    child.unref();
    const settle = (ok: boolean, message: string) => {
      this.options.drain(null);
      this.clear();
      this.options.audit({ by: running.by, target, phase: 'ended', ok, message });
    };
    child.once('error', (error) => settle(false, `Could not start the update: ${error.message}`));
    child.once('exit', (code) => {
      const last = readLastUpdate(this.options.label!);
      const fresh = last && Date.parse(last.at) >= Date.parse(running.startedAt);
      settle(code === 0, fresh ? last.message : `The update exited with code ${String(code)}; see ${log}.`);
    });
    return null;
  }

  close(): void {
    if (this.idle) clearInterval(this.idle);
    if (this.running?.state === 'uploading' && this.upload) rmSync(this.upload.dir, { recursive: true, force: true });
  }
}
