import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { canonicalPath } from '../commands/gc/paths.ts';
import { launcherDirectories } from './launcher-directories.ts';

/**
 * Where the executables on PATH that are symlinks resolve to, and the directories whose inspection could not be
 * completed. A directory or entry that does not exist, and a dangling symlink, is no launcher. Anything else that
 * fails (permission, I/O, a timeout) is incomplete, and nothing is known about that directory.
 */
export interface LauncherScan {
  targets: string[];
  incomplete: string[];
}

interface LauncherIo {
  readdir: (path: string) => Promise<string[]>;
  isSymlink: (path: string) => Promise<boolean>;
  realpath: (path: string) => Promise<string>;
}

const REAL_IO: LauncherIo = {
  readdir: (path) => readdir(path),
  isSymlink: async (path) => (await lstat(path)).isSymbolicLink(),
  realpath: (path) => realpath(path),
};

const ABSENT = ['ENOENT', 'ENOTDIR'];
const absent = (error: unknown) => error instanceof Error && 'code' in error && ABSENT.includes(String(error.code));

/**
 * Reads the entries of each launcher directory and resolves the symlinks among them, once per reader. A wrapper
 * script that merely names a path is not followed.
 */
export function launcherReader(
  signal?: AbortSignal,
  { directories, io = REAL_IO }: { directories: readonly string[]; io?: LauncherIo } = { directories: [] },
): () => Promise<LauncherScan> {
  let scan: Promise<LauncherScan> | undefined;
  const read = async (): Promise<LauncherScan> => {
    const found: LauncherScan = { targets: [], incomplete: [] };
    for (const directory of directories) {
      signal?.throwIfAborted();
      try {
        for (const name of await io.readdir(directory)) {
          const entry = join(directory, name);
          try {
            if (!(await io.isSymlink(entry))) continue;
            found.targets.push(await io.realpath(entry));
          } catch (error) {
            if (!absent(error)) throw error;
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!absent(error)) found.incomplete.push(directory);
      }
    }
    return found;
  };
  return () => (scan ??= read());
}

const readers = new WeakMap<StimContext, () => Promise<LauncherScan>>();

/** The launcher reader of an operation, so every route of one pass reads the directories once. */
export function launchersOf(
  operation: StimContext | undefined,
  signal?: AbortSignal,
  directories?: readonly string[],
): () => Promise<LauncherScan> {
  const make = () =>
    launcherReader(signal ?? operation?.signal, {
      directories: directories ?? launcherDirectories(operation?.env ?? {}),
    });
  if (!operation) return make();
  let reader = readers.get(operation);
  if (!reader) readers.set(operation, (reader = make()));
  return reader;
}

/**
 * Why `folder` is kept for an executable on PATH: one resolves to a path inside it, or a launcher directory could
 * not be inspected, so none can be ruled out. Null when every directory was read and none points into it.
 */
export function launcherReason(folder: string, scan: LauncherScan): string | null {
  const root = canonicalPath(folder);
  const target = scan.targets.find((path) => path.startsWith(`${root}${sep}`));
  if (target) return `an executable on PATH runs from it (${target})`;
  if (scan.incomplete.length)
    return `an executable on PATH cannot be ruled out: ${scan.incomplete.join(', ')} could not be read`;
  return null;
}
