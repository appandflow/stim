import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { canonicalPath } from '../commands/gc/paths.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
import { launcherDirectories } from './launcher-directories.ts';

/**
 * One thing the inspection of the launcher directories could not settle: a directory that could not be read, an entry
 * that could not be resolved, or a read that has not answered. A directory or entry that does not exist, and a
 * dangling symlink, is no launcher. Anything else that fails (permission, I/O, a loop, a timeout) is a problem, and
 * nothing is known about what it covers.
 */
export interface LauncherProblem {
  kind: 'directory' | 'entry' | 'pending';
  path: string;
  error: string;
}

/** Where the executables on PATH that are symlinks resolve to, and what could not be inspected. */
export interface LauncherScan {
  targets: string[];
  incomplete: LauncherProblem[];
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

const describe = (error: unknown) =>
  error instanceof Error && 'code' in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : String(error);

const pendingProblem = (path: string, directories: readonly string[]): LauncherProblem => ({
  kind: 'pending',
  path,
  error: directories.includes(path)
    ? 'an earlier read of it has not answered'
    : 'a read outside the launcher directories, such as the home scan, has not answered',
});

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
      if (stuck) {
        found.incomplete.push(pendingProblem(stuck, directories));
        return found;
      }
      try {
        for (const name of await answered(directory, () => io.readdir(directory), timeoutMs)) {
          const entry = join(directory, name);
          try {
            if (!(await answered(directory, () => io.isSymlink(entry), timeoutMs))) continue;
            found.targets.push(await answered(directory, () => io.realpath(entry), timeoutMs));
          } catch (error) {
            if (error instanceof Unanswered) throw error;
            signal?.throwIfAborted();
            if (!absent(error)) found.incomplete.push({ kind: 'entry', path: entry, error: describe(error) });
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (absent(error)) continue;
        if (error instanceof Unanswered) {
          found.incomplete.push(
            hungRead() === directory || !hungRead()
              ? { kind: 'directory', path: directory, error: error.message }
              : pendingProblem(hungRead() ?? directory, directories),
          );
          return found;
        }
        found.incomplete.push({ kind: 'directory', path: directory, error: describe(error) });
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
const observed = new WeakMap<StimContext, Map<string, LauncherProblem>>();

const newReader = (
  operation: StimContext | undefined,
  signal: AbortSignal | undefined,
  directories?: readonly string[],
): (() => Promise<LauncherScan>) => {
  const read = launcherReader(signal ?? operation?.signal, {
    directories: directories ?? launcherDirectories(operation?.env),
  });
  if (!operation) return read;
  return async () => {
    const scan = await read();
    const seen = observed.get(operation) ?? new Map<string, LauncherProblem>();
    for (const problem of scan.incomplete) seen.set(`${problem.kind} ${problem.path}`, problem);
    observed.set(operation, seen);
    return scan;
  };
};

/**
 * The launcher reader of an operation for planning: every route of one pass shares one reading. Without an operation it
 * is a new reader, so a caller holds the one it gets and calls it for every check of its own operation.
 */
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
 * A launcher reader that reads once, at its first call, never the operation's planning reading, which can be minutes
 * old. One deletion operation takes one and shares it across its checks, so a launcher is treated like a running
 * process read at the same moment: the window that remains is the one after that read.
 */
export function freshLaunchers(
  operation: StimContext | undefined,
  signal?: AbortSignal,
  directories?: readonly string[],
): () => Promise<LauncherScan> {
  return newReader(operation, signal, directories);
}

/** What a deletion path checks against PATH launchers: a launcher reading and the checkout it is checked against. */
export interface Launching {
  launchers: () => Promise<LauncherScan>;
  checkout: string;
}

/** The launcher problems that readings of the operation have met since the last call, each once. */
function takeLauncherProblems(operation: StimContext): LauncherProblem[] {
  const problems = [...(observed.get(operation)?.values() ?? [])];
  observed.delete(operation);
  return problems;
}

/** Writes one record when a pass met launcher evidence it could not settle, which keeps every checkout. */
export function logLauncherProblems(
  operation: StimContext,
  log: (level: 'warn', event: string, msg: string, fields?: Record<string, unknown>) => void,
): void {
  const problems = takeLauncherProblems(operation);
  if (problems.length)
    log(
      'warn',
      'launcher_evidence_incomplete',
      `Launcher evidence is incomplete, so cleanup keeps every checkout: ${describeLauncherProblems(problems)}. Run stim doctor for the fix.`,
      { problems },
    );
}

/** The same, as one sentence for a log record or a finding. */
export function describeLauncherProblems(problems: readonly LauncherProblem[]): string {
  return problems
    .map(({ kind, path, error }) =>
      kind === 'directory'
        ? `the directory ${path} could not be read (${error})`
        : kind === 'entry'
          ? `${path} could not be resolved (${error})`
          : `${path}: ${error}`,
    )
    .join('; ');
}

/**
 * Why `folder` is kept for an executable on PATH: one resolves to a path inside it, or a launcher directory or entry
 * could not be inspected, so none can be ruled out. Null when every directory was read and none points into it.
 */
export function launcherReason(folder: string, scan: LauncherScan): string | null {
  const root = canonicalPath(folder);
  const target = scan.targets.find((path) => path.startsWith(`${root}${sep}`));
  if (target) return `an executable on PATH runs from it (${target})`;
  if (scan.incomplete.length)
    return `an executable on PATH cannot be ruled out: ${describeLauncherProblems(scan.incomplete)}; Stim keeps every checkout until that is fixed (stim doctor names the fix)`;
  return null;
}
