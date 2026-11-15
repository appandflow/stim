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

const READ_TIMEOUT_MS = 3000;
/** How long a reading taken just before a deletion may be reused by the next deletion of the same operation. */
const FRESH_MS = 5000;

/** `read`'s result, or an ETIMEDOUT rejection when it has not answered in time, as a hung mount would not. */
async function answered<T>(read: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the entries of each launcher directory and resolves the symlinks among them, once per reader. A wrapper
 * script that merely names a path is not followed. Every call to the directory has 3 seconds to answer.
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
      try {
        for (const name of await answered(io.readdir(directory), timeoutMs)) {
          const entry = join(directory, name);
          try {
            if (!(await answered(io.isSymlink(entry), timeoutMs))) continue;
            found.targets.push(await answered(io.realpath(entry), timeoutMs));
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
const fresh = new WeakMap<StimContext, { at: number; scan: Promise<LauncherScan> }>();

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
 * The launcher reader for the check that immediately precedes a deletion. It never uses the operation's planning
 * reading, which can be minutes old: a launcher may have appeared or a directory become unreadable since. Deletions of
 * one operation within 5 seconds of each other share one fresh reading, so many deletions in a row do not each pay the
 * read (55 to 72 ms here).
 */
export function freshLaunchers(
  operation: StimContext | undefined,
  signal?: AbortSignal,
  directories?: readonly string[],
): () => Promise<LauncherScan> {
  if (!operation) return () => newReader(operation, signal, directories)();
  return () => {
    const now = Date.now();
    const prior = fresh.get(operation);
    if (prior && now >= prior.at && now - prior.at < FRESH_MS) return prior.scan;
    const scan = newReader(operation, signal, directories)();
    fresh.set(operation, { at: now, scan });
    return scan;
  };
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
