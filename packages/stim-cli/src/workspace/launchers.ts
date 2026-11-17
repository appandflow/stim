import { constants } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { canonicalPath } from '../commands/gc/paths.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
import { launcherDirectories } from './launcher-directories.ts';

/**
 * One thing the inspection of the launcher directories could not settle: a directory that could not be read, an entry
 * that could not be resolved, or a read that has not answered. A directory or entry that does not exist, and a
 * dangling symlink, is no launcher. Neither is an entry that this user may neither inspect or resolve nor execute
 * (EACCES from both). Anything else that fails (permission, I/O, a loop, a timeout) is a problem, and nothing is
 * known about what it covers.
 */
export interface LauncherProblem {
  kind: 'directory' | 'entry' | 'pending' | 'owner';
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
  /** False when this user may not execute the path (EACCES); any other failure throws. */
  executable: (path: string) => Promise<boolean>;
}

const REAL_IO: LauncherIo = {
  readdir: (path) => readdir(path),
  isSymlink: async (path) => (await lstat(path)).isSymbolicLink(),
  realpath: (path) => realpath(path),
  executable: (path) =>
    access(path, constants.X_OK).then(
      () => true,
      (error: unknown) => {
        if (denied(error)) return false;
        throw error;
      },
    ),
};

const ABSENT = ['ENOENT', 'ENOTDIR'];
export const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && ABSENT.includes(String(error.code));
const denied = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EACCES';

const READ_TIMEOUT_MS = 3000;
const FIRST_PROBLEMS = 5;

export const describe = (error: unknown): string =>
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
          signal?.throwIfAborted();
          const entry = join(directory, name);
          try {
            if (!(await answered(directory, () => io.isSymlink(entry), timeoutMs))) continue;
            found.targets.push(await answered(directory, () => io.realpath(entry), timeoutMs));
          } catch (error) {
            if (error instanceof Unanswered) throw error;
            signal?.throwIfAborted();
            if (absent(error)) continue;
            if (denied(error)) {
              // access(2) follows the link the way execve(2) does, without readlink(2): macOS denies resolving
              // `/usr/sbin/weakpass_edit`, whose target is in root-only `authserver`, and this user cannot run it either,
              // while a mode 0700 root link such as a 1Password `/usr/local/bin` entry cannot be read but still runs.
              try {
                if (!(await answered(directory, () => io.executable(entry), timeoutMs))) continue;
              } catch (gone) {
                if (gone instanceof Unanswered) throw gone;
                signal?.throwIfAborted();
                if (absent(gone)) continue;
                found.incomplete.push({ kind: 'entry', path: entry, error: describe(gone) });
                continue;
              }
            }
            found.incomplete.push({ kind: 'entry', path: entry, error: describe(error) });
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
    for (const problem of scan.incomplete) noteLauncherProblem(operation, problem);
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
 * old. It is one evidence snapshot: a caller takes a new one wherever it reads running processes anew, and shares it
 * only among the checks that follow the same process read, so a launcher is read where the processes are and is never
 * reused across two process reads.
 */
export function freshLaunchers(
  operation: StimContext | undefined,
  signal?: AbortSignal,
  directories?: readonly string[],
): () => Promise<LauncherScan> {
  return newReader(operation, signal, directories);
}

/** A checkout root, or why ownership of a path could not be established, which keeps it. */
export type Checkout = string | { unknown: string; problem: LauncherProblem };

/** What a deletion path checks against PATH launchers: a launcher reading and the checkout it is checked against. */
export interface Launching {
  /** The reading the caller's checks share. */
  launchers: () => Promise<LauncherScan>;
  /** A new reading, taken by a check that reads running processes itself, right after that read. */
  anew: () => Promise<LauncherScan>;
  checkout: Checkout;
}

/** The `Launching` of a checkout whose checks share `launchers`, and whose process reads each take a new reading. */
export function launchingOf(
  checkout: Checkout,
  launchers: () => Promise<LauncherScan>,
  operation: StimContext | undefined,
  signal?: AbortSignal,
): Launching {
  return { launchers, anew: () => freshLaunchers(operation, signal)(), checkout };
}

/** Records a problem met outside a reading, such as a checkout whose owner cannot be established. */
export function noteLauncherProblem(operation: StimContext, problem: LauncherProblem): void {
  const seen = observed.get(operation) ?? new Map<string, LauncherProblem>();
  seen.set(`${problem.kind} ${problem.path}`, problem);
  observed.set(operation, seen);
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
  if (!problems.length) return;
  const first = problems.slice(0, FIRST_PROBLEMS);
  log(
    'warn',
    'launcher_evidence_incomplete',
    `Launcher evidence is incomplete, so cleanup keeps what it cannot rule out (${problems.length} found${problems.length > first.length ? `, first ${first.length}` : ''}): ${describeLauncherProblems(first)}. Run stim doctor for the fix.`,
    { count: problems.length, problems: first },
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
          : kind === 'owner'
            ? `which git checkout owns ${path} could not be established (${error})`
            : `${path}: ${error}`,
    )
    .join('; ');
}

/**
 * Why `folder` is kept for an executable on PATH: one resolves to a path inside it, or a launcher directory or entry
 * could not be inspected, so none can be ruled out. Null when every directory was read and none points into it.
 */
export function launcherReason(folder: Checkout, scan: LauncherScan): string | null {
  if (typeof folder !== 'string')
    return `an executable on PATH cannot be ruled out: ${folder.unknown}; Stim keeps the checkout until that can be read`;
  const root = canonicalPath(folder);
  const target = scan.targets.find((path) => path.startsWith(`${root}${sep}`));
  if (target) return `an executable on PATH runs from it (${target})`;
  if (scan.incomplete.length)
    return `an executable on PATH cannot be ruled out: ${describeLauncherProblems(scan.incomplete)}; Stim keeps every checkout until that is fixed (stim doctor names the fix)`;
  return null;
}
