import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { releaseReserveWhenFull } from '../disk-reserve.ts';
import { getExecutor } from '../exec.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { exactClean, type ExactCleanReport } from '../integrations/exact-clean.ts';
import { withCargoLocks } from './cargo-lock.ts';
import { cargoTargetDirsAsync } from './regenerable-dirs.ts';
import { othersRunningAsync, readRunningProcessesAsync, runningFromReason } from './running-from.ts';

const CARGO_PROFILE_IDLE_MS: number = 24 * 3_600_000;

const FINGERPRINT = '.fingerprint';
const PROFILE_PARTS = [FINGERPRINT, 'deps', 'build', 'incremental'];
/** The files Cargo itself writes in a target triple directory; any other entry there belongs to something else. */
const CARGO_TRIPLE_FILES = new Set(['CACHEDIR.TAG', '.rustc_info.json', '.cargo-lock']);
/** Cargo 1.97 locks the build and artifact directories separately and takes .cargo-lock for older Cargo. */
const PROFILE_LOCKS = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];
const EXACT_LEDGER = '.exact-sweep.json';
const CACHEDIR_TAG = 'CACHEDIR.TAG';
const EXACT_APPLE_LOCKS = '.apple-cargo-locks';
/** The lock files Cargo and Exact take in a `target/`, which a delete leaves in place. */
const LOCK_FILES = new Set([...PROFILE_LOCKS, `${EXACT_LEDGER}.lock`]);
const NOT_PROFILES = new Set(['.exact-swept']);
/** What Exact writes in a `target/` it owns: its sweep ledger and lock, and the folders that hold an app's records. */
const EXACT_OWNED = [EXACT_LEDGER, `${EXACT_LEDGER}.lock`, 'web-receipts', 'native-receipts', 'receipts', 'traces'];
const CANNOT_READ = 'the files processes hold open cannot be read';
const DEADLINE_KEPT = 'the rest was left at the build headroom deadline';
/** Solana's `cargo build-sbf` and Anchor keep each program's private key in `deploy/<program>-keypair.json`. */
const KEYPAIR_DIR = 'deploy';
const isKeypairDir = (name: string): boolean => name.toLowerCase() === KEYPAIR_DIR;
export const isKeypairName = (name: string): boolean => name.toLowerCase().endsWith('-keypair.json');

/**
 * The top-level entries of `target` the dormant delete removes (`output`), and those it keeps (`kept`): a symbolic link,
 * which a delete must not go through, a `deploy/` directory holding a `*-keypair.json`, both names in any letter case,
 * and Cargo's `CACHEDIR.TAG`, which Cargo writes only when it creates the `target/` and by which Stim recognises it.
 * Null when `target` cannot be listed.
 */
function targetEntries(target: string): { output: string[]; kept: string[] } | null {
  const entries = entriesOf(target);
  if (!entries) return null;
  const output: string[] = [];
  const kept: string[] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const keypairs = isKeypairDir(entry.name) && entry.isDirectory() && holdsKeypair(join(target, entry.name));
    (entry.isSymbolicLink() || keypairs || entry.name === CACHEDIR_TAG ? kept : output).push(entry.name);
  }
  return { output, kept };
}

/**
 * What the dormant delete would remove from `target`, as absolute paths: each top-level entry of `targetEntries`' output
 * but one that holds only what the remover leaves (lock files, keypairs and links). For an Exact app's `target/` it is an
 * upper bound, since Exact's cleaner decides at the delete what goes; Stim does not run that cleaner to plan, because
 * every run writes Exact's sweep files into the `target/` and would make it look used.
 */
export async function removablePaths(target: string): Promise<{ paths: string[] } | { kept: string }> {
  const names = await removableEntries(target);
  return names ? { paths: names.map((name) => join(target, name)) } : { kept: `${target} cannot be listed` };
}

/** The top-level entries of `target` that `removablePaths` lists, or null when `target` cannot be listed. */
async function removableEntries(target: string): Promise<string[] | null> {
  const entries = targetEntries(target);
  if (!entries) return null;
  const output: string[] = [];
  for (const name of entries.output) if (!(await leftAlone(join(target, name)))) output.push(name);
  return output;
}

/** Whether `app` holds an `exact.mjs` of any kind, as Exact app discovery reads it: a link counts too. */
const isExactApp = (app: string): boolean => lstatSync(join(app, 'exact.mjs'), { throwIfNoEntry: false }) !== undefined;

/** Why Exact's cleaner removed nothing, for a kept detail. */
function exactKept(report: ExactCleanReport | { unsupported: string } | { unknown: string }): string {
  if ('unknown' in report) return `Exact's clean ended without a report: ${report.unknown}`;
  if ('unsupported' in report) return `Exact's cleaner cannot run, so Stim keeps it: ${report.unsupported}`;
  if (report.status === 'busy') return `Exact reports it in use: ${report.held.join(', ')}`;
  return `Exact's cleaner ${report.status === 'refused' ? 'refuses it' : 'failed'}: ${report.error ?? 'no reason given'}`;
}

/**
 * Whether the remover would leave everything at `path`: it holds nothing but lock files, keypairs and links, and is not
 * an empty directory, which the remover removes.
 */
async function leftAlone(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return true;
  if (!stat.isDirectory()) return kept(basename(path));
  if (basename(path) === EXACT_APPLE_LOCKS) return true;
  const names = await readdir(path).catch(() => null);
  if (!names) return true;
  if (!names.length) return false;
  for (const name of names) if (!(await leftAlone(join(path, name)))) return false;
  return true;
}

/** Whether the directory at `path` holds a `*-keypair.json` in any letter case, or cannot be read to tell. */
function holdsKeypair(path: string): boolean {
  const entries = entriesOf(path);
  return !entries || entries.some((entry) => isKeypairName(entry.name));
}

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

export interface CargoProfile {
  /** The profile directory relative to `target/`: `debug` or `<triple>/<profile>`. */
  path: string;
  /** When a build last wrote it or Exact's ledger last stamped it, in ms, or null when that cannot be read. */
  lastUsedMs: number | null;
}

/**
 * The profile directories no build has written or read for `idleMs`, as the paths to remove: a profile alone, or a
 * target triple whole once every profile in it qualifies and the triple holds nothing else (`extras` names the
 * triples that do). A profile whose last use is unknown stays.
 */
export function staleCargoPaths(
  profiles: readonly CargoProfile[],
  extras: ReadonlySet<string>,
  now: number,
  idleMs: number = CARGO_PROFILE_IDLE_MS,
): string[] {
  const stale = (profile: CargoProfile) => profile.lastUsedMs !== null && now - profile.lastUsedMs > idleMs;
  const triples = new Map<string, CargoProfile[]>();
  for (const profile of profiles) {
    const slash = profile.path.indexOf('/');
    if (slash > 0)
      triples.set(profile.path.slice(0, slash), [...(triples.get(profile.path.slice(0, slash)) ?? []), profile]);
  }
  const paths: string[] = [];
  for (const profile of profiles) {
    if (!stale(profile)) continue;
    const triple = profile.path.includes('/') ? profile.path.slice(0, profile.path.indexOf('/')) : null;
    if (triple === null) paths.push(profile.path);
    else if (!(triples.get(triple) ?? []).every(stale) || extras.has(triple)) paths.push(profile.path);
    else if (!paths.includes(triple)) paths.push(triple);
  }
  return paths.filter((path) => !paths.some((other) => path.startsWith(`${other}/`)));
}

/**
 * Exact's `.exact-sweep.json` ledger (`{ units: { "<profile>#<hash>": ms } }`): the stamp of each unit and the newest
 * per profile, which Exact refreshes from the fingerprint files a build read. Null when the text is not that shape.
 */
function parseSweepLedger(
  text: string,
): { units: Map<string, number>; newest: Map<string, number>; at: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const units = isRecord(parsed) ? parsed.units : undefined;
  if (!isRecord(units)) return null;
  const stamps = new Map<string, number>();
  const newest = new Map<string, number>();
  for (const [key, at] of Object.entries(units)) {
    const profile = key.split('#')[0];
    if (!profile || typeof at !== 'number' || !Number.isFinite(at)) return null;
    stamps.set(key, at);
    newest.set(profile, Math.max(newest.get(profile) ?? 0, at));
  }
  const at = isRecord(parsed) && typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null;
  return { units: stamps, newest, at };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function entriesOf(path: string): Dirent[] | null {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function subdirectories(path: string): Dirent[] | null {
  return entriesOf(path)?.filter((entry) => entry.isDirectory()) ?? null;
}

function fingerprintDir(profile: string): boolean {
  try {
    return lstatSync(join(profile, '.fingerprint')).isDirectory();
  } catch {
    return false;
  }
}

function profilePaths(target: string): { profiles: string[]; extras: Set<string> } | null {
  const profiles: string[] = [];
  const extras = new Set<string>();
  const top = subdirectories(target);
  if (!top) return null;
  for (const first of top) {
    if (NOT_PROFILES.has(first.name)) continue;
    if (fingerprintDir(join(target, first.name))) {
      profiles.push(first.name);
      continue;
    }
    const inner = entriesOf(join(target, first.name));
    if (!inner) return null;
    for (const second of inner) {
      if (second.isDirectory() && fingerprintDir(join(target, first.name, second.name)))
        profiles.push(`${first.name}/${second.name}`);
      else if (second.isDirectory() || !CARGO_TRIPLE_FILES.has(second.name)) extras.add(first.name);
    }
  }
  return { profiles, extras };
}

// @ref LLP 0005#the-size-cap -- modification times only; APFS records no reads
function newestMtime(profile: string): number | null {
  let newest = -Infinity;
  for (const path of [profile, ...PROFILE_PARTS.map((part) => join(profile, part))]) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || path === profile) return null;
    }
  }
  return newest;
}

interface Ledger {
  units: Map<string, number>;
  newest: Map<string, number>;
  at: number | null;
}

const EMPTY_LEDGER: Ledger = { units: new Map(), newest: new Map(), at: null };

function readLedger(target: string): Ledger | { refusal: string } {
  return readLedgerAt(join(target, EXACT_LEDGER));
}

function readLedgerAt(ledgerPath: string): Ledger | { refusal: string } {
  if (!lstatSync(ledgerPath, { throwIfNoEntry: false })) return EMPTY_LEDGER;
  let text: string;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch {
    return { refusal: `Exact's ${ledgerPath} cannot be read` };
  }
  return parseSweepLedger(text) ?? { refusal: `Exact's ${ledgerPath} is not a unit ledger` };
}

/**
 * What of an Exact app's Cargo `target/` no build used for a day, as paths relative to it, or why that cannot be told.
 * A profile is in use when a build wrote its directories or Exact's ledger stamps one of its units that recently; reads
 * leave no trace here, since APFS records an access time only for the first read after a write. Anything unreadable is
 * in use.
 */
export function staleCargoTargetPaths(
  target: string,
  now: number,
  idleMs: number = CARGO_PROFILE_IDLE_MS,
): { paths: string[] } | { refusal: string } {
  const listed = profilePaths(target);
  if (!listed) return { refusal: `${target} cannot be listed` };
  const read = readLedger(target);
  if ('refusal' in read) return read;
  const ledger = read.newest;
  const profiles: CargoProfile[] = listed.profiles.map((path) => {
    const written = newestMtime(join(target, path));
    return { path, lastUsedMs: written === null ? null : Math.max(written, ledger.get(path) ?? 0) };
  });
  return { paths: staleCargoPaths(profiles, listed.extras, now, idleMs) };
}

/** The profile directories of `target/` as absolute paths, or null when it cannot be listed. */
export function cargoProfileDirs(target: string): string[] | null {
  return profilePaths(target)?.profiles.map((path) => join(target, path)) ?? null;
}

const folded = (path: string): string => (FOLD_CASE ? path.toLowerCase() : path);

/**
 * The absolute paths under `target` that `lsof -Fn` lists as open, a working directory or an executable, and `ps`
 * lists in a command line. On a case-insensitive volume the comparison ignores case, since lsof reports the on-disk
 * case and a command line the case the caller typed.
 */
function targetPathsInUse(target: string, lsofNames: string, commandLines: string): string[] {
  const prefix = `${folded(target)}/`;
  const found = new Set<string>();
  for (const line of lsofNames.split('\n')) {
    const name = folded(line.slice(1));
    if (line.startsWith('n') && (name === folded(target) || name.startsWith(prefix))) found.add(name);
  }
  for (const line of commandLines.split('\n')) {
    const text = folded(line);
    for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
      const end = text.slice(at).search(/\s/);
      found.add(end === -1 ? text.slice(at) : text.slice(at, at + end));
    }
  }
  return [...found];
}

/** Whether a path in `used` is `dir` or inside it. */
function inUse(used: readonly string[], dir: string): boolean {
  const name = folded(dir);
  return used.some((path) => path === name || path.startsWith(`${name}/`));
}

/**
 * The paths under `target` a running process executes from or holds open, from one `lsof` and one `ps` read; process
 * evidence that cannot be read keeps everything.
 */
async function readTargetUse(
  target: string,
  signal?: AbortSignal,
  lowPriority = false,
): Promise<{ used: string[] } | { kept: string }> {
  const exec = getExecutor();
  try {
    const run = (file: string, args: string[], timeoutMs: number) =>
      lowPriority
        ? exec.runFileAsync('nice', ['-n', '19', file, ...args], { timeoutMs, signal })
        : exec.runFileAsync(file, args, { timeoutMs, signal });
    const lsof = await run('lsof', ['-nP', '-w', '-Fn'], 60_000);
    const ps = await run('ps', ['-axww', '-o', 'args='], 30_000);
    return { used: targetPathsInUse(target, lsof, ps) };
  } catch {
    signal?.throwIfAborted();
    return { kept: CANNOT_READ };
  }
}

/**
 * The `<profile>/incremental` directories to remove, largest first, until `needBytes` are covered; all of them when
 * they cannot cover it.
 */
function selectIncremental(candidates: readonly { path: string; bytes: number }[], needBytes: number): string[] {
  const chosen: string[] = [];
  let covered = 0;
  for (const { path, bytes } of candidates.toSorted((a, b) => b.bytes - a.bytes)) {
    if (covered >= needBytes) break;
    chosen.push(path);
    covered += bytes;
  }
  return chosen;
}

export interface CargoTrimResult {
  /** Bytes measured before the removal; 0 when the trim did not measure. */
  bytes: number;
  removed: string[];
  kept: string[];
  /** Set when the target's volume was full and the maintenance disk reserve was released before the trim. */
  reserveReleased?: boolean;
}

async function sizeOf(path: string, signal?: AbortSignal, lowPriority = false): Promise<number> {
  return (await measuredDirectorySizeAsync(path, { timeoutMs: 120_000, signal, lowPriority })) ?? 0;
}

/** Whether the remover leaves the file `name` in place: a lock file Cargo or Exact takes, or a Solana keypair. */
const kept = (name: string): boolean => LOCK_FILES.has(name) || isKeypairName(name);

/** What a removal left that is worth reporting: anything but the lock files it always leaves. */
const reported = (left: readonly string[]): string[] =>
  left.filter((path) => !LOCK_FILES.has(basename(path)) && basename(path) !== EXACT_APPLE_LOCKS);

/** Raised under the Cargo locks to stop a trim or delete and keep the rest of the target, with the reason as message. */
class KeepTarget extends Error {}

// @ref LLP 0005#one-remover -- never through a link, never onto another device, never a lock file or a keypair
/**
 * Removes `path` in place, deepest first: a symbolic link is unlinked and never followed, a directory on a device other
 * than `dev` and Exact's `.apple-cargo-locks` are not entered, a lock file Cargo or Exact takes and a `*-keypair.json`
 * (any case) are never unlinked, and a directory goes once it is empty. The contents of a `.fingerprint`
 * go before its siblings, so a build after a delete stopped part way rebuilds every unit and reruns its build scripts,
 * and the emptied `.fingerprint` goes after them, so such a profile is still listed and trimmed again. A path already
 * gone counts as removed. Returns the paths it left because of those rules; a directory a build filled again meanwhile
 * stays too. With `keepDir` a directory's contents go but the directory stays.
 */
async function removeInPlace(path: string, dev: number, signal?: AbortSignal, keepDir = false): Promise<string[]> {
  signal?.throwIfAborted();
  const stat = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return [];
  const name = basename(path);
  if (!stat.isDirectory()) {
    if (kept(name)) return [path];
    await unlink(path).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    return [];
  }
  if (stat.dev !== dev || name === EXACT_APPLE_LOCKS) return [path];
  const names = await readdir(path).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (!names) return [];
  const left: string[] = [];
  if (names.includes(FINGERPRINT)) left.push(...(await removeInPlace(join(path, FINGERPRINT), dev, signal, true)));
  for (const child of names.toSorted((a, b) => Number(a === FINGERPRINT) - Number(b === FINGERPRINT)))
    left.push(...(await removeInPlace(join(path, child), dev, signal)));
  if (left.length || keepDir) return left;
  await rmdir(path).catch((error: unknown) => {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  });
  return [];
}

/** The canonical path and the device and inode of the directory a trim or delete was admitted with. */
export interface AdmittedTarget {
  path: string;
  dev: number;
  ino: number;
}

/** The canonical path and identity of the directory at `registered` now, or why it has none. */
export async function admitCargoTarget(registered: string): Promise<AdmittedTarget | { kept: string }> {
  let path: string;
  try {
    path = realpathSync.native(registered);
  } catch {
    return { kept: `${registered} cannot be resolved to its on-disk path` };
  }
  const stat = await lstat(path).catch(() => null);
  return stat?.isDirectory() ? { path, dev: stat.dev, ino: stat.ino } : { kept: `${registered} is not a directory` };
}

// @ref LLP 0005#one-remover -- one identity check under the locks
/**
 * Throws `KeepTarget` when `registered` no longer names the `admitted` directory: it is not a directory now, is another
 * directory (device and inode), or resolves to another path. Run under the Cargo locks that cover the removal.
 */
async function refuseMoved(registered: string, admitted: AdmittedTarget): Promise<void> {
  const stat = await lstat(registered).catch(() => null);
  if (!stat?.isDirectory()) throw new KeepTarget(`${registered} is no longer a directory, so Stim left it`);
  if (
    stat.dev !== admitted.dev ||
    stat.ino !== admitted.ino ||
    (await realpath(registered).catch(() => null)) !== admitted.path
  )
    throw new KeepTarget(`${registered} is no longer the directory Stim checked, so Stim left it`);
}

/** The lock files of `profile` that exist, or null when it has no `.cargo-lock`, which keeps it. */
function profileLocks(profile: string): string[] | null {
  const locks = PROFILE_LOCKS.map((name) => join(profile, name)).filter(
    (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
  );
  return locks.some((path) => basename(path) === '.cargo-lock') ? locks : null;
}

/**
 * The Cargo lock paths of `target` that exist, whatever they are: in each top-level entry and in each directory directly
 * in one. One that is not a regular file keeps the target in `withCargoLocks`.
 */
function targetLocks(target: string): string[] {
  const locks: string[] = [];
  for (const top of subdirectories(target) ?? []) {
    const dir = join(target, top.name);
    for (const at of [dir, ...(subdirectories(dir) ?? []).map((inner) => join(dir, inner.name))])
      for (const name of PROFILE_LOCKS)
        if (lstatSync(join(at, name), { throwIfNoEntry: false })) locks.push(join(at, name));
  }
  return locks;
}

interface CargoTrimOptions {
  needBytes: number;
  /** The directory the caller admitted (`admitCargoTarget`); the trim keeps the target once `registeredTarget` names another. */
  admitted?: AdmittedTarget;
  incremental?: 'toNeed' | 'all';
  /**
   * Keep the whole target while a process uses any path in it or a build holds any of its Cargo locks, and hold every
   * lock for the whole trim; the size cap at normal pressure. Without it a busy path or profile keeps only itself.
   */
  idleOnly?: boolean;
  /** A profile no build wrote for this long goes whole; default a day. */
  profileIdleMs?: number;
  lowPriority?: boolean;
  now?: number;
  signal?: AbortSignal;
  /** Stops the trim between steps that completed; a step in flight finishes. */
  stop?: AbortSignal;
  /** Whether to walk what is removed to report its bytes; false reports 0. Default true. */
  measure?: boolean;
}

// @ref LLP 0005#the-size-cap -- deleted in place under Cargo's own locks
/**
 * Removes the stale profiles and target triples of `target`, then, while `needBytes` are not covered, the `incremental`
 * directory of each remaining profile, largest first, in place under the profile's Cargo locks, taken exclusively and
 * without waiting. A path a process executes from or holds open stays, and so does a profile whose lock a build holds or
 * that has no `.cargo-lock`; with `idleOnly` either keeps the whole target. Sizes are measured before the locks.
 */
export async function trimCargoTarget(
  registeredTarget: string,
  {
    needBytes,
    incremental = 'toNeed',
    idleOnly = false,
    profileIdleMs = CARGO_PROFILE_IDLE_MS,
    lowPriority = false,
    now = Date.now(),
    signal,
    stop,
    measure = true,
    admitted: given,
  }: CargoTrimOptions,
): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const keep = (why: string): CargoTrimResult => ({ ...result, kept: [...result.kept, why] });
  const admitted = given ?? (await admitCargoTarget(registeredTarget));
  if ('kept' in admitted) return keep(admitted.kept);
  const { path: target, dev } = admitted;
  if (!entriesOf(target)) return keep(`${target} cannot be listed`);
  if (await releaseReserveWhenFull(target)) result.reserveReleased = true;
  const first = await readTargetUse(target, signal, lowPriority);
  if ('kept' in first) return keep(first.kept);
  const { used } = first;
  if (idleOnly && used.length) return keep(`a process uses ${used[0]}, and the cap trims an idle target/ only`);
  const stale = staleCargoTargetPaths(target, now, profileIdleMs);
  if ('refusal' in stale) return keep(stale.refusal);
  const profilesAt = (dir: string): string[] =>
    fingerprintDir(dir) ? [dir] : (subdirectories(dir) ?? []).map((entry) => join(dir, entry.name));
  type Step = { dir: string; label: string; profiles: string[]; bytes: number };
  const steps: Step[] = [];
  for (const path of stale.paths) {
    const dir = join(target, path);
    steps.push({
      dir,
      label: path,
      profiles: profilesAt(dir),
      bytes: measure ? await sizeOf(dir, signal, lowPriority) : 0,
    });
  }
  const planned = steps
    .filter(({ dir, profiles }) => !inUse(used, dir) && profiles.every((profile) => profileLocks(profile)))
    .reduce((sum, { bytes }) => sum + bytes, 0);
  if (incremental === 'all' || planned < needBytes) {
    const gone = stale.paths.map((path) => join(target, path));
    const candidates: { path: string; bytes: number }[] = [];
    for (const profile of cargoProfileDirs(target) ?? []) {
      if (gone.some((path) => profile === path || profile.startsWith(`${path}/`))) continue;
      const dir = join(profile, 'incremental');
      if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (incremental === 'toNeed' && inUse(used, profile)) continue;
      candidates.push({
        path: dir,
        bytes: measure || incremental === 'toNeed' ? await sizeOf(dir, signal, lowPriority) : 0,
      });
    }
    const chosen =
      incremental === 'all' ? candidates.map(({ path }) => path) : selectIncremental(candidates, needBytes - planned);
    for (const path of chosen)
      steps.push({
        dir: path,
        label: path.slice(target.length + 1),
        profiles: [dirname(path)],
        bytes: candidates.find((candidate) => candidate.path === path)?.bytes ?? 0,
      });
  }
  const step = async ({ dir, label, profiles, bytes }: Step): Promise<void> => {
    signal?.throwIfAborted();
    if (inUse(used, dir)) {
      result.kept.push(`${label}: a process uses it`);
      return;
    }
    const locks: string[] = [];
    for (const profile of profiles) {
      const found = profileLocks(profile);
      if (!found) {
        result.kept.push(`${label}: ${basename(profile)} has no .cargo-lock to take`);
        return;
      }
      locks.push(...found);
    }
    const done = await withCargoLocks(
      idleOnly ? [] : locks,
      async () => {
        await refuseMoved(registeredTarget, admitted);
        return removeInPlace(dir, dev, signal);
      },
      signal,
    );
    if ('kept' in done) {
      result.kept.push(`${label}: ${done.kept}`);
      return;
    }
    result.bytes += bytes;
    result.removed.push(label);
    const left = reported(done.value);
    if (left.length) result.kept.push(`${label}: left ${left.join(', ')}`);
  };
  const trim = async (): Promise<void> => {
    for (const next of steps) {
      if (stop?.aborted === true) {
        result.kept.push(DEADLINE_KEPT);
        return;
      }
      await step(next);
    }
  };
  if (!steps.length) return result;
  try {
    if (!idleOnly) {
      await trim();
      return result;
    }
    const held = await withCargoLocks(targetLocks(target), trim, signal);
    return 'kept' in held ? keep(`${held.kept}, and the cap trims an idle target/ only`) : result;
  } catch (error) {
    if (error instanceof KeepTarget) return keep(error.message);
    throw error;
  }
}

/**
 * Why `target` shows use within `idleMs`: a modification time that recent, or one that cannot be read, on the `target/`
 * itself or in a top-level entry (`recentEntryUse`). Null when all of it went unwritten that long.
 */
export function recentTargetUse(target: string, now: number, idleMs: number): string | null {
  const entries = entriesOf(target);
  if (!entries) return `${target} cannot be listed`;
  const root = recentWrite([target], now, idleMs);
  if (root) return root;
  for (const { name } of entries) {
    const why = recentEntryUse(join(target, name), name, now, idleMs);
    if (why) return why;
  }
  return null;
}

function recentWrite(paths: readonly string[], now: number, idleMs: number): string | null {
  for (const path of paths) {
    let written: number;
    try {
      written = lstatSync(path).mtimeMs;
    } catch {
      return `${path} cannot be read`;
    }
    if (now - written <= idleMs) return `${path} was written in that time`;
  }
  return null;
}

/**
 * Why the top-level entry `name` of a target, at `path`, shows use within `idleMs`: its own modification time, each of
 * its direct children's, a profile in it or directly inside it with its `.fingerprint`, `deps`, `build` and
 * `incremental`, or, for Exact's ledger, a unit stamp that recent.
 */
function recentEntryUse(path: string, name: string, now: number, idleMs: number): string | null {
  const inner = lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? entriesOf(path) : [];
  if (!inner) return `${path} cannot be listed`;
  const written = recentWrite([path, ...inner.map((entry) => join(path, entry.name))], now, idleMs);
  if (written) return written;
  if (name === EXACT_LEDGER) {
    const ledger = readLedgerAt(path);
    if ('refusal' in ledger) return ledger.refusal;
    if ([...ledger.newest.values()].some((at) => now - at <= idleMs))
      return "Exact's ledger stamps a unit in that time";
  }
  const profiles = fingerprintDir(path)
    ? [name]
    : inner
        .filter((entry) => entry.isDirectory() && fingerprintDir(join(path, entry.name)))
        .map((entry) => `${name}/${entry.name}`);
  for (const profile of profiles) {
    const used = newestMtime(profile === name ? path : join(path, profile.slice(name.length + 1)));
    if (used === null) return `the last use of its ${profile} profile cannot be read`;
    if (now - used <= idleMs) return `a build used its ${profile} profile in that time`;
  }
  return null;
}

interface DeleteOptions {
  /** How long the target must show no use (`recentTargetUse`); left out by a caller that already found it unused. */
  idleMs?: number;
  signal?: AbortSignal;
}

/** Reads Linux's `/proc/self/mountinfo`, where a bind mount keeps the device number of the volume it exposes. */
export const LINUX_MOUNT_INFO: (() => string) | null =
  process.platform === 'linux' ? () => readFileSync('/proc/self/mountinfo', 'utf8') : null;

/** Why a mount point lies at or under `target` by `mountInfo`, or null when none does. */
export function mountedUnder(target: string, mountInfo: (() => string) | null): string | null {
  if (!mountInfo) return null;
  let text: string;
  try {
    text = mountInfo();
  } catch (error) {
    return `the mounts cannot be read: ${error instanceof Error ? error.message : error}`;
  }
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4];
    if (!field) continue;
    const point = field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (point === target || point.startsWith(`${target}/`)) return `${point} is a mount point`;
  }
  return null;
}

// @ref LLP 0005#the-dormant-reduction-deletes-an-idle-target-whole -- in place under every profile's Cargo locks
/**
 * Deletes everything in `target` the remover may delete, every top-level entry but a symbolic link and a `deploy/`
 * holding a keypair, that holds anything the remover removes (`removableEntries`), in place under all its Cargo locks,
 * once it is still a Cargo `target/` Stim recognises, shows no use within `idleMs` (`recentTargetUse`), and no process
 * uses any path in it. An Exact app's `target/` goes to Exact's cleaner instead (`exactDelete`), and one holding
 * Exact's files (`EXACT_OWNED`) with no Exact app beside it stays. Lock files and keypairs stay, and so does the
 * `target/` while anything is left in it.
 */
export async function deleteCargoTarget(
  registeredTarget: string,
  { idleMs, signal }: DeleteOptions,
): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const keep = (why: string): CargoTrimResult => ({ ...result, kept: [...result.kept, why] });
  if (!(await cargoTargetDirsAsync(dirname(registeredTarget))).includes(registeredTarget))
    return keep('it is no longer a Cargo target/ Stim recognises');
  const admitted = await admitCargoTarget(registeredTarget);
  if ('kept' in admitted) return keep(admitted.kept);
  const { path: target, dev } = admitted;
  const blocked = idleMs === undefined ? null : recentTargetUse(target, Date.now(), idleMs);
  if (blocked) return keep(blocked);
  if (await releaseReserveWhenFull(target)) result.reserveReleased = true;
  const names = await removableEntries(target);
  if (!names) return keep(`${target} cannot be listed`);
  if (!names.length) return result;
  const first = await readTargetUse(target, signal);
  if ('kept' in first) return keep(first.kept);
  if (first.used.length) return keep(`a process uses ${first.used[0]}`);
  const app = dirname(target);
  if (isExactApp(app)) return exactDelete(app, target, result, signal);
  const exactOwned = EXACT_OWNED.find((name) => lstatSync(join(target, name), { throwIfNoEntry: false }));
  if (exactOwned)
    return keep(`it holds Exact's ${exactOwned} but no Exact app beside it, so it may be shared by Exact apps`);
  const bytes = new Map<string, number>();
  for (const name of names) bytes.set(name, await sizeOf(join(target, name), signal));
  let done: Awaited<ReturnType<typeof withCargoLocks<string[]>>>;
  try {
    done = await withCargoLocks(
      targetLocks(target),
      async () => {
        await refuseMoved(registeredTarget, admitted);
        const left: string[] = [];
        for (const name of names) left.push(...(await removeInPlace(join(target, name), dev, signal)));
        return left;
      },
      signal,
    );
  } catch (error) {
    if (error instanceof KeepTarget) return keep(error.message);
    throw error;
  }
  if ('kept' in done) return keep(done.kept);
  result.removed.push(...names);
  result.bytes = names.reduce((sum, name) => sum + (bytes.get(name) ?? 0), 0);
  const left = reported(done.value);
  if (left.length) result.kept.push(`left ${left.join(', ')}`);
  await rmdir(target).catch(() => {});
  return result;
}

/** When Exact's cleaner last kept each target without removing anything, so a pass within a day does not ask again. */
const exactKeptAt = new Map<string, number>();

// @ref LLP 0005#exact-apps-clean-through-exact -- Stim checks the app is idle, Exact decides what goes
/**
 * Hands the idle Exact app `app`'s `target/` (`target`, canonical) to Exact's cleaner, once no process runs from or
 * works in the app: a dev server or a running app holds no lock Exact could see. An unsupported checkout, or a busy
 * or refused clean, keeps the target. A dry run first lists what goes, which Stim measures; the
 * clean then removes it all or nothing. A failed clean, or one that ends without a report, throws: what it removed is
 * not known. A keep without a removal is not asked again for a day.
 */
async function exactDelete(
  app: string,
  target: string,
  result: CargoTrimResult,
  signal?: AbortSignal,
): Promise<CargoTrimResult> {
  const keep = (why: string): CargoTrimResult => ({ ...result, kept: [...result.kept, why] });
  const asked = exactKeptAt.get(target);
  if (asked !== undefined && Date.now() - asked < CARGO_PROFILE_IDLE_MS)
    return keep(
      `Exact's cleaner kept it ${Math.round((Date.now() - asked) / 60_000)} minutes ago; Stim asks again after a day`,
    );
  const keptByExact = (why: string): CargoTrimResult => {
    exactKeptAt.set(target, Date.now());
    return keep(why);
  };
  const running = runningFromReason(app, await othersRunningAsync(await readRunningProcessesAsync(signal), signal));
  if (running) return keep(`its app may be in use: ${running.replace(/ it\b/, ' its app')}`);
  const options = signal ? { signal } : {};
  const planned = await exactClean(app, { ...options, dryRun: true });
  if (!('status' in planned) || planned.status !== 'ok') return keptByExact(exactKept(planned));
  if (!planned.remove.length) return keptByExact("Exact's cleaner lists nothing its builds remake");
  const sizes = new Map<string, number>();
  for (const path of planned.remove) sizes.set(path, await sizeOf(path, signal));
  const report = await exactClean(app, options);
  if ('unknown' in report || ('status' in report && report.status === 'failed'))
    throw new Error(
      'unknown' in report
        ? `${exactKept(report)}; what it removed is not known`
        : `${exactKept(report)}; it had removed ${report.remove.length ? report.remove.join(', ') : 'nothing'}`,
    );
  if ('unsupported' in report || report.status === 'busy' || report.status === 'refused')
    return keptByExact(exactKept(report));
  exactKeptAt.delete(target);
  result.removed.push(
    ...report.remove.map((path) => (path.startsWith(`${target}/`) ? path.slice(target.length + 1) : path)),
  );
  result.bytes = report.remove.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
  return result;
}
