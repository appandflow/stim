import type { ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { privateSizeHelper } from './clonefile.ts';
import { answered, hungRead, Unanswered } from './workspace/bounded-read.ts';
import { runOperationFile } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import { getExecutor } from './exec.ts';
import { noteSizeFailure, sizeFailure } from './size-failures.ts';

/** `stim-privsize` exits 2 when the volume does not report private sizes (not APFS). */
const UNSUPPORTED_STATUS = 2;
/** Files a package manager or `pod install` rewrites on every install, so a reinstall changes the signature. */
export const INSTALL_MARKERS: readonly string[] = [
  '.modules.yaml',
  '.package-lock.json',
  '.yarn-state.yml',
  '.yarn-integrity',
  'Manifest.lock',
];

/**
 * statfs(2) `f_type` of the Linux volumes whose files share blocks only through hard links: ext2, ext3 and ext4
 * (EXT4_SUPER_MAGIC) and tmpfs (TMPFS_MAGIC). Btrfs and XFS can share blocks between files with one link each
 * (reflinks), which a link count does not show.
 */
const LINK_COUNTED_VOLUMES: ReadonlySet<number> = new Set([0xef53, 0x01021994]);
const PROBE_TIMEOUT_MS = 2000;
let probeTail: Promise<void> = Promise.resolve();

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, fail) => {
        onAbort = () => fail(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** True once `promise` settled within `timeoutMs`, false when it did not. */
async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a walk may tell what deleting the tree at `path` would free: on macOS the `stim-privsize` helper decides
 * during the walk, on Linux the volume must be link-counted. One native statfs at most is in flight per process:
 * probes queue in arrival order and each waits up to PROBE_TIMEOUT_MS for the ones before it. `busy` when that wait
 * ran out, or an earlier read that did not answer is still pending, so none was started; `timeout` when its own
 * statfs did not answer within PROBE_TIMEOUT_MS. An abort of `signal` rejects at once.
 */
export async function privateSizeKnowable(
  path: string,
  signal?: AbortSignal,
): Promise<'yes' | 'no' | 'timeout' | 'busy'> {
  if (process.platform === 'darwin') return 'yes';
  if (process.platform !== 'linux') return 'no';
  if (hungRead() !== null) return 'busy';
  signal?.throwIfAborted();
  const before = probeTail;
  let release: (() => void) | undefined;
  probeTail = new Promise<void>((done) => {
    release = done;
  });
  let held = false;
  try {
    if (!(await abortable(settledWithin(before, PROBE_TIMEOUT_MS), signal)) || hungRead() !== null) return 'busy';
    held = true;
    const read = statfs(path);
    read.then(
      () => release?.(),
      () => release?.(),
    );
    const volume = await abortable(
      answered(path, () => read, PROBE_TIMEOUT_MS),
      signal,
    );
    return LINK_COUNTED_VOLUMES.has(volume.type) ? 'yes' : 'no';
  } catch (error) {
    signal?.throwIfAborted();
    return error instanceof Unanswered ? 'timeout' : 'no';
  } finally {
    if (!held)
      void before.then(
        () => release?.(),
        () => release?.(),
      );
  }
}

export interface TreeSize {
  bytes: number;
  /** What deleting the tree would free; null when the volume or the machine cannot tell. */
  privateBytes: number | null;
  /** The walk exited with status 1: the bytes are those of what it could read, a lower bound. Absent otherwise. */
  partial?: true;
  /** Why `privateBytes` is null when the walk tried to count them: the volume cannot tell, or the counting walk failed. */
  privateUnknown?: 'volume' | 'walk';
}

function parseHelper(output: string): TreeSize | null {
  const match = /^(\d+) (\d+) \d+$/m.exec(output);
  return match ? { bytes: Number(match[1]), privateBytes: Number(match[2]) } : null;
}

/**
 * Sums `find -printf '%n %D:%i %b\\n'` lines: a file counts once per device and inode, and frees its blocks only when every one of
 * its links is in the tree, so a file hard-linked from a package store outside it frees nothing.
 */
function parseFind(output: string): TreeSize {
  const linked = new Map<string, { links: number; seen: number; bytes: number }>();
  let bytes = 0;
  let privateBytes = 0;
  for (const [, links = '', inode = '', blocks = ''] of output.matchAll(/^(\d+) (\d+:\d+) (\d+)$/gm)) {
    const size = Number(blocks) * 512;
    if (links === '1') {
      bytes += size;
      privateBytes += size;
      continue;
    }
    const entry = linked.get(inode);
    if (entry) entry.seen++;
    else {
      bytes += size;
      linked.set(inode, { links: Number(links), seen: 1, bytes: size });
    }
  }
  for (const entry of linked.values()) if (entry.seen >= entry.links) privateBytes += entry.bytes;
  return { bytes, privateBytes };
}

function parseDu(output: string): TreeSize | null {
  const sizes = [...output.matchAll(/^(\d+)\s/gm)].map((match) => Number(match[1]));
  return sizes.length ? { bytes: sizes.reduce((sum, kb) => sum + kb, 0) * 1024, privateBytes: null } : null;
}

/**
 * The size of the tree at `path` in one walk: on macOS with the Command Line Tools, `stim-privsize` gives the allocated
 * and private bytes; on a Linux volume `privateSizeKnowable` accepts, GNU `find` lists each file's links and blocks for
 * the same count; elsewhere, or when that walk fails, `du -sk` gives the allocated bytes and the private bytes stay
 * unknown. With `targets`, or `private: false`, only `du -sk` runs, over the targets' sum. Null when neither could
 * measure it, or when a walk was stopped at the timeout, which covers every walk of the call together. With an operation the walk is its declared child; without
 * one `onSpawn` sees it and it runs at low priority. Claimed background walks keep their low priority with an operation.
 */
export async function measureTree(path: string, options: TreeOptions): Promise<TreeSize | null> {
  const startedAt = Date.now();
  const errors: unknown[] = [];
  try {
    const size = await walkTree(path, options, errors);
    const ms = Date.now() - startedAt;
    const overran = ms >= options.timeoutMs;
    if (!size) noteSizeFailure(path, sizeFailure(overran ? undefined : errors.at(-1), options.timeoutMs, overran), ms);
    return size;
  } catch (error) {
    if (options.operation?.signal.aborted) noteSizeFailure(path, { reason: 'aborted' }, Date.now() - startedAt);
    throw error;
  }
}

interface TreeOptions {
  timeoutMs: number;
  onSpawn?: (child: ChildProcess) => void;
  operation?: StimContext;
  lowPriority?: true;
  targets?: string[];
  private?: false;
}

async function walkTree(path: string, options: TreeOptions, errors: unknown[]): Promise<TreeSize | null> {
  const { operation } = options;
  const exec = getExecutor();
  const lowPriority = options.lowPriority ?? !operation;
  const deadline = Date.now() + options.timeoutMs;
  const walk = (file: string, args: string[]): Promise<string> => {
    return operation
      ? runOperationFile(operation, exec, file, args, {
          lowPriority,
          timeoutMs: Math.max(1, deadline - Date.now()),
          killSignal: 'SIGKILL',
          cwd: operation.cwd,
          signal: operation.signal,
        })
      : exec.runFileAsync(file, args, {
          lowPriority,
          timeoutMs: Math.max(1, deadline - Date.now()),
          onSpawn: options.onSpawn,
        });
  };
  const failed = (error: unknown): { status: unknown; stdout: unknown } => {
    errors.push(error);
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    const status: unknown = error instanceof Error && 'status' in error ? error.status : undefined;
    const stdout: unknown = error instanceof Error && 'stdout' in error ? error.stdout : undefined;
    return { status, stdout };
  };
  const counted = !options.targets && options.private !== false;
  const helper = counted ? await privateSizeHelper(operation, options.timeoutMs) : null;
  let privateUnknown: TreeSize['privateUnknown'] = helper || process.platform === 'darwin' ? 'walk' : 'volume';
  const volume =
    !helper && counted && process.platform === 'linux' ? await privateSizeKnowable(path, operation?.signal) : 'no';
  if (Date.now() >= deadline) return null;
  if (volume === 'timeout') privateUnknown = 'walk';
  if (volume === 'busy') privateUnknown = undefined;
  if (volume === 'yes') {
    privateUnknown = 'walk';
    try {
      return parseFind(await walk('find', [path, '-type', 'f', '-printf', '%n %D:%i %b\\n']));
    } catch (error) {
      const { status, stdout } = failed(error);
      const overflowed = error instanceof Error && 'code' in error && error.code === 'ENOBUFS';
      if (!overflowed && error instanceof Error && 'signal' in error && error.signal) return null;
      // GNU find exits 1 after an entry it could not read and still prints the rest. A file whose links were not all
      // printed counts as shared, so a missed subtree can only lower the private bytes.
      if (status === 1 && typeof stdout === 'string' && stdout) return { ...parseFind(stdout), partial: true };
    }
  }
  if (helper) {
    try {
      const size = parseHelper(await walk(helper, [path]));
      if (size) return size;
    } catch (error) {
      const { status, stdout } = failed(error);
      if (error instanceof Error && 'signal' in error && error.signal) return null;
      const size = status === UNSUPPORTED_STATUS && typeof stdout === 'string' ? parseHelper(stdout) : null;
      if (size) return { bytes: size.bytes, privateBytes: null, privateUnknown: 'volume' };
    }
  }
  const unknown = counted && privateUnknown ? { privateUnknown } : {};
  if (Date.now() >= deadline) return null;
  try {
    const size = parseDu(await walk('du', ['-sk', ...(options.targets ?? [path])]));
    return size && { ...size, ...unknown };
  } catch (error) {
    const { status, stdout } = failed(error);
    const size = status === 1 && typeof stdout === 'string' ? parseDu(stdout) : null;
    return size ? { ...size, partial: true, ...unknown } : null;
  }
}

function stamp(file: string): string | null {
  try {
    const stat = lstatSync(file);
    return `${stat.ino}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * A cheap signature of a dependency tree's install: the root directory's inode and mtime, and those of the install
 * markers in it. A fresh clone, a reinstall and a deletion each change it; null when the tree is gone.
 */
export function treeSignature(path: string): string | null {
  const root = stamp(path);
  if (root === null) return null;
  return installSignature(
    root,
    INSTALL_MARKERS.map((name) => stamp(join(path, name))),
  );
}

/** The signature `treeSignature` returns, from the stamps (`inode:mtimeMs`) of the root and of each `INSTALL_MARKERS` entry, null when absent. */
export function installSignature(root: string, markers: readonly (string | null)[]): string {
  return [root, ...markers.map((marker) => marker ?? '-')].join(',');
}
