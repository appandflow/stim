import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isScopedHome, withDirLock, type StimContext } from '@stim-cli/core';
import {
  discoveryCensusFile,
  machineSettingValue,
  maintenanceDir,
  readDiscoveryCensusFile,
  readDiscoveryScanFile,
  type CensusFind,
  type DiscoveryCensus,
} from '@stim-cli/core/state';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { refreshMeasure } from '../disk-usage.ts';
import { INSTALL_MARKERS, installSignature } from '../private-size.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { loadConfig } from './config.ts';
import { DISCOVER_ROOTS_KEY, REFRESH_MS, rootsOf } from './discovery-report.ts';
import { autoDiscoverEnabled, isBroadFolder, unmanagedScanFinds } from './discovery.ts';
import { scanDescends } from './scan-rules.ts';
import {
  ARTIFACT_DIRS,
  existingBuildDirsReads,
  signatureHeads,
  type DirRead,
  type DirReads,
} from './regenerable-dirs.ts';

const HOUR_MS = 60 * 60_000;
/** Per build directory: the walk of the one disk-usage walk the machine allows at a time. */
const WALK_TIMEOUT_MS = 10_000;
/** Per filesystem read of a checkout's layout. */
const READ_TIMEOUT_MS = 3000;
const TAG_PREFIX_BYTES = 64;
/** The most checkouts one run measures, and the longest it starts new reads or walks for; the rest wait for the next run. */
const MAX_CHECKOUTS = 25;
const BUDGET_MS = 90_000;

/** When this process last tried a run, so a census that cannot be stored does not start walks on every tick. */
const attempts = { at: 0 };

/** Whether the current scan rules enter every folder from `home` down to `path`; a path outside `home` is not judged. */
function descendable(home: string, path: string): boolean {
  const names = relative(home, path).split(sep);
  return names[0] === '..' || names.every((name, i) => scanDescends(name, i + 1));
}

/**
 * Whether a census run is due: none exists, the scan it came from is not the last one, `maintenance.discoverRoots` or
 * `maintenance.autoDiscover` (`autoDiscover`, when given) changed, a recorded find lies where the scan no longer descends, some directory is still waiting for a measurement
 * and an hour passed, or a day passed.
 */
export function censusDue(
  last:
    | (Pick<DiscoveryCensus, 'at' | 'scanRanAt' | 'roots' | 'pending' | 'autoDiscover'> & {
        finds?: readonly { path: string }[];
      })
    | null,
  scanRanAt: number,
  roots: readonly string[],
  now: number,
  home?: string,
  autoDiscover?: boolean,
): boolean {
  if (!last || last.at > now || last.scanRanAt !== scanRanAt) return true;
  if (autoDiscover !== undefined && (last.autoDiscover ?? true) !== autoDiscover) return true;
  if (home && last.finds?.some(({ path }) => !descendable(home, path))) return true;
  if (last.roots.length !== roots.length || last.roots.some((root, at) => root !== roots[at])) return true;
  return now - last.at >= (last.pending ? HOUR_MS : REFRESH_MS);
}

function writeCensus(census: DiscoveryCensus): void {
  mkdirSync(maintenanceDir(), { recursive: true });
  withDirLock(join(maintenanceDir(), 'discovery-census.lock'), () => {
    const file = discoveryCensusFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(census)}\n`);
    try {
      renameSync(tmp, file);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  });
}

/** The filesystem the census reads a checkout's layout through; tests inject it. */
export interface CensusIo {
  readNames: (path: string) => Promise<string[]>;
  isDirectory: (path: string) => Promise<boolean>;
  /** What the path is, without following a symlink, and when it was last modified. */
  lstat: (path: string) => Promise<{ kind: 'directory' | 'file' | 'other'; mtimeMs: number; ino?: number }>;
  realpath: (path: string) => Promise<string>;
  /** Null unless it is a regular file; else its first `bytes` bytes as text. */
  head: (path: string, bytes: number) => Promise<string | null>;
}

const REAL_IO: CensusIo = {
  readNames: (path) => readdir(path),
  isDirectory: async (path) => (await lstat(path)).isDirectory(),
  realpath: (path) => realpath(path),
  lstat: async (path) => {
    const info = await lstat(path);
    return {
      kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      mtimeMs: info.mtimeMs,
      ino: info.ino,
    };
  },
  head: async (path, bytes) => {
    if (!(await lstat(path)).isFile()) return null;
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(buffer, 0, bytes, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await file.close();
    }
  },
};

/** The budget ran out or the run was aborted before a read; nothing is known about the checkout yet. */
class OutOfBudget extends Error {}

/** A read failed (permission, I/O) or did not answer in time, so the layout of the checkout is not known. */
class Unreadable extends Error {
  unanswered: boolean;
  constructor(message: string, unanswered = false) {
    super(message);
    this.unanswered = unanswered;
  }
}

const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

interface Reader {
  names: (path: string) => Promise<string[]>;
  directory: (path: string) => Promise<boolean>;
  signature: (path: string) => Promise<boolean>;
  /** Null when the path does not exist. */
  info: (path: string) => Promise<Awaited<ReturnType<CensusIo['lstat']>> | null>;
  head: (path: string, bytes: number) => Promise<string | null>;
  /** The canonical path, or null when it does not exist. */
  real: (path: string) => Promise<string | null>;
  answer: (read: DirRead) => Promise<string[] | boolean>;
}

/**
 * Every read of a checkout's layout the census makes: asynchronous, through the shared bounded reader (3 seconds, one
 * outstanding timed-out read per isolate, none started while one is pending), with the abort and the run's budget
 * checked before each. A path that does not exist is absent (`[]` or false); any other failure, a timeout or a pending
 * hung read raises `Unreadable`, never an empty answer, so a checkout the census could not read is not a measured zero.
 */
function boundedReader(io: CensusIo, deadline: number, signal: AbortSignal, timeoutMs: number): Reader {
  const read = async <T>(path: string, missing: T, start: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new OutOfBudget();
    try {
      return await answered(path, start, timeoutMs);
    } catch (error) {
      signal.throwIfAborted();
      if (absent(error)) return missing;
      throw new Unreadable(error instanceof Error ? error.message : String(error), error instanceof Unanswered);
    }
  };
  const names = (path: string) => read<string[]>(path, [], () => io.readNames(path));
  const directory = (path: string) => read(path, false, () => io.isDirectory(path));
  const signature = async (path: string) => {
    const head = await read<string | null>(path, null, () => io.head(path, TAG_PREFIX_BYTES));
    return head !== null && signatureHeads(head);
  };
  const info = (path: string) => read<Awaited<ReturnType<CensusIo['lstat']>> | null>(path, null, () => io.lstat(path));
  const head = (path: string, bytes: number) => read<string | null>(path, null, () => io.head(path, bytes));
  const real = (path: string) => read<string | null>(path, null, () => io.realpath(path));
  return {
    real,
    names,
    directory,
    signature,
    info,
    head,
    answer: (request) =>
      'names' in request
        ? names(request.names)
        : 'directory' in request
          ? directory(request.directory)
          : signature(request.signature),
  };
}

async function drive<T>(reads: DirReads<T>, reader: Reader): Promise<T> {
  let step = reads.next();
  while (!step.done) step = reads.next(await reader.answer(step.value));
  return step.value;
}

/**
 * The build directories Stim recognises in a checkout: those `existingBuildDirsReads` lists (the same directory rules the
 * deleting passes use, driven here by the bounded reader) for the checkout and each folder directly in its `apps` and
 * `packages`. A tag file is read only when the listing shows a regular file, and only its first 64 bytes.
 */
async function buildDirsOf(path: string, reader: Reader): Promise<string[]> {
  const roots = [path];
  for (const parent of ['apps', 'packages'])
    for (const name of await reader.names(join(path, parent)))
      if (await reader.directory(join(path, parent, name))) roots.push(join(path, parent, name));
  const dirs = new Set<string>();
  for (const root of roots) for (const dir of await drive(existingBuildDirsReads(root), reader)) dirs.add(dir);
  return [...dirs];
}

const GIT_FILES = ['HEAD', 'index', join('logs', 'HEAD')];
const GIT_POINTER_BYTES = 512;
const WORKTREE_GIT_DIR = /[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/;

/**
 * The git directory of a checkout, established the way git records it and without running git. For a main checkout it
 * is `<c>/.git`, a directory. For a linked worktree it is the directory the `.git` file names after `gitdir:` (a relative
 * name is resolved against the checkout), which must end in `.git/worktrees/<name>` and hold a regular file `gitdir`
 * naming this checkout's `.git` file. Either way its canonical path must equal its normalised path, so no component is a
 * symlink. Every read is bounded. Null when any of that fails.
 */
async function gitDirOf(path: string, reader: Reader): Promise<string | null> {
  const dotGit = join(path, '.git');
  const info = await reader.info(dotGit);
  if (!info) return null;
  let gitDir: string;
  if (info.kind === 'directory') gitDir = dotGit;
  else if (info.kind === 'file') {
    const text = await reader.head(dotGit, GIT_POINTER_BYTES);
    const named = text === null ? null : /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
    if (!named) return null;
    gitDir = resolve(path, named);
    if (!WORKTREE_GIT_DIR.test(gitDir)) return null;
    const back = await reader.head(join(gitDir, 'gitdir'), GIT_POINTER_BYTES);
    if (back === null || resolve(gitDir, back.trim()) !== dotGit) return null;
  } else return null;
  return (await reader.real(gitDir)) === gitDir ? gitDir : null;
}

/**
 * When git last wrote in a checkout: the newest modification time of the git directory's `HEAD`, `index` and `logs/HEAD`
 * (commits, checkouts, staging and reflog writes change them; editing files without touching git does not). A file that
 * does not exist is skipped, and a git directory with none of them, a file that is not a regular file, a `logs` that is
 * not a real directory, a failed or timed out read or a spent budget gives null: unknown, never old. No git process runs
 * and no source is read.
 */
async function lastGitActivity(path: string, reader: Reader): Promise<number | null> {
  try {
    const gitDir = await gitDirOf(path, reader);
    if (!gitDir) return null;
    const logs = await reader.info(join(gitDir, 'logs'));
    if (logs && logs.kind !== 'directory') return null;
    let newest: number | null = null;
    for (const name of GIT_FILES) {
      const info = await reader.info(join(gitDir, name));
      if (!info) continue;
      if (info.kind !== 'file') return null;
      newest = Math.max(newest ?? 0, info.mtimeMs);
    }
    return newest;
  } catch (error) {
    if (error instanceof Unreadable || error instanceof OutOfBudget) return null;
    throw error;
  }
}

const FIXED_BUILD = ARTIFACT_DIRS.build.map((dir) => `${sep}${dir.split('/').join(sep)}`);

/**
 * The build directories inside the workspace at `root`, for the daemon's build-end measurement: the ones
 * `buildDirsOf` lists (the checkout and each folder directly in its `apps` and `packages`), kept only when their
 * canonical path is inside the canonical root, as the gc worktree report keeps them, so a link to another checkout is
 * left out, each with whether the walk counts its private bytes (not for a fixed `ARTIFACT_DIRS.build` name). Every read
 * goes through the bounded reader. `'absent'` when the root does not exist or its bounded canonical path is another
 * folder (a link now stands in its place); on darwin and win32 a path that differs only by case is the same folder, since
 * `realpathSync` keeps the spelling it was given and `fs.promises.realpath` returns the true case, and only when the root
 * itself is a real directory, not a link. The canonical path is the boundary the folders must be inside, but each kept
 * folder is returned spelled as the gc worktree report keys it (the root's spelling joined with the name as the
 * enumeration spells it), since the disk-usage cache is keyed by the exact string. Null when a read failed or did not answer; an abort propagates.
 */
export async function buildOutputDirs(
  root: string,
  signal: AbortSignal,
  {
    io = REAL_IO,
    timeoutMs = READ_TIMEOUT_MS,
    platform = process.platform,
  }: { io?: CensusIo; timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<{ dir: string; private: boolean }[] | 'absent' | null> {
  const reader = boundedReader(io, Infinity, signal, timeoutMs);
  try {
    const canonical = await reader.real(root);
    const caseless = platform === 'darwin' || platform === 'win32';
    if (canonical === null || (caseless ? canonical.toLowerCase() !== root.toLowerCase() : canonical !== root))
      return 'absent';
    if (canonical !== root && (await reader.info(root))?.kind !== 'directory') return 'absent';
    const kept = new Map<string, string>();
    for (const dir of await buildDirsOf(root, reader)) {
      const real = await reader.real(dir);
      if (real !== null && !kept.has(real) && (real === canonical || real.startsWith(canonical + sep)))
        kept.set(real, dir);
    }
    return [...kept.values()].map((dir) => ({ dir, private: !FIXED_BUILD.some((fixed) => dir.endsWith(fixed)) }));
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

function stamped(info: Awaited<ReturnType<CensusIo['lstat']>> | null): string | null {
  if (!info) return null;
  if (info.ino === undefined) throw new Error('the census io returned no inode');
  return `${info.ino}:${info.mtimeMs}`;
}

/**
 * The install signature of the dependency directory at `path`, read through the bounded reader, as `treeSignature` would
 * compute it: null when `path` is not a real directory, or when a read did not answer or the directory itself could
 * not be read. A marker whose read answered with an error counts as missing, as `treeSignature` does; one that did not
 * answer in time leaves the signature unknown (null), never a fabricated one. An abort propagates.
 */
export async function dependencyTreeSignature(
  path: string,
  signal: AbortSignal,
  { io = REAL_IO, timeoutMs = READ_TIMEOUT_MS }: { io?: CensusIo; timeoutMs?: number } = {},
): Promise<string | null> {
  const reader = boundedReader(io, Infinity, signal, timeoutMs);
  try {
    const info = await reader.info(path);
    if (info?.kind !== 'directory') return null;
    const root = stamped(info);
    if (root === null) return null;
    const markers: (string | null)[] = [];
    for (const name of INSTALL_MARKERS) {
      try {
        markers.push(stamped(await reader.info(join(path, name))));
      } catch (error) {
        if (!(error instanceof Unreadable) || error.unanswered) throw error;
        markers.push(null);
      }
    }
    return installSignature(root, markers);
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

type Measurement = Pick<
  CensusFind,
  'dirs' | 'measuredDirs' | 'failedDirs' | 'partialDirs' | 'bytes' | 'unreadable' | 'gitActivityAt'
>;

/**
 * The recognised build output of a checkout, measured one directory at a time through `refreshMeasure`: the disk usage
 * cache while an entry is under a day old, else one walk under the machine's walk claim, with the walk timeout. A
 * walk that failed or timed out counts as failed, never as zero; a directory not reached before the budget ran out, or
 * while another walk held the claim, is not measured yet; a checkout whose layout could not be read is `unreadable`.
 * Null when the budget ran out before its layout was known. A directory the gc worktree report sizes with its private
 * bytes (a discovered build directory, not a fixed `ARTIFACT_DIRS.build` name) is measured with them too, so the cache
 * entry the report reads carries what it expects. Errors that carry `reportCleanup`, and aborts, propagate.
 */
async function measureBuildOutput(
  path: string,
  operation: StimContext,
  deadline: number,
  io: CensusIo,
  timeoutMs: number,
): Promise<Measurement | null> {
  const reader = boundedReader(io, deadline, operation.signal, timeoutMs);
  let dirs: string[];
  try {
    dirs = await buildDirsOf(path, reader);
  } catch (error) {
    if (error instanceof OutOfBudget) return null;
    if (error instanceof Unreadable)
      return {
        dirs: 0,
        measuredDirs: 0,
        failedDirs: 0,
        partialDirs: 0,
        bytes: 0,
        unreadable: true,
        gitActivityAt: null,
      };
    throw error;
  }
  const result: Measurement = {
    dirs: dirs.length,
    measuredDirs: 0,
    failedDirs: 0,
    partialDirs: 0,
    bytes: 0,
    unreadable: false,
    gitActivityAt: await lastGitActivity(path, reader),
  };
  for (const dir of dirs) {
    operation.signal.throwIfAborted();
    if (Date.now() > deadline) continue;
    const { outcome, measure, partial } = await refreshMeasure(dir, {
      timeoutMs: WALK_TIMEOUT_MS,
      maxAgeMs: REFRESH_MS,
      claim: true,
      operation,
      private: !FIXED_BUILD.some((fixed) => dir.endsWith(fixed)),
      failures: true,
      knownToExist: true,
    });
    if (measure) {
      result.measuredDirs++;
      if (partial) result.partialDirs++;
      result.bytes += measure.bytes;
    } else if (outcome !== 'busy') result.failedDirs++;
  }
  return result;
}

/** An error the daemon's cleanup containment must see: a child whose cleanup could not be verified, or no claim. */
export function isUnverifiedCleanup(error: unknown): boolean {
  return (
    error instanceof Error && ('reportCleanup' in error || ('code' in error && error.code === 'STIM_CLAIM_UNAVAILABLE'))
  );
}

// @ref LLP 0004#the-doctor-listing-and-the-low-disk-line -- the daemon measures, commands read
/**
 * Classifies the finds of the last full scan that Stim does not fully manage, and measures their recognised build
 * output, for the doctor listing and the low-disk line. It runs in the daemon after the scan, never in a command, and
 * a scoped STIM_HOME never does. It classifies the scan result it reads, records that result's `ranAt`, and writes
 * `maintenance/discovery-census.json`.
 *
 * Bounds: every read of a checkout's layout goes through the bounded reader (`CensusIo`); at most `MAX_CHECKOUTS`
 * checkouts are looked at per run and none after `BUDGET_MS`; walks are one at a time machine-wide (`refreshMeasure`
 * with a claim), each with `WALK_TIMEOUT_MS`; nothing starts while a timed-out read is pending. A checkout measured
 * within a day is carried over without a read. The others are due: they are taken in the order they have waited longest
 * (never measured first, then the oldest measurement), so a run that cannot reach all of them still advances through
 * them. One left over keeps its earlier entry, which keeps the census pending, and the next run, within the hour,
 * continues. The idle evidence of a checkout is not read: it walks the checkout's source with
 * no bound the census could apply.
 *
 * Aborts and errors with `reportCleanup` (or STIM_CLAIM_UNAVAILABLE) propagate unchanged, for the daemon's cleanup
 * containment. An unverified cleanup is tested first, so it survives an abort; any other error is contained and returned as its message for the caller to log; nothing is written.
 */
export async function runDiscoveryCensusIfDue(
  tick: { operation: StimContext } | undefined,
  {
    now = Date.now(),
    attempted = attempts,
    io = REAL_IO,
    readTimeoutMs = READ_TIMEOUT_MS,
    maxCheckouts = MAX_CHECKOUTS,
    budgetMs = BUDGET_MS,
  }: {
    now?: number;
    attempted?: { at: number };
    /** The reads of a checkout's layout; tests inject them. */
    io?: CensusIo;
    readTimeoutMs?: number;
    maxCheckouts?: number;
    budgetMs?: number;
  } = {},
): Promise<string | void> {
  if (!tick || isScopedHome(tick.operation.env)) return;
  const { operation } = tick;
  try {
    const scanFile = readDiscoveryScanFile();
    const file = readDiscoveryCensusFile();
    if (scanFile.status !== 'read' || !scanFile.scan || file.status === 'unreadable' || hungRead() !== null) return;
    const config = loadConfig();
    const setting = machineSettingValue(DISCOVER_ROOTS_KEY, { config, env: operation.env });
    const roots = rootsOf(setting, homedir());
    const last = file.status === 'read' ? file.census : null;
    if (
      !censusDue(
        last,
        scanFile.scan.ranAt,
        roots,
        now,
        canonicalPath(homedir()),
        autoDiscoverEnabled(config, operation.env),
      ) ||
      (now >= attempted.at && now - attempted.at < HOUR_MS)
    )
      return;
    attempted.at = now;
    const finds = await unmanagedScanFinds(config, listedRoots(), operation);
    if (!finds) return;
    const previous = new Map((last?.finds ?? []).map((find) => [find.path, find]));
    const deadline = Date.now() + budgetMs;
    let looked = 0;
    const entries: CensusFind[] = [];
    const due: Array<{
      index: number;
      tried: number;
      measuredAt: number;
      kept: CensusFind;
      placement: Pick<CensusFind, 'path' | 'kind' | 'folder' | 'adoptable'>;
    }> = [];
    const groups: Array<[CensusFind['kind'], string[]]> = [
      ['reduce-only', finds.reduceOnly],
      ['dot-folder', finds.dotFolder],
      ['untracked', finds.untracked],
      ['unchecked', finds.unchecked],
    ];
    for (const [kind, paths] of groups)
      for (const path of paths) {
        operation.signal.throwIfAborted();
        const folder = dirname(path);
        const earlier = previous.get(path);
        const placement = { path, kind, folder, adoptable: !isBroadFolder(folder) };
        const kept: CensusFind = earlier
          ? { ...earlier, ...placement }
          : {
              ...placement,
              evaluatedAt: 0,
              dirs: 0,
              measuredDirs: 0,
              failedDirs: 0,
              partialDirs: 0,
              bytes: 0,
              unreadable: false,
              gitActivityAt: null,
            };
        entries.push(kept);
        if (kind === 'unchecked') continue;
        const complete =
          earlier &&
          earlier.evaluatedAt > 0 &&
          !earlier.unreadable &&
          earlier.measuredDirs === earlier.dirs &&
          earlier.failedDirs === 0;
        if (complete && now - earlier.evaluatedAt < REFRESH_MS) continue;
        due.push({
          index: entries.length - 1,
          tried: kept.attemptedAt ?? 0,
          measuredAt: kept.evaluatedAt,
          kept,
          placement,
        });
      }
    for (const { index, kept, placement } of due.toSorted((a, b) => a.tried - b.tried || a.measuredAt - b.measuredAt)) {
      if (looked >= maxCheckouts || Date.now() > deadline || hungRead() !== null) break;
      looked++;
      const measured = await measureBuildOutput(placement.path, operation, deadline, io, readTimeoutMs);
      entries[index] = measured
        ? { ...placement, ...measured, evaluatedAt: now, attemptedAt: now }
        : { ...kept, attemptedAt: now };
    }
    operation.signal.throwIfAborted();
    writeCensus({
      version: 1,
      at: now,
      scanRanAt: finds.scanRanAt,
      roots,
      canonicalRoots: finds.canonicalRoots,
      autoDiscover: finds.autoDiscover,
      pending: entries.some(
        (find) =>
          find.kind === 'unchecked' ||
          find.unreadable ||
          find.evaluatedAt === 0 ||
          now - find.evaluatedAt >= REFRESH_MS ||
          find.measuredDirs + find.failedDirs < find.dirs,
      ),
      finds: entries,
    });
  } catch (error) {
    if (isUnverifiedCleanup(error)) throw error;
    operation.signal.throwIfAborted();
    return error instanceof Error ? error.message : String(error);
  }
}
