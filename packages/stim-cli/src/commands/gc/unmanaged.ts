import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { configDir, isScopedHome, type StimContext } from '@stim-cli/core';
import { buildWorkerRoot, userHome } from '@stim-cli/core/state';
import { getExecutor, isTimeoutError } from '../../exec.ts';
import { formatBytes } from '../../fs-util.ts';
import { runOperationFile } from '../../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { measureDisk } from '../../daemon/measure.ts';
import { diskThresholds, shortVolumeDevices } from '../../daemon/pressure.ts';
import { readVolumeSpaceAsync, type VolumeSpace } from '../../stimd/passes/budget.ts';
import type { LevelRun } from '../../stimd/passes/level-run.ts';
import { loadConfig } from '../../workspace/config.ts';
import { answered, hungRead, Unanswered } from '../../workspace/bounded-read.ts';
import { SWIFTPM_PATTERN, TRACE_PATTERN } from './temp-leftovers.ts';

const BUDGET_MS = 15_000;
const ENTRY_TIMEOUT_MS = 5_000;
const DOCKER_TIMEOUT_MS = 5_000;
const MAX_WALKS_PER_ROOT = 100;

/** Something on a short volume that Stim does not manage, with the owning tool's cleanup command when it has one. */
interface UnmanagedEntry {
  label: string;
  bytes: number;
  command?: string;
  /** Set on a folder that holds paths Stim manages, whose reclaimable part the report already counts. */
  holdsStim?: true;
  /** Set when `du` could not read part of the folder, so `bytes` is a lower bound. */
  partial?: true;
}

export interface UnmanagedUsage {
  /** Largest first. */
  entries: UnmanagedEntry[];
  /** What could not be sized within its own time limit, likely among the largest: folders, and Docker. */
  slow: string[];
  /** Folders whose walk failed for another reason, such as a folder it cannot read. */
  failed: string[];
  /** How many entries the scan never reached, within its time budget and its cap of walks per folder. */
  unreached: number;
  /** macOS home folders left unread so no privacy prompt appears. */
  guarded: string[];
  /** A dry run that would free space: the list reflects the disk before those deletions. */
  beforeDeletions: boolean;
}

/** The swap files `/proc/swaps` lists, with their size; swap partitions are not files on a volume. */
export function parseProcSwaps(text: string): { path: string; bytes: number }[] {
  return text
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      const [field, type, kb] = line.trim().split(/\s+/);
      if (!field || type !== 'file' || !Number.isFinite(Number(kb))) return [];
      // The kernel writes a space, tab, newline or backslash in a swap file path as an octal escape (`\040`).
      const path = field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      return [{ path, bytes: Number(kb) * 1024 }];
    });
}

const DOCKER_UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

function dockerBytes(text: unknown): number {
  const match = typeof text === 'string' ? /^([\d.]+)\s*([kKMGTP]?B)/.exec(text) : null;
  return match ? Math.round(Number(match[1]) * (DOCKER_UNITS[match[2] ?? ''] ?? 0)) : 0;
}

/** The total and reclaimable bytes from `docker system df --format '{{json .}}'`, whose sizes are decimal strings. */
function parseDockerDf(output: string): { bytes: number; reclaimable: number } {
  let bytes = 0;
  let reclaimable = 0;
  for (const line of output.split('\n')) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== 'object' || row === null) continue;
    bytes += dockerBytes('Size' in row ? row.Size : null);
    reclaimable += dockerBytes('Reclaimable' in row ? row.Reclaimable : null);
  }
  return { bytes, reclaimable };
}

function rethrowCleanup(error: unknown, operation?: StimContext): void {
  if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
    throw error;
  operation?.signal.throwIfAborted();
}

function duBytes(output: unknown): number | null {
  const kb = typeof output === 'string' ? /^(\d+)\s/.exec(output)?.[1] : undefined;
  return kb === undefined ? null : Number(kb) * 1024;
}

const UNANSWERED: unique symbol = Symbol('unanswered');

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

/** One scan: every read and child process shares its deadline, and a read that does not answer in time counts as none. */
class Scan {
  readonly slow: string[] = [];
  readonly failed: string[] = [];
  readonly guarded: string[] = [];
  unreached = 0;
  readonly deadline: number;
  readonly isShort: (volume: VolumeSpace) => boolean;
  readonly operation: StimContext | undefined;

  constructor(deadline: number, isShort: (volume: VolumeSpace) => boolean, operation?: StimContext) {
    this.deadline = deadline;
    this.isShort = isShort;
    this.operation = operation;
  }

  left(): number {
    return this.deadline - Date.now();
  }

  /** `start()`'s result; null when it failed, `UNANSWERED` when it did not answer before the deadline. Rejects on cancellation. */
  async attempt<T>(label: string, start: () => Promise<T>): Promise<T | null | typeof UNANSWERED> {
    const signal = this.operation?.signal;
    signal?.throwIfAborted();
    if (this.left() <= 0) return UNANSWERED;
    return answered(label, start, this.left(), signal).catch((error: unknown) => {
      signal?.throwIfAborted();
      return error instanceof Unanswered ? UNANSWERED : null;
    });
  }

  async read<T>(label: string, start: () => Promise<T>): Promise<T | null> {
    const value = await this.attempt(label, start);
    return value === UNANSWERED ? null : value;
  }

  /** The canonical form of `path`, `path` itself when it does not exist, or null when the read did not answer in time. */
  async canonical(path: string): Promise<string | null> {
    const real = await this.attempt(path, () => realpath(path));
    return real === UNANSWERED ? null : (real ?? resolve(path));
  }

  async onShortVolume(path: string): Promise<boolean> {
    const [volume] = (await this.read(path, () => readVolumeSpaceAsync([path], this.operation?.signal))) ?? [];
    return volume !== undefined && this.isShort(volume);
  }

  /** The folder's allocated bytes on its own filesystem, through one low-priority `du`, a lower bound when `du` could not read part of it. */
  async size(path: string): Promise<{ bytes: number; partial: boolean } | null> {
    const timeoutMs = Math.min(ENTRY_TIMEOUT_MS, this.left());
    if (timeoutMs <= 0) {
      this.unreached += 1;
      return null;
    }
    try {
      const bytes = duBytes(
        await runOperationFile(this.operation, getExecutor(), 'nice', ['-n', '19', 'du', '-x', '-sk', path], {
          timeoutMs,
          killSignal: 'SIGKILL',
          signal: this.operation?.signal,
          cwd: this.operation?.cwd,
        }),
      );
      if (bytes !== null) return { bytes, partial: false };
    } catch (error) {
      rethrowCleanup(error, this.operation);
      if (isTimeoutError(error)) {
        this.slow.push(path);
        return null;
      }
      // `du` exits 1 when it cannot read part of the tree, after printing the total of what it read.
      const bytes =
        error instanceof Error && 'status' in error && error.status === 1 && 'stdout' in error
          ? duBytes(error.stdout)
          : null;
      if (bytes !== null) return { bytes, partial: true };
    }
    this.failed.push(path);
    return null;
  }
}

async function swapFiles(scan: Scan): Promise<UnmanagedEntry[]> {
  const entries: UnmanagedEntry[] = [];
  if (process.platform === 'linux') {
    for (const file of parseProcSwaps((await scan.read('/proc/swaps', () => readFile('/proc/swaps', 'utf8'))) ?? ''))
      if (await scan.onShortVolume(file.path)) entries.push({ label: `swap file ${file.path}`, bytes: file.bytes });
    return entries;
  }
  for (const dir of ['/System/Volumes/VM', '/private/var/vm']) {
    if (!(await scan.onShortVolume(dir))) continue;
    for (const name of (await scan.read(dir, () => readdir(dir))) ?? []) {
      if (!/^swapfile\d*$|^sleepimage$/.test(name)) continue;
      const size = (await scan.read(join(dir, name), () => stat(join(dir, name))))?.size;
      if (size)
        entries.push({
          label: `${name === 'sleepimage' ? 'sleep image' : 'swap file'} ${join(dir, name)}`,
          bytes: size,
        });
    }
  }
  return entries;
}

async function docker(scan: Scan): Promise<UnmanagedEntry[]> {
  const { operation } = scan;
  const exec = getExecutor();
  if (exec.findExecutable('docker', { env: operation?.env ?? process.env }) === null) return [];
  const timeoutMs = Math.min(DOCKER_TIMEOUT_MS, scan.left());
  if (timeoutMs <= 0) return [];
  let output: string;
  try {
    output = await runOperationFile(operation, exec, 'docker', ['system', 'df', '--format', '{{json .}}'], {
      timeoutMs,
      killSignal: 'SIGKILL',
      signal: operation?.signal,
      cwd: operation?.cwd,
    });
  } catch (error) {
    rethrowCleanup(error, operation);
    if (isTimeoutError(error)) scan.slow.push('Docker (docker system df)');
    return [];
  }
  const { bytes, reclaimable } = parseDockerDf(output);
  return bytes
    ? [
        {
          label: `Docker images, containers, volumes and build cache, possibly on another volume${reclaimable ? `, ${formatBytes(reclaimable)} reclaimable` : ''}`,
          bytes,
          command: 'docker system prune',
        },
      ]
    : [];
}

interface RootListing {
  files: UnmanagedEntry[];
  folders: { path: string; holdsStim: boolean }[];
}

// @ref LLP 0004#tool-folders-and-the-full-scan -- these home folders are never read
/** Home folders macOS guards with a privacy prompt for the reading app, compared case-insensitively. */
const MACOS_PROTECTED = new Set(['desktop', 'documents', 'downloads', 'library', 'movies', 'music', 'pictures']);

/**
 * The files of `root` with their size, and its folders still to walk; empty when `root` is not on a short volume. Stim's
 * temp leftovers are skipped only in the temp folder, and macOS's protected home folders are named, never read.
 */
async function listRoot(
  scan: Scan,
  root: string,
  managed: readonly string[],
  kind: 'temp' | 'home',
): Promise<RootListing> {
  const listing: RootListing = { files: [], folders: [] };
  const info = await scan.read(root, () => stat(root));
  if (!info?.isDirectory() || !(await scan.onShortVolume(root))) return listing;
  const names = (await scan.read(root, () => readdir(root)))?.toSorted() ?? [];
  for (const [index, name] of names.entries()) {
    if (scan.left() <= 0 || hungRead() !== null) {
      scan.unreached += names.length - index;
      break;
    }
    const path = join(root, name);
    if (
      kind === 'temp' &&
      (/^(?:stim-|\.stim-delete-)/.test(name) || TRACE_PATTERN.test(name) || SWIFTPM_PATTERN.test(name))
    )
      continue;
    if (kind === 'home' && process.platform === 'darwin' && MACOS_PROTECTED.has(name.toLowerCase())) {
      scan.guarded.push(path);
      continue;
    }
    if (managed.some((dir) => inside(path, dir))) continue;
    const entry = await scan.read(path, () => lstat(path));
    if (!entry || entry.isSymbolicLink() || entry.dev !== info.dev) continue;
    if (entry.isDirectory()) listing.folders.push({ path, holdsStim: managed.some((dir) => inside(dir, path)) });
    else if (entry.blocks) listing.files.push({ label: path, bytes: entry.blocks * 512 });
  }
  return listing;
}

/**
 * The largest users of a short volume that Stim does not manage, for the plain `stim gc` report. It runs only when the
 * measured disk level is high or critical and a volume is under `disk.minFreeGb`: after an acting run the disk is
 * measured again, a dry run reads it as it is, before its deletions. Never on Windows or from
 * a home STIM_HOME scopes, since what it reads is machine-wide. It reads swap files on a short volume, asks
 * `docker system df` when Docker is installed, and sizes the entries of the temporary directory and the home directory
 * on a short volume, taking the two in turn, one low-priority `du` at a time that stays on one filesystem. Every read
 * and walk shares one time budget; when the paths Stim manages cannot be resolved in time, the two folders are not
 * listed. It deletes nothing.
 */
export async function unmanagedUsage(
  run: LevelRun,
  act: boolean,
  operation?: StimContext,
): Promise<UnmanagedUsage | null> {
  const env = operation?.env ?? process.env;
  if (process.platform === 'win32' || isScopedHome(env)) return null;
  if (run.pressure.disk !== 'high' && run.pressure.disk !== 'critical') return null;
  const config = loadConfig();
  const { thresholds } = diskThresholds(config, env);
  let short = new Set<number>();
  const measured = new Set<number>();
  const scan = new Scan(
    Date.now() + BUDGET_MS,
    (volume) =>
      volume.device !== undefined && measured.has(volume.device)
        ? short.has(volume.device)
        : shortVolumeDevices([volume], thresholds, 'high').size > 0,
    operation,
  );
  const disk = await scan.read('disk', () => measureDisk(config, operation?.signal));
  if (!disk) return null;
  for (const volume of disk) if (volume.device !== undefined) measured.add(volume.device);
  short = shortVolumeDevices(disk, thresholds, 'high');
  if (!short.size) return null;
  const entries = [...(await swapFiles(scan)), ...(await docker(scan))];
  const resolved = async (paths: readonly string[]): Promise<string[] | null> => {
    const out: string[] = [];
    for (const path of paths) {
      const real = await scan.canonical(path);
      if (real === null) return null;
      out.push(real);
    }
    return out;
  };
  const roots = await resolved([tmpdir(), userHome(env)]);
  const managed = roots
    ? await resolved([
        configDir(),
        buildWorkerRoot(config),
        ...Object.keys(config?.projects ?? {}),
        ...run.usage.map((entry) => entry.dir),
        ...run.cachePaths,
      ])
    : null;
  const listings: RootListing[] = [];
  if (roots && managed) {
    const own = managed.filter((path) => !roots.some((root) => inside(root, path)));
    const [temp, home] = roots;
    if (temp) listings.push(await listRoot(scan, temp, own, 'temp'));
    if (home && home !== temp) listings.push(await listRoot(scan, home, own, 'home'));
  }
  for (const listing of listings) entries.push(...listing.files);
  const queue = Array.from({ length: MAX_WALKS_PER_ROOT }, (_, index) =>
    listings.flatMap((listing) => listing.folders[index] ?? []),
  ).flat();
  for (const folder of queue) {
    const size = await scan.size(folder.path);
    if (size?.bytes)
      entries.push({
        label: folder.path,
        bytes: size.bytes,
        ...(folder.holdsStim ? { holdsStim: true } : {}),
        ...(size.partial ? { partial: true } : {}),
      });
  }
  for (const listing of listings) scan.unreached += Math.max(0, listing.folders.length - MAX_WALKS_PER_ROOT);
  return {
    entries: entries.toSorted((a, b) => b.bytes - a.bytes),
    slow: scan.slow,
    failed: scan.failed,
    unreached: scan.unreached,
    guarded: scan.guarded,
    beforeDeletions: !act && run.actions.some((action) => action.outcome === 'would' && action.bytes > 0),
  };
}
