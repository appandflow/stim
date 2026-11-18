import type { ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { privateSizeHelper } from './clonefile.ts';
import { runOperationFile } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import { getExecutor } from './exec.ts';

const NICENESS = '19';
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

/**
 * Whether a walk may tell what deleting the tree at `path` would free: on macOS the `stim-privsize` helper decides
 * during the walk, on Linux the volume must be link-counted.
 */
export async function privateSizeKnowable(path: string): Promise<boolean> {
  if (process.platform === 'darwin') return true;
  if (process.platform !== 'linux') return false;
  try {
    return LINK_COUNTED_VOLUMES.has((await statfs(path)).type);
  } catch {
    return false;
  }
}

export interface TreeSize {
  bytes: number;
  /** What deleting the tree would free; null when the volume or the machine cannot tell. */
  privateBytes: number | null;
  /** `du` exited with status 1: the bytes are those of what it could read, a lower bound. Absent otherwise. */
  partial?: true;
}

function parseHelper(output: string): TreeSize | null {
  const match = /^(\d+) (\d+) \d+$/m.exec(output);
  return match ? { bytes: Number(match[1]), privateBytes: Number(match[2]) } : null;
}

/**
 * Sums `find -printf '%n %i %b\\n'` lines: a file counts once per inode, and frees its blocks only when every one of
 * its links is in the tree, so a file hard-linked from a package store outside it frees nothing.
 */
function parseFind(output: string): TreeSize {
  const linked = new Map<string, { links: number; seen: number; bytes: number }>();
  let bytes = 0;
  let privateBytes = 0;
  for (const [, links, inode, blocks] of output.matchAll(/^(\d+) (\d+) (\d+)$/gm)) {
    const size = Number(blocks) * 512;
    if (links === '1') {
      bytes += size;
      privateBytes += size;
      continue;
    }
    const entry = linked.get(inode!);
    if (entry) entry.seen++;
    else {
      bytes += size;
      linked.set(inode!, { links: Number(links), seen: 1, bytes: size });
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
 * measure it, or when the helper was stopped at the timeout. With an operation the walk is its declared child; without
 * one `onSpawn` sees it and it runs at low priority. Claimed background walks keep their low priority with an operation.
 */
export async function measureTree(
  path: string,
  options: {
    timeoutMs: number;
    onSpawn?: (child: ChildProcess) => void;
    operation?: StimContext;
    lowPriority?: true;
    targets?: string[];
    private?: false;
  },
): Promise<TreeSize | null> {
  const { operation } = options;
  const exec = getExecutor();
  const lowPriority = options.lowPriority ?? !operation;
  const walk = (file: string, args: string[]): Promise<string> => {
    const command = lowPriority ? 'nice' : file;
    const argv = lowPriority ? ['-n', NICENESS, file, ...args] : args;
    return operation
      ? runOperationFile(operation, exec, command, argv, {
          timeoutMs: options.timeoutMs,
          killSignal: 'SIGKILL',
          cwd: operation.cwd,
          signal: operation.signal,
        })
      : exec.runFileAsync(command, argv, {
          timeoutMs: options.timeoutMs,
          onSpawn: options.onSpawn,
        });
  };
  const failed = (error: unknown): { status: unknown; stdout: unknown } => {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    const status: unknown = error instanceof Error && 'status' in error ? error.status : undefined;
    const stdout: unknown = error instanceof Error && 'stdout' in error ? error.stdout : undefined;
    return { status, stdout };
  };
  const counted = !options.targets && options.private !== false;
  const helper = counted ? await privateSizeHelper(operation) : null;
  if (!helper && counted && process.platform === 'linux' && (await privateSizeKnowable(path))) {
    try {
      return parseFind(await walk('find', [path, '-type', 'f', '-printf', '%n %i %b\\n']));
    } catch (error) {
      failed(error);
      if (error instanceof Error && 'signal' in error && error.signal) return null;
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
      if (size) return { bytes: size.bytes, privateBytes: null };
    }
  }
  try {
    return parseDu(await walk('du', ['-sk', ...(options.targets ?? [path])]));
  } catch (error) {
    const { status, stdout } = failed(error);
    const size = status === 1 && typeof stdout === 'string' ? parseDu(stdout) : null;
    return size ? { ...size, partial: true } : null;
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
