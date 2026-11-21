import { lstatSync, readdirSync, readlinkSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { dirname, isAbsolute, join, normalize, parse, sep } from 'path';
import { getExecutor, isTimeoutError } from './exec.ts';
import { runLowPriority } from './io-priority.ts';
import { noteSizeFailure, sizeFailure } from './size-failures.ts';
import type { StimContext } from '@stim-cli/core';
import { runOperationFile } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';

const WINDOWS = process.platform === 'win32';
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function volumeRootFor(path: string): string {
  const normalized = normalize(String(path));
  if (WINDOWS) return parse(normalized).root.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const m = normalized.match(/^\/volumes\/([^/]+)/i);
  return m ? `/Volumes/${m[1]}` : '/';
}

function resolveWorkspaceRealish(workspacePath: string): string | null {
  const raw = String(workspacePath);
  if (!isAbsolute(raw)) return null;
  let current = raw;
  const MAX_HOPS = 40;
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    const normalized = normalize(current);
    const root = parse(normalized).root;
    const segments = normalized.slice(root.length).split(sep).filter(Boolean);
    let prefix = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
    let followedSymlink = false;
    for (const segment of segments) {
      prefix += `${sep}${segment}`;
      let st;
      try {
        st = lstatSync(prefix);
      } catch (err) {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return normalized;
        }
        return null;
      }
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(prefix);
        } catch {
          return null;
        }
        const resolvedTarget = isAbsolute(target) ? target : normalize(join(dirname(prefix), target));
        const rest = normalized.slice(prefix.length);
        current = `${resolvedTarget}${rest}`;
        followedSymlink = true;
        break;
      }
    }
    if (!followedSymlink) {
      return normalized;
    }
  }
  return null;
}

export function isRealMount(entryDev: number | null | undefined, rootDev: number | null | undefined): boolean {
  return entryDev != null && rootDev != null && entryDev !== rootDev;
}

function listWindowsVolumeRoots(statFn: typeof statSync): string[] {
  const roots: string[] = [];
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:${sep}`;
    try {
      statFn(root);
    } catch {
      continue;
    }
    roots.push(root);
  }
  return roots;
}

export function listMountedVolumes({ statFn = statSync }: { statFn?: typeof statSync } = {}): string[] {
  if (WINDOWS) return listWindowsVolumeRoots(statFn);
  const roots = ['/'];
  let rootDev: number;
  try {
    rootDev = statFn('/').dev;
  } catch {
    return roots;
  }
  try {
    for (const name of readdirSync('/Volumes')) {
      const path = join('/Volumes', name);
      let entryDev;
      try {
        entryDev = statFn(path).dev;
      } catch {
        continue;
      }
      if (isRealMount(entryDev, rootDev)) {
        roots.push(path);
      }
    }
  } catch {}
  return roots;
}

function resolveVolumeRoot(path: string): string | null {
  const realish = resolveWorkspaceRealish(path);
  return realish === null ? null : volumeRootFor(realish);
}

function uncShareIsReachable(volume: string, statFn: typeof statSync): boolean {
  if (!WINDOWS || !volume.startsWith(`${sep}${sep}`)) return false;
  try {
    return statFn(volume).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `stat` proves `path` absent: ENOENT or ENOTDIR. Any other failure, such as EACCES, proves nothing. */
export function isAbsentPath(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

export function isOnMountedVolume(
  path: string,
  mountedVolumes?: string[],
  { statFn = statSync }: { statFn?: typeof statSync } = {},
): boolean {
  const mounted = new Set(mountedVolumes || listMountedVolumes());
  const volume = resolveVolumeRoot(path);
  if (volume === null) return false;
  return mounted.has(volume) || uncShareIsReachable(volume, statFn);
}

export function directorySize(dir: string, options: { timeoutMs: number | 'unbounded'; root?: string }): number {
  return measuredDirectorySize(dir, options) ?? 0;
}

export async function directorySizeAsync(
  dir: string,
  options: { timeoutMs: number | 'unbounded'; signal?: AbortSignal; operation?: StimContext },
): Promise<number> {
  return (await measuredDirectorySizeAsync(dir, options)) ?? 0;
}

interface SizeWalkOptions {
  timeoutMs: number | 'unbounded';
  signal?: AbortSignal;
  operation?: StimContext;
  lowPriority?: boolean;
  /** With `lowPriority`, whether the walk also yields its I/O: only for a volume sampled at normal pressure. */
  throttleIo?: boolean;
  root?: string;
}

/** A folder's size; `partial` marks a walk stopped at its deadline, whose `bytes` count only what it finished. */
export interface DirectorySize {
  bytes: number;
  partial?: true;
}

export async function measuredDirectorySizeAsync(dir: string, options: SizeWalkOptions): Promise<number | null> {
  const size = await walkSize(dir, ['-sk', dir], options);
  return size && !size.partial ? size.bytes : null;
}

const PER_ENTRY_LIMIT = 100;

/**
 * The size of `dir`, or null when the walk failed. A walk that times out returns the bytes of the top-level entries it
 * finished, marked `partial`.
 */
export async function measureDirectoryAsync(dir: string, options: SizeWalkOptions): Promise<DirectorySize | null> {
  const names = await readdir(dir).catch(() => null);
  if (names === null || names.length > PER_ENTRY_LIMIT) return walkSize(dir, ['-k', '-d', '1', dir], options);
  return walkEntries(dir, names.toSorted(), options);
}

// @ref LLP 0001#a-size-walk-that-times-out-reports-what-it-measured -- one du per entry below the limit; a hard link two entries share counts twice
/**
 * One `du -sk` per top-level entry under one deadline: macOS du holds up to 4 KB of output in a buffer when it writes
 * to a pipe, so a single `du -k -d 1` stopped early leaves nothing for a folder with few entries.
 */
async function walkEntries(dir: string, names: string[], options: SizeWalkOptions): Promise<DirectorySize | null> {
  const deadline = options.timeoutMs === 'unbounded' ? null : Date.now() + options.timeoutMs;
  const total: DirectorySize = { bytes: 0 };
  for (const name of names) {
    const left = deadline === null ? 'unbounded' : Math.ceil(deadline - Date.now());
    if (left !== 'unbounded' && left <= 0) return { ...total, partial: true };
    const size = await walkSize(dir, ['-sk', join(dir, name)], { ...options, timeoutMs: left });
    if (size === null) return null;
    addSize(total, size);
    if (size.partial) return total;
  }
  return total;
}

/** Adds `size` to `total`, which becomes partial when `size` is. */
export function addSize(total: DirectorySize, size: DirectorySize | null | undefined): void {
  total.bytes += size?.bytes ?? 0;
  if (size?.partial) total.partial = true;
}

/** `bytes` with "at least" in front when they are a lower bound. */
export function formatSize({ bytes, partial }: DirectorySize): string {
  return `${partial ? 'at least ' : ''}${formatBytes(bytes)}`;
}

async function walkSize(
  dir: string,
  args: string[],
  { timeoutMs, signal, operation, lowPriority = false, throttleIo = false, root }: SizeWalkOptions,
): Promise<DirectorySize | null> {
  let out: string;
  const startedAt = Date.now();
  try {
    const walk = (file: string, argv: string[]) =>
      runOperationFile(operation, getExecutor(), file, argv, {
        timeoutMs,
        killSignal: 'SIGKILL',
        signal,
        cwd: operation?.cwd,
      });
    out = lowPriority ? await runLowPriority(walk, 'du', args, throttleIo) : await walk('du', args);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    noteSizeFailure(
      dir,
      signal?.aborted || operation?.signal.aborted ? { reason: 'aborted' } : sizeFailure(error, timeoutMs, false),
      Date.now() - startedAt,
      root,
    );
    signal?.throwIfAborted();
    operation?.signal.throwIfAborted();
    if (!isTimeoutError(error)) return null;
    const stdout = error instanceof Error && 'stdout' in error ? error.stdout : '';
    return { bytes: finishedBytes(dir, typeof stdout === 'string' ? stdout : ''), partial: true };
  }
  if (!out) return { bytes: 0 };
  const kb = parseInt(out.trim().split('\n').at(-1)?.split(/\s+/)[0] ?? '', 10);
  return { bytes: isNaN(kb) ? 0 : kb * 1024 };
}

/**
 * The bytes in the complete lines `du -k -d 1` printed before it was stopped: the total when it got that far, else the
 * sum of the top-level entries it finished. GNU du writes each line as it finishes an entry; macOS du writes them in
 * 4 KB blocks when it writes to a pipe, so a stopped walk there printed only whole blocks.
 */
function finishedBytes(dir: string, stdout: string): number {
  let total = 0;
  for (const line of stdout.split('\n').slice(0, -1)) {
    const match = /^(\d+)\t(.*)$/.exec(line);
    if (!match) continue;
    if (match[2] === dir) return Number(match[1]) * 1024;
    total += Number(match[1]) * 1024;
  }
  return total;
}

function measuredDirectorySize(
  dir: string,
  { timeoutMs, root }: { timeoutMs: number | 'unbounded'; root?: string },
): number | null {
  let out: string;
  const startedAt = Date.now();
  try {
    out = getExecutor().runFile('du', ['-sk', dir], { timeoutMs });
  } catch (error) {
    noteSizeFailure(dir, sizeFailure(error, timeoutMs, false), Date.now() - startedAt, root);
    return null;
  }
  if (!out) return 0;
  const kb = parseInt(out.split(/\s+/)[0] ?? '', 10);
  return isNaN(kb) ? 0 : kb * 1024;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}
