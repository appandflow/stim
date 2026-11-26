import type { ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { binaryPath, type RealSizeResult } from 'real-size';
import { runOperationFile } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import { getExecutor } from './exec.ts';
import { lowPriorityCommand } from './io-priority.ts';
import { noteSizeFailure, sizeFailure } from './size-failures.ts';

/** `real-size` exits 2 when the filesystem cannot report private sizes. */
const UNSUPPORTED_STATUS = 2;
/** Files a package manager or `pod install` rewrites on every install, so a reinstall changes the signature. */
export const INSTALL_MARKERS: readonly string[] = [
  '.modules.yaml',
  '.package-lock.json',
  '.yarn-state.yml',
  '.yarn-integrity',
  'Manifest.lock',
];

export interface TreeSize {
  bytes: number;
  /** What deleting the tree would free, measured by real-size; null when unavailable. */
  privateBytes: number | null;
  /** The walk exited with status 1: the bytes are those of what it could read, a lower bound. Absent otherwise. */
  partial?: true;
  /** Why `privateBytes` is null when the walk tried to count them: the volume cannot tell, or the counting walk failed. */
  privateUnknown?: 'volume' | 'walk';
}

function parseDu(output: string): TreeSize | null {
  const sizes = [...output.matchAll(/^(\d+)\s/gm)].map((match) => Number(match[1]));
  return sizes.length ? { bytes: sizes.reduce((sum, kb) => sum + kb, 0) * 1024, privateBytes: null } : null;
}

/**
 * Measures allocated and private bytes with the prebuilt real-size binary on macOS and Linux. Falls back to
 * du -sk with private bytes unknown when unavailable. With private: false, only du runs.
 * Null when neither walk can measure it or the shared deadline expires. Operation children retain their
 * cancellation and cleanup handling; other walks run at low priority and notify onSpawn.
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
    const [command, argv] = lowPriority ? lowPriorityCommand(file, args, false) : [file, args];
    return operation
      ? runOperationFile(operation, exec, command, argv, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          killSignal: 'SIGKILL',
          cwd: operation.cwd,
          signal: operation.signal,
        })
      : exec.runFileAsync(command, argv, {
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
  const counted = options.private !== false;
  const binary = counted && process.platform !== 'win32' ? binaryPath() : null;
  let privateUnknown: TreeSize['privateUnknown'] = binary || process.platform === 'darwin' ? 'walk' : 'volume';
  if (Date.now() >= deadline) return null;
  // real-size measures directories only: a file target with one link counts its allocated bytes as private, which
  // overstates a clone, and one with several links counts none.
  const dirs: string[] = [];
  let fileBytes = 0;
  let filePrivate = 0;
  for (const target of binary ? (options.targets ?? []) : []) {
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (info?.isDirectory()) dirs.push(target);
    else if (info?.isFile()) {
      fileBytes += info.blocks * 512;
      if (info.nlink === 1) filePrivate += info.blocks * 512;
    }
  }
  if (binary && options.targets && !dirs.length) return { bytes: fileBytes, privateBytes: filePrivate };
  if (binary) {
    try {
      const { total, paths }: RealSizeResult = JSON.parse(
        await walk(binary, ['--json', '--', ...(options.targets ? dirs : [path])]),
      );
      const size = options.targets ? total : paths[0];
      if (size) return { bytes: size.allocated + fileBytes, privateBytes: size.private + filePrivate };
    } catch (error) {
      const { status, stdout } = failed(error);
      if (error instanceof Error && 'signal' in error && error.signal) return null;
      if (status === UNSUPPORTED_STATUS) privateUnknown = 'volume';
      if (status === 1 && typeof stdout === 'string') {
        try {
          const { total, paths }: RealSizeResult = JSON.parse(stdout);
          const size = options.targets ? total : paths[0];
          if (total.skipped > 0 && size)
            return { bytes: size.allocated + fileBytes, privateBytes: size.private + filePrivate, partial: true };
        } catch {}
      }
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
