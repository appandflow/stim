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
import {
  isJsonObject,
  pinnedEndpoint,
  readBuildMachines,
  readDeviceHostMachines,
  type Endpoint,
} from '@stim-cli/core/state';
import { Upstream } from './hosted-relay.ts';
import type { MachineUpdateStatus, ProtocolError, ServerUpdateProgress } from './protocol.ts';

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

/** The range pnpm publishes for a `workspace:` range of a package at `version`. */
export function publishedRange(range: string, version: string): string {
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
 * The packages of the Stim checkout `serverDir` runs from: it and every package it reaches through `workspace:`
 * ranges, by name. Null when `serverDir` is an installed package, which a release update matches instead.
 */
export function workspacePackages(serverDir: string): Map<string, string> | null {
  if (serverDir.split(sep).includes('node_modules')) return null;
  let checkout = false;
  for (let dir = serverDir, depth = 0; !checkout && depth < 4 && dirname(dir) !== dir; dir = dirname(dir), depth++) {
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
  visit(serverDir);
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
  const out = mkdtempSync(join(tmpdir(), 'stim-server-pack-'));
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
      // macOS tar adds an AppleDouble `._<name>` entry for each file with extended attributes unless
      // COPYFILE_DISABLE is set; npm would install those as extra `.mjs` files and change the Stim build digest.
      await run('/usr/bin/tar', ['-czf', join(out, file), '-C', stage, 'package'], {
        ...process.env,
        COPYFILE_DISABLE: '1',
      });
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
  /** The `@stim-cli/server` package directory this server runs from. */
  serverDir: string;
  status: () => unknown | Promise<unknown>;
  endpoint?: (pinned: Endpoint) => Endpoint;
}

interface Upload {
  sent: number;
  total: number;
  error: string | null;
  active: boolean;
}

const failed = (code: ProtocolError['code'], message: string): { error: ProtocolError } => ({
  error: { code, message },
});

/**
 * Asks an approved build machine or device host to update its stim-server to what this Mac runs: the same npm
 * release, or this checkout's own packed build. It connects with the credential `stim doctor --fix` stored for that
 * machine and sends the token only to the node it pinned.
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
    if (!credential) throw new Error(`${machine} has not approved this Mac for builds or device hosting.`);
    const pinned = pinnedEndpoint(credential, await this.options.status());
    if (typeof pinned === 'string') throw new Error(pinned);
    const upstream = new Upstream(this.options.endpoint?.(pinned) ?? pinned, credential.deviceToken);
    try {
      await upstream.open(this.options.version, build ? 'build' : 'device-host');
    } catch (error) {
      upstream.close();
      throw error;
    }
    if (!upstream.supports('server-update')) {
      upstream.close();
      throw new Error(
        `stim-server on ${machine} cannot be updated from here yet. Update it once there with \`stim-server service update\`.`,
      );
    }
    return upstream;
  }

  async start(machine: string): Promise<Answer<ServerUpdateProgress>> {
    if (this.uploads.get(machine)?.active)
      return failed('action-busy', `This Mac is still sending its build to ${machine}.`);
    let upstream: Upstream;
    try {
      upstream = await this.connect(machine);
    } catch (error) {
      return failed('action-failed', (error as Error).message);
    }
    let uploading = false;
    try {
      const workspace = workspacePackages(this.options.serverDir);
      if (!workspace) {
        const reply = await upstream.request('server.update.start', { release: this.options.version });
        return 'error' in reply ? reply : { result: reply.result as ServerUpdateProgress };
      }
      const packages = await packWorkspace(workspace);
      const reply = await upstream.request('server.update.start', {
        packages: packages.map(({ name, bytes, sha256 }) => ({ name, size: bytes.length, sha256 })),
      });
      if ('error' in reply) return reply;
      const progress = reply.result as ServerUpdateProgress;
      const upload: Upload = {
        sent: 0,
        total: packages.reduce((sum, each) => sum + each.bytes.length, 0),
        error: null,
        active: true,
      };
      this.uploads.set(machine, upload);
      uploading = true;
      void this.send(upstream, progress.id, packages, upload).finally(() => upstream.close());
      return { result: progress };
    } catch (error) {
      return failed('action-failed', (error as Error).message);
    } finally {
      if (!uploading) upstream.close();
    }
  }

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
          const reply = await upstream.request('server.update.chunk', {
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
      const reply = await upstream.request('server.update.status', {});
      if ('error' in reply) return { result: { remote: null, unreachable: reply.error.message, upload: local } };
      return { result: { remote: reply.result as MachineUpdateStatus['remote'], unreachable: null, upload: local } };
    } catch (error) {
      return { result: { remote: null, unreachable: (error as Error).message, upload: local } };
    } finally {
      upstream.close();
    }
  }
}
