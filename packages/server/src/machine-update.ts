import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { isJsonObject, readBuildMachines, readDeviceHostMachines, type Endpoint } from '@stim-cli/core/state';
import { Upstream } from './hosted-relay.ts';
import { dialEndpoint } from './tailnet-helper.ts';
import type { MachineUpdateStatus, ProtocolError, EngineUpdateProgress } from './protocol.ts';

const CHUNK_BYTES = 24 * 1024;
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Answer<T> = { result: T } | { error: ProtocolError };

interface Manifest {
  name: string;
  version: string;
  files?: string[];
  [field: string]: unknown;
}

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

function publishedRange(range: string, version: string): string {
  const spec = range.slice('workspace:'.length);
  if (spec === '*') return version;
  if (spec === '^' || spec === '~') return `${spec}${version}`;
  return spec;
}

function installedDir(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The packages of the Stim checkout `stimDir` runs from: it and every package it reaches through `workspace:`
 * ranges, by name. Null when `stimDir` is an installed package, which a release update matches instead.
 */
export function workspacePackages(stimDir: string): Map<string, string> | null {
  if (stimDir.split(sep).includes('node_modules')) return null;
  let checkout = false;
  for (let dir = stimDir, depth = 0; !checkout && depth < 4 && dirname(dir) !== dir; dir = dirname(dir), depth++) {
    checkout = existsSync(join(dir, 'pnpm-workspace.yaml'));
  }
  if (!checkout) return null;
  const found = new Map<string, string>();
  const visit = (dir: string) => {
    const manifest = readManifest(dir);
    if (found.has(manifest.name)) return;
    found.set(manifest.name, dir);
    for (const field of DEPENDENCY_FIELDS) {
      const ranges = isJsonObject(manifest[field]) ? manifest[field] : {};
      for (const [name, range] of Object.entries(ranges)) {
        if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
        const dependency = installedDir(dir, name);
        if (!dependency)
          throw new Error(`${manifest.name} depends on ${name}, which is not installed in the checkout.`);
        visit(dependency);
      }
    }
  };
  visit(stimDir);
  return found;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, killSignal: 'SIGKILL', env }, (error, _stdout, stderr) =>
      error ? reject(new Error(`${file} failed: ${stderr.trim() || error.message}`)) : resolve(),
    );
  });
}

/**
 * Packs each package as `npm pack` lays it out: its `files`, README and LICENSE under `package/`, with every
 * `workspace:` range rewritten to the published range and without dev dependencies or scripts.
 */
export async function packWorkspace(
  packages: Map<string, string>,
): Promise<{ name: string; bytes: Buffer; sha256: string }[]> {
  const versions = new Map([...packages].map(([name, dir]) => [name, readManifest(dir).version]));
  const out = mkdtempSync(join(tmpdir(), 'stim-engine-pack-'));
  try {
    const packed = [];
    for (const [name, dir] of packages) {
      const manifest = readManifest(dir);
      const stage = join(out, name.replace('@', '').replace('/', '-'));
      const contents = join(stage, 'package');
      mkdirSync(contents, { recursive: true });
      const entries = new Set([
        ...(manifest.files ?? []),
        ...readdirSync(dir).filter((entry) => /^(readme|license|licence)/i.test(entry)),
      ]);
      for (const entry of entries) {
        if (existsSync(join(dir, entry))) cpSync(join(dir, entry), join(contents, entry), { recursive: true });
      }
      for (const field of DEPENDENCY_FIELDS) {
        const ranges = manifest[field];
        if (!isJsonObject(ranges)) continue;
        for (const [dependency, range] of Object.entries(ranges)) {
          if (typeof range === 'string' && range.startsWith('workspace:')) {
            ranges[dependency] = publishedRange(range, versions.get(dependency) ?? '*');
          }
        }
      }
      delete manifest.devDependencies;
      delete manifest.scripts;
      writeFileSync(join(contents, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const file = `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
      // macOS tar writes AppleDouble entries for extended attributes unless COPYFILE_DISABLE is set.
      await run(
        process.platform === 'win32'
          ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
          : '/usr/bin/tar',
        ['-czf', join(out, file), '-C', stage, 'package'],
        { ...process.env, COPYFILE_DISABLE: '1' },
      );
      const bytes = readFileSync(join(out, file));
      packed.push({ name: file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return packed;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export interface MachineUpdateOptions {
  version: string;
  /** The `stim` package directory this server runs from. */
  stimDir: string;
  status: () => unknown | Promise<unknown>;
  endpoint?: (found: Endpoint) => Endpoint;
}

interface Upload {
  sent: number;
  total: number;
  error: string | null;
  active: boolean;
}

// compat C12 permanent
const manualUpdate = (machine: string, version: string) =>
  `Update Stim on ${machine}: npm i -g stim@${version} && stim service install. If its engine is pinned, run stim engine update there. Update Stim Desktop too (Stim > Check for Updates).`;
// compat end

const failed = (code: ProtocolError['code'], message: string): { error: ProtocolError } => ({
  error: { code, message },
});

/**
 * Asks an approved remote machine or device host to update its Stim package to what this machine runs: the same npm
 * release, or this checkout's own packed build. It connects with the credential `stim doctor --fix` stored for that
 * machine, and goes ahead only with the stim-server that proves it holds the key pinned at approval.
 */
export class MachineUpdates {
  private readonly options: MachineUpdateOptions;
  private readonly uploads = new Map<string, Upload>();

  constructor(options: MachineUpdateOptions) {
    this.options = options;
  }

  private async connect(machine: string): Promise<Upstream> {
    const build = readBuildMachines().find((entry) => entry.machine === machine && entry.state === 'approved');
    const host = build
      ? null
      : readDeviceHostMachines().find((entry) => entry.machine === machine && entry.state === 'approved');
    const credential = build ?? host;
    if (!credential?.serverKey)
      throw new Error(`${machine} has not approved this machine for builds or device hosting.`);
    const found = await dialEndpoint(credential.machine, this.options.status);
    if (typeof found === 'string') throw new Error(found);
    const upstream = new Upstream(this.options.endpoint?.(found) ?? found, credential.serverKey);
    try {
      await upstream.open(this.options.version, build ? 'build' : 'device-host');
    } catch (error) {
      upstream.close();
      throw error;
    }
    return upstream;
  }

  async start(machine: string): Promise<Answer<EngineUpdateProgress>> {
    if (this.uploads.get(machine)?.active) return failed('action-busy', `This machine is already updating ${machine}.`);
    const upload: Upload = { sent: 0, total: 0, error: null, active: true };
    this.uploads.set(machine, upload);
    let upstream: Upstream | null = null;
    let uploading = false;
    try {
      upstream = await this.connect(machine);
      // compat C12 permanent
      if (this.options.stimDir.split(sep).includes('node_modules')) {
        const reply = await upstream.request('engine.update', { version: this.options.version });
        return 'error' in reply ? this.refusal(machine, reply) : { result: reply.result as EngineUpdateProgress };
      }
      // compat end
      const workspace = workspacePackages(this.options.stimDir) ?? new Map([['stim', this.options.stimDir]]);
      const packages = await packWorkspace(workspace);
      const reply = await upstream.request('engine.update', {
        packages: packages.map(({ name, bytes, sha256 }) => ({ name, size: bytes.length, sha256 })),
      });
      if ('error' in reply) return this.refusal(machine, reply);
      const progress = reply.result as EngineUpdateProgress;
      upload.total = packages.reduce((sum, each) => sum + each.bytes.length, 0);
      uploading = true;
      const connection = upstream;
      void this.send(connection, progress.id, packages, upload).finally(() => connection.close());
      return { result: progress };
    } catch (error) {
      // compat C12 permanent
      return failed('action-failed', `${(error as Error).message} ${manualUpdate(machine, this.options.version)}`);
      // compat end
    } finally {
      if (!uploading) {
        upload.active = false;
        this.uploads.delete(machine);
        upstream?.close();
      }
    }
  }

  // compat C12 permanent
  private refusal(machine: string, reply: { error: ProtocolError }): { error: ProtocolError } {
    return reply.error.code === 'unknown-method' || reply.error.code === 'protocol-unsupported'
      ? failed(reply.error.code, manualUpdate(machine, this.options.version))
      : reply;
  }
  // compat end

  private async send(
    upstream: Upstream,
    id: string,
    packages: { name: string; bytes: Buffer }[],
    upload: Upload,
  ): Promise<void> {
    try {
      for (const { name, bytes } of packages) {
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const data = bytes.subarray(offset, offset + CHUNK_BYTES);
          const reply = await upstream.request('engine.update.chunk', {
            id,
            name,
            offset,
            data: data.toString('base64'),
          });
          if ('error' in reply) throw new Error(reply.error.message);
          upload.sent += data.length;
        }
      }
    } catch (error) {
      upload.error = (error as Error).message;
    } finally {
      upload.active = false;
    }
  }

  async status(machine: string): Promise<Answer<MachineUpdateStatus>> {
    const upload = this.uploads.get(machine);
    const local = upload ? { sent: upload.sent, total: upload.total, error: upload.error } : null;
    let upstream: Upstream;
    try {
      upstream = await this.connect(machine);
    } catch (error) {
      return { result: { remote: null, unreachable: (error as Error).message, upload: local } };
    }
    try {
      const reply = await upstream.request('engine.update.status', {});
      if ('error' in reply)
        return { result: { remote: null, unreachable: this.refusal(machine, reply).error.message, upload: local } };
      return { result: { remote: reply.result as MachineUpdateStatus['remote'], unreachable: null, upload: local } };
    } catch (error) {
      return { result: { remote: null, unreachable: (error as Error).message, upload: local } };
    } finally {
      upstream.close();
    }
  }
}
