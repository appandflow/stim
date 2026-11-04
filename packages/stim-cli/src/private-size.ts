import type { ChildProcess } from 'node:child_process';
import { lstatSync } from 'node:fs';
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
const INSTALL_MARKERS = ['.modules.yaml', '.package-lock.json', '.yarn-state.yml', '.yarn-integrity', 'Manifest.lock'];

export interface TreeSize {
  bytes: number;
  /** What deleting the tree would free; null when the volume or the machine cannot tell. */
  privateBytes: number | null;
}

function parseHelper(output: string): TreeSize | null {
  const match = /^(\d+) (\d+) \d+$/m.exec(output);
  return match ? { bytes: Number(match[1]), privateBytes: Number(match[2]) } : null;
}

function parseDu(output: string): TreeSize | null {
  const sizes = [...output.matchAll(/^(\d+)\s/gm)].map((match) => Number(match[1]));
  return sizes.length ? { bytes: sizes.reduce((sum, kb) => sum + kb, 0) * 1024, privateBytes: null } : null;
}

/**
 * The size of the tree at `path` in one walk: on macOS with the Command Line Tools, `stim-privsize` gives the allocated
 * and private bytes; elsewhere, or when the helper fails, `du -sk` gives the allocated bytes and the private bytes stay
 * unknown. With `targets`, or `private: false`, only `du -sk` runs, over the targets' sum. Null when neither could
 * measure it, or when the helper was stopped at the timeout. With an operation the walk is its declared child; without
 * one it runs at low priority and `onSpawn` sees it.
 */
export async function measureTree(
  path: string,
  options: {
    timeoutMs: number;
    onSpawn?: (child: ChildProcess) => void;
    operation?: StimContext;
    targets?: string[];
    private?: false;
  },
): Promise<TreeSize | null> {
  const { operation } = options;
  const exec = getExecutor();
  const walk = (file: string, args: string[]): Promise<string> =>
    operation
      ? runOperationFile(operation, exec, file, args, {
          timeoutMs: options.timeoutMs,
          killSignal: 'SIGKILL',
          cwd: operation.cwd,
          signal: operation.signal,
        })
      : exec.runFileAsync('nice', ['-n', NICENESS, file, ...args], {
          timeoutMs: options.timeoutMs,
          onSpawn: options.onSpawn,
        });
  const failed = (error: unknown): { status: unknown; stdout: unknown } => {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    const status: unknown = error instanceof Error && 'status' in error ? error.status : undefined;
    const stdout: unknown = error instanceof Error && 'stdout' in error ? error.stdout : undefined;
    return { status, stdout };
  };
  const helper = options.targets || options.private === false ? null : await privateSizeHelper(operation);
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
    return status === 1 && typeof stdout === 'string' ? parseDu(stdout) : null;
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
  return [root, ...INSTALL_MARKERS.map((name) => stamp(join(path, name)) ?? '-')].join(',');
}
