import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { canonicalPath } from '../commands/gc/paths.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
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

const READ_TIMEOUT_MS = 3000;

/** Readings run one at a time, so a reading never adds a second read in flight. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Reads the entries of each launcher directory and resolves the symlinks among them, once per reader. A wrapper
 * script that merely names a path is not followed. Every call to the directory has 3 seconds to answer; one that does
 * not ends the reading at once as incomplete, and no read of any kind starts while an earlier one is still pending
 * (`bounded-read.ts`).
 */
export function launcherReader(
  signal?: AbortSignal,
  {
    directories,
    io = REAL_IO,
    timeoutMs = READ_TIMEOUT_MS,
  }: { directories: readonly string[]; io?: LauncherIo; timeoutMs?: number } = { directories: [] },
): () => Promise<LauncherScan> {
  let scan: Promise<LauncherScan> | undefined;
  const read = async (): Promise<LauncherScan> => {
    const found: LauncherScan = { targets: [], incomplete: [] };
    for (const directory of directories) {
      signal?.throwIfAborted();
      const stuck = hungRead();
      if (stuck) return { targets: found.targets, incomplete: [...found.incomplete, stuck] };
      try {
        for (const name of await answered(directory, () => io.readdir(directory), timeoutMs)) {
          const entry = join(directory, name);
          try {
            if (!(await answered(directory, () => io.isSymlink(entry), timeoutMs))) continue;
            found.targets.push(await answered(directory, () => io.realpath(entry), timeoutMs));
          } catch (error) {
            if (!absent(error)) throw error;
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (absent(error)) continue;
        found.incomplete.push(directory);
        if (error instanceof Unanswered) return found;
      }
    }
    return found;
  };
  return () => {
    if (!scan) {
      const run = queue.then(read, read);
      queue = run;
      scan = run;
    }
    return scan;
  };
}

const readers = new WeakMap<StimContext, () => Promise<LauncherScan>>();

const newReader = (
  operation: StimContext | undefined,
  signal: AbortSignal | undefined,
  directories?: readonly string[],
) => launcherReader(signal ?? operation?.signal, { directories: directories ?? launcherDirectories(operation?.env) });

/** The launcher reader of an operation for planning: every route of one pass shares one reading. */
export function launchersOf(
  operation: StimContext | undefined,
  signal?: AbortSignal,
  directories?: readonly string[],
): () => Promise<LauncherScan> {
  if (!operation) return newReader(operation, signal, directories);
  let reader = readers.get(operation);
  if (!reader) readers.set(operation, (reader = newReader(operation, signal, directories)));
  return reader;
}

/**
 * A launcher reader that reads anew on every call, never the operation's planning reading, which can be minutes old. A
 * deletion route calls it at the moment it reads the processes that use the path, and no earlier, so a launcher is
 * treated like a running process: the window that remains is the one after that read.
 */
export function freshLaunchers(
  operation: StimContext | undefined,
  signal?: AbortSignal,
  directories?: readonly string[],
): () => Promise<LauncherScan> {
  return () => newReader(operation, signal, directories)();
}

/**
 * What a deletion path checks against PATH launchers: a launcher reading and the checkout it is checked against. Every
 * caller states it.
 */
export interface Launching {
  launchers: () => Promise<LauncherScan>;
  checkout: string;
}

/** The `Launching` of a checkout for planning: the operation's shared reading. */
export function planningLaunching(
  checkout: string,
  operation: StimContext | undefined,
  signal?: AbortSignal,
): Launching {
  return { launchers: launchersOf(operation, signal), checkout };
}

/** The `Launching` of a checkout for a deletion: a fresh launcher reading. */
export function launchingOf(checkout: string, operation: StimContext | undefined, signal?: AbortSignal): Launching {
  return { launchers: freshLaunchers(operation, signal), checkout };
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
    return `an executable on PATH cannot be ruled out: ${scan.incomplete.join(', ')} could not be read; fixing its permissions or access restores reduction`;
  return null;
}
