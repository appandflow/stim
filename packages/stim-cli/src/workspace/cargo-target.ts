import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { releaseReserveWhenFull } from '../disk-reserve.ts';
import { getExecutor } from '../exec.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { withCargoLocks } from './cargo-lock.ts';
import { cargoTargetDirsAsync } from './regenerable-dirs.ts';

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
const OWN_PREFIX = '.stim-';
const ASIDE = `${OWN_PREFIX}trimmed`;
const NOT_RESTORED = `${OWN_PREFIX}not-restored-`;
const CANNOT_READ = 'the files processes hold open cannot be read';
const DEADLINE_KEPT = 'the rest was left at the build headroom deadline';
/** Solana's `cargo build-sbf` and Anchor keep each program's private key in `deploy/<program>-keypair.json`. */
const KEYPAIR_DIR = 'deploy';
const isKeypairDir = (name: string): boolean => name.toLowerCase() === KEYPAIR_DIR;
const isKeypairName = (name: string): boolean => name.toLowerCase().endsWith('-keypair.json');

/**
 * The top-level entries of `target` the dormant delete removes (`output`), and those it keeps (`kept`): a symbolic link,
 * which a delete must not go through, a `deploy/` directory holding a `*-keypair.json`, both names in any letter case,
 * and Cargo's `CACHEDIR.TAG`, which Cargo writes only when it creates the `target/` and by which Stim recognises it. A `deploy` that is a symbolic link, or holds one, keeps every entry, since Stim cannot tell what of the target
 * holds the keys it points at. Stim's own `.stim-*`
 * entries are in neither. Null when `target` cannot be listed.
 */
export function targetEntries(target: string): { output: string[]; kept: string[] } | null {
  const entries = entriesOf(target);
  if (!entries) return null;
  const output: string[] = [];
  const kept: string[] = [];
  const linkedKeypairs = entries.some(
    (entry) =>
      isKeypairDir(entry.name) &&
      (entry.isSymbolicLink() ||
        (entry.isDirectory() && (entriesOf(join(target, entry.name)) ?? []).some((inner) => inner.isSymbolicLink()))),
  );
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(OWN_PREFIX)) continue;
    if (linkedKeypairs) {
      kept.push(entry.name);
      continue;
    }
    const keypairs = isKeypairDir(entry.name) && entry.isDirectory() && holdsKeypair(join(target, entry.name));
    (entry.isSymbolicLink() || keypairs || entry.name === CACHEDIR_TAG ? kept : output).push(entry.name);
  }
  return { output, kept };
}

/**
 * The top-level entries of `target` the dormant delete would remove something from: `targetEntries`' output but an
 * entry that holds only what the delete leaves (lock files, keypairs and links). Null when `target` cannot be listed.
 */
export async function removableEntries(target: string): Promise<string[] | null> {
  const entries = targetEntries(target);
  if (!entries) return null;
  const output: string[] = [];
  for (const name of entries.output) if (!(await leftAlone(join(target, name)))) output.push(name);
  return output;
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

/** Whether the directory at `path` holds a `*-keypair.json` in any letter case or a symbolic link, or cannot be read to tell. */
function holdsKeypair(path: string): boolean {
  const entries = entriesOf(path);
  return !entries || entries.some((entry) => entry.isSymbolicLink() || isKeypairName(entry.name));
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
    if (NOT_PROFILES.has(first.name) || first.name.startsWith(OWN_PREFIX)) continue;
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

/** Throws `KeepTarget` unless the parent of `path`, built from the canonical target, is still its own canonical path. */
async function stillInside(path: string): Promise<void> {
  const parent = dirname(path);
  if ((await realpath(parent).catch(() => null)) !== parent)
    throw new KeepTarget(`${parent} is no longer a directory inside the target/, so the delete stopped`);
}

// @ref LLP 0005#one-remover -- never through a link, never onto another device, never a lock file or a keypair
/**
 * Removes `path` in place, deepest first: a symbolic link is unlinked and never followed, a directory on a device other
 * than `dev` and Exact's `.apple-cargo-locks` are not entered, a lock file Cargo or Exact takes and a `*-keypair.json`
 * (any case) are never unlinked, and a directory goes once it is empty. Right before each unlink and each directory
 * removal its parent must still resolve to itself, or `KeepTarget` stops the delete. The contents of a `.fingerprint`
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
    await stillInside(path);
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
  await stillInside(path);
  await rmdir(path).catch((error: unknown) => {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  });
  return [];
}

/**
 * Why the whole of `target` stays because of a symbolic link a Solana key may stand behind, found at any depth without
 * following links: one named `deploy` or `*-keypair.json`, or one directly in a `deploy` directory, all in any letter
 * case. A directory that cannot be listed keeps it too; one a build removed meanwhile, or one on a device other than
 * `dev`, is skipped. Stops with `DEADLINE_KEPT` once `stop` fires. Null when there is none.
 */
async function keypairLink(
  target: string,
  dev: number,
  signal?: AbortSignal,
  stop?: AbortSignal,
): Promise<string | null> {
  const queue = [target];
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    signal?.throwIfAborted();
    if (stop?.aborted === true) return DEADLINE_KEPT;
    if ((await lstat(dir).catch(() => null))?.dev !== dev) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue;
      return `${dir} cannot be listed to look for keypair links`;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (
        entry.isSymbolicLink() &&
        (isKeypairName(entry.name) || isKeypairDir(entry.name) || isKeypairDir(basename(dir)))
      )
        return `${path} is a symbolic link where Solana keeps a keypair, so the whole target/ stays`;
    }
  }
  return null;
}

/** Why the admitted `registered` path no longer leads to the canonical `target`: it is not a directory now, or resolves elsewhere. */
async function rootMoved(registered: string, target: string): Promise<string | null> {
  if (!(await lstat(registered).catch(() => null))?.isDirectory())
    return `${registered} is no longer a directory, so the delete stopped`;
  return (await realpath(registered).catch(() => null)) === target
    ? null
    : `${registered} no longer resolves to ${target}, so the delete stopped`;
}

/** Throws `KeepTarget` when `keypairLink` finds a link; run under the Cargo locks that cover the delete. */
async function refuseKeypairLink(target: string, dev: number, signal?: AbortSignal, stop?: AbortSignal): Promise<void> {
  const link = await keypairLink(target, dev, signal, stop);
  if (link) throw new KeepTarget(link);
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

// @ref LLP 0005#leftovers-of-the-staged-trim -- a person decides what happens to them
/**
 * Why `target` stays out of every trim and delete: it holds a leftover of an earlier engine's staging (`.stim-trimmed` or
 * `.stim-not-restored-*`), which Stim no longer deletes. Null when it holds none or cannot be listed.
 */
export function leftoverReason(target: string): string | null {
  const leftover = entriesOf(target)?.find((entry) => entry.name === ASIDE || entry.name.startsWith(NOT_RESTORED));
  return leftover
    ? `${join(target, leftover.name)} is a leftover of an earlier Stim's trim; delete it, or move what you need out of it, and the next pass trims this target/ again`
    : null;
}

/** Why `target` stays whole: a leftover (`leftoverReason`), another filesystem mounted at or under it on Linux, or it cannot be listed. */
function wholeTargetReason(target: string, mountInfo: (() => string) | null): string | null {
  if (!entriesOf(target)) return `${target} cannot be listed`;
  return leftoverReason(target) ?? mountedUnder(target, mountInfo);
}

interface CargoTrimOptions {
  needBytes: number;
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
  mountInfo?: (() => string) | null;
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
    mountInfo = LINUX_MOUNT_INFO,
  }: CargoTrimOptions,
): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const keep = (why: string): CargoTrimResult => ({ ...result, kept: [...result.kept, why] });
  let target: string;
  try {
    target = realpathSync.native(registeredTarget);
  } catch {
    return keep(`${registeredTarget} cannot be resolved to its on-disk path`);
  }
  const whole = wholeTargetReason(target, mountInfo);
  if (whole) return keep(whole);
  if (await releaseReserveWhenFull(target)) result.reserveReleased = true;
  const { dev } = await lstat(target);
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
        await refuseKeypairLink(target, dev, signal, stop);
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
 * itself or in a top-level entry other than Stim's own (`recentEntryUse`). Null when all of it went unwritten that long.
 */
export function recentTargetUse(target: string, now: number, idleMs: number): string | null {
  const entries = entriesOf(target);
  if (!entries) return `${target} cannot be listed`;
  const root = recentWrite([target], now, idleMs);
  if (root) return root;
  for (const { name } of entries) {
    if (name.startsWith(OWN_PREFIX)) continue;
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
  /**
   * Reads Linux's `/proc/self/mountinfo`, where a bind mount keeps the device number of the volume it exposes, so the
   * `st_dev` checks cannot see it; null where there is no such file. Defaults to the real file on Linux.
   */
  mountInfo?: (() => string) | null;
}

const LINUX_MOUNT_INFO = process.platform === 'linux' ? () => readFileSync('/proc/self/mountinfo', 'utf8') : null;

/** Why a mount point lies at or under `target` by `mountInfo`, or null when none does. */
function mountedUnder(target: string, mountInfo: (() => string) | null): string | null {
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
 * Deletes everything in `target` the remover may delete, every top-level entry but a symbolic link and a `deploy` that
 * is or holds one, that holds anything the remover removes (`removableEntries`), in place under all its Cargo locks, once it is still a Cargo `target/` Stim
 * recognises, shows no use within `idleMs` (`recentTargetUse`), has no other filesystem mounted inside or a leftover of
 * an earlier engine's staging, no process uses any path in it and no build holds an Exact lock file in it. Lock files
 * and keypairs stay, and so does the `target/` while anything is left in it.
 */
export async function deleteCargoTarget(
  registeredTarget: string,
  { idleMs, signal, mountInfo = LINUX_MOUNT_INFO }: DeleteOptions,
): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const keep = (why: string): CargoTrimResult => ({ ...result, kept: [...result.kept, why] });
  if (!(await cargoTargetDirsAsync(dirname(registeredTarget))).includes(registeredTarget))
    return keep('it is no longer a Cargo target/ Stim recognises');
  let target: string;
  try {
    target = realpathSync.native(registeredTarget);
  } catch {
    return keep(`${registeredTarget} cannot be resolved to its on-disk path`);
  }
  const moved = await rootMoved(registeredTarget, target);
  if (moved) return keep(moved);
  const blocked =
    wholeTargetReason(target, mountInfo) ?? (idleMs === undefined ? null : recentTargetUse(target, Date.now(), idleMs));
  if (blocked) return keep(blocked);
  if (await releaseReserveWhenFull(target)) result.reserveReleased = true;
  const { dev } = await lstat(target);
  const names = await removableEntries(target);
  if (!names) return keep(`${target} cannot be listed`);
  if (!names.length) return result;
  const walked = await walkEntries(
    names.map((name) => join(target, name)),
    dev,
  );
  if (walked.mount) return keep(`${walked.mount} is another filesystem`);
  const fresh = idleMs === undefined ? null : writtenWithin(walked.newest, Date.now(), idleMs);
  if (fresh) return keep(`${fresh} holds a file written in that time`);
  const first = await readTargetUse(target, signal);
  if ('kept' in first) return keep(first.kept);
  if (first.used.length) return keep(`a process uses ${first.used[0]}`);
  const exactHeld = await heldExactLock(target, signal);
  if (exactHeld) return keep(`a build holds ${exactHeld}`);
  let done: Awaited<ReturnType<typeof withCargoLocks<string[]>>>;
  try {
    done = await withCargoLocks(
      targetLocks(target),
      async () => {
        const movedSince = await rootMoved(registeredTarget, target);
        if (movedSince) throw new KeepTarget(movedSince);
        await refuseKeypairLink(target, dev, signal);
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
  result.bytes = names.reduce((sum, name) => sum + (walked.bytes.get(join(target, name)) ?? 0), 0);
  const left = reported(done.value);
  if (left.length) result.kept.push(`left ${left.join(', ')}`);
  await rmdir(target).catch(() => {});
  return result;
}

/** The lock files Exact takes in a top-level entry of a target: `.exact-sweep.json.lock`, and those under `.apple-cargo-locks`. */
function exactLockFiles(path: string, name: string): string[] {
  if (name === `${EXACT_LEDGER}.lock`) return [path];
  if (name !== EXACT_APPLE_LOCKS) return [];
  const files: string[] = [];
  for (const entry of entriesOf(path) ?? []) {
    const inner = join(path, entry.name);
    if (entry.isFile()) files.push(inner);
    else if (entry.isDirectory())
      for (const file of entriesOf(inner) ?? []) if (file.isFile()) files.push(join(inner, file.name));
  }
  return files;
}

/** The lock file of Exact's at the top of `target` a process holds, which keeps the whole target. */
async function heldExactLock(target: string, signal?: AbortSignal): Promise<string | null> {
  for (const name of [`${EXACT_LEDGER}.lock`, EXACT_APPLE_LOCKS])
    for (const file of exactLockFiles(join(target, name), name)) if (await fileHeld(file, signal)) return file;
  return null;
}

/** Whether a process holds `file` open, from `lsof -t`: output names a holder, and anything but a clean no-match holds. */
async function fileHeld(file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return (await getExecutor().runFileAsync('lsof', ['-t', '--', file], { timeoutMs: 5000, signal })).trim() !== '';
  } catch (error) {
    signal?.throwIfAborted();
    return !(isRecord(error) && error.status === 1 && (error.stdout === '' || error.stdout === undefined));
  }
}

/**
 * One walk of `paths`, never through a symbolic link: the first directory on a device other than `dev` (`mount`), the
 * newest modification time of anything in each of `paths` (`newest`), and the bytes each holds (`bytes`).
 */
async function walkEntries(
  paths: readonly string[],
  dev: number,
): Promise<{ mount: string | null; newest: Map<string, number>; bytes: Map<string, number> }> {
  const newest = new Map<string, number>();
  const bytes = new Map<string, number>();
  const queue = paths.map((path) => ({ path, top: path }));
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const { path, top } = item;
    const stat = await lstat(path);
    newest.set(top, Math.max(newest.get(top) ?? 0, stat.mtimeMs));
    bytes.set(top, (bytes.get(top) ?? 0) + stat.blocks * 512);
    if (!stat.isDirectory()) continue;
    if (stat.dev !== dev) return { mount: path, newest, bytes };
    for (const entry of await readdir(path, { withFileTypes: true })) queue.push({ path: join(path, entry.name), top });
  }
  return { mount: null, newest, bytes };
}

/** The first of `newest`'s entries whose newest time is within `idleMs` of `now`. */
function writtenWithin(newest: Map<string, number>, now: number, idleMs: number): string | null {
  for (const [path, at] of newest) if (now - at <= idleMs) return path;
  return null;
}
