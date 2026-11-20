import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { cargoTargetTrimClaims } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { diskFull, retryWithReserve } from '../disk-reserve.ts';
import { getExecutor } from '../exec.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { withCargoLocks } from './cargo-lock.ts';
import { cargoTargetDirsAsync } from './regenerable-dirs.ts';
import { cargoUnitPaths, cargoUnitWasRead, idleCargoUnits, readCargoUnits, removalOrder } from './cargo-units.ts';

const CARGO_PROFILE_IDLE_MS: number = 24 * 3_600_000;

/** Why a staging write found the disk full and the checks made after releasing the reserve keep the entry. */
class KeptAfterRelease extends Error {
  /** Whether the reason keeps the whole target, as unreadable process evidence does. */
  readonly whole: boolean;
  constructor(message: string, whole = false) {
    super(message);
    this.whole = whole;
  }
}
const ASIDE = '.stim-trimmed';
const PROFILE_PARTS = ['.fingerprint', 'deps', 'build', 'incremental'];
/** The files Cargo itself writes in a target triple directory; any other entry there belongs to something else. */
const CARGO_TRIPLE_FILES = new Set(['CACHEDIR.TAG', '.rustc_info.json', '.cargo-lock']);
/** Cargo 1.97 locks the build and artifact directories separately and takes .cargo-lock for older Cargo. */
const PROFILE_LOCKS = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];
const UNIT_CHUNK = 25;
const EXACT_LEDGER = '.exact-sweep.json';
const EXACT_APPLE_LOCKS = '.apple-cargo-locks';
const NOT_PROFILES = new Set(['.exact-swept']);
const OWN_PREFIX = '.stim-';
const STRANDED = 'NOT-RESTORED';
const CANNOT_READ = 'the files processes hold open or the executables on PATH cannot be read';
const DEADLINE_KEPT = 'the rest was left at the build headroom deadline';
const NOT_RESTORED = `${OWN_PREFIX}not-restored-`;
const STAGED_LEFT = 'what was staged stays in its .stim-trimmed, marked NOT-RESTORED, for a person';
/** Solana's `cargo build-sbf` and Anchor keep each program's private key in `deploy/<program>-keypair.json`. */
const KEYPAIR_DIR = 'deploy';
const isKeypairDir = (name: string): boolean => name.toLowerCase() === KEYPAIR_DIR;
export const isKeypairName = (name: string): boolean => name.toLowerCase().endsWith('-keypair.json');

/**
 * The first `*-keypair.json` in any letter case under the directory `dir`, relative to it, never through a symbolic
 * link, or null when there is none. Throws when a directory in it cannot be read.
 */
export async function keypairUnder(dir: string, signal?: AbortSignal): Promise<string | null> {
  const queue = [''];
  for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
    signal?.throwIfAborted();
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) queue.push(child);
      else if (isKeypairName(entry.name)) return child;
    }
  }
  return null;
}

/**
 * The top-level entries of `target` the dormant delete removes (`output`), and those it keeps (`kept`): a symbolic link,
 * which a delete must not go through, and a `deploy/` directory holding a `*-keypair.json`, both names in any letter
 * case. A `deploy` that is a symbolic link, or holds one, keeps every entry, since Stim cannot tell what of the target
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
    (entry.isSymbolicLink() || keypairs ? kept : output).push(entry.name);
  }
  return { output, kept };
}

/**
 * The top-level entries of `target` the dormant delete would remove: `targetEntries`' output but an entry holding a
 * `*-keypair.json` at any depth, and a `.stim-trimmed` staging directory an earlier delete committed but did not finish
 * removing. Null when `target` cannot be listed.
 */
export async function removableEntries(target: string): Promise<string[] | null> {
  const entries = targetEntries(target);
  if (!entries) return null;
  const walked = await walkEntries(
    entries.output.map((name) => join(target, name)),
    lstatSync(target).dev,
  ).catch(() => null);
  const output = entries.output.filter((name) => !walked?.keypairs.has(join(target, name)));
  return lstatSync(join(target, ASIDE), { throwIfNoEntry: false })?.isDirectory() ? [...output, ASIDE] : output;
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

/** A ledger whose own time is older than this no longer shows use: Exact's sweep stopped recording it. */
const LEDGER_FRESH_MS = 3 * 24 * 3_600_000;

function ledgerShowsUse(ledger: Ledger | { refusal: string }, now: number): boolean {
  return !('refusal' in ledger) && ledger.units.size > 0 && ledger.at !== null && now - ledger.at <= LEDGER_FRESH_MS;
}

function readLedger(target: string): Ledger | { refusal: string } {
  return readLedgerAt(join(target, EXACT_LEDGER));
}

function readLedgerAt(ledgerPath: string): Ledger | { refusal: string } {
  if (!existsSync(ledgerPath)) return EMPTY_LEDGER;
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

/**
 * The units Exact's ledger shows no build used for a day in every profile of `target/` outside `skip`, as absolute
 * paths: a unit's fingerprint directory, build-script directory and `deps` files. The newest unit of each crate is never
 * among them, and a target without that ledger has none.
 */
export function idleCargoUnitPaths(target: string, now: number, skip: readonly string[] = []): string[] {
  const ledger = readLedger(target);
  if (!ledgerShowsUse(ledger, now) || 'refusal' in ledger) return [];
  const stamps = ledger.units;
  const found: string[] = [];
  for (const profile of cargoProfileDirs(target) ?? []) {
    if (skip.some((gone) => profile === gone || profile.startsWith(`${gone}/`))) continue;
    const units = readCargoUnits(profile, stamps, profile.slice(target.length + 1), now);
    if (!units) continue;
    for (const [, paths] of cargoUnitPaths(profile, idleCargoUnits(units, now, CARGO_PROFILE_IDLE_MS)))
      found.push(...paths.map((path) => join(profile, path)));
  }
  return found;
}

/** The profile directories of `target/` as absolute paths, or null when it cannot be listed. */
export function cargoProfileDirs(target: string): string[] | null {
  return profilePaths(target)?.profiles.map((path) => join(target, path)) ?? null;
}

type LsofOutcome = ({ stdout: string } | { status: unknown; stdout: unknown }) & { file?: string };

/** Whether a process holds a file open, from an lsof run: output names a holder, and anything but a clean no-match holds. */
function lockHeld(outcome: LsofOutcome): boolean {
  if ('status' in outcome) return !(outcome.status === 1 && (outcome.stdout === '' || outcome.stdout === undefined));
  return outcome.stdout.trim().length > 0;
}

/**
 * Whether a rename of a profile that passed the lock check stands: it is rolled back when a Cargo build holds the
 * profile's lock files after the move, or when that cannot be told.
 */
function renameStands(afterMove: LsofOutcome): boolean {
  return !lockHeld(afterMove);
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

async function lockOutcome(profile: string, signal?: AbortSignal, lowPriority = false): Promise<LsofOutcome> {
  for (const name of PROFILE_LOCKS) {
    const lock = join(profile, name);
    if (!existsSync(lock)) continue;
    let outcome: LsofOutcome;
    try {
      const exec = getExecutor();
      outcome = {
        stdout: await (lowPriority
          ? exec.runFileAsync('nice', ['-n', '19', 'lsof', '-t', '--', lock], { timeoutMs: 5000, signal })
          : exec.runFileAsync('lsof', ['-t', '--', lock], { timeoutMs: 5000, signal })),
      };
    } catch (error) {
      outcome = isRecord(error) ? { status: error.status, stdout: error.stdout } : { status: null, stdout: null };
    }
    if (lockHeld(outcome)) return { ...outcome, file: name };
  }
  return { stdout: '' };
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

export interface CargoTrimResult {
  /** Bytes moved aside, which are freed once the delete at the end succeeds. */
  bytes: number;
  removed: string[];
  kept: string[];
  /** Why the final delete failed; what was moved aside stays under `target/.stim-trimmed` for the next pass. */
  deleteError?: string;
  /** Set when a write found the disk full and the maintenance disk reserve was released to retry it. */
  reserveReleased?: boolean;
}

async function sizeOf(path: string, signal?: AbortSignal, lowPriority = false): Promise<number> {
  return (await measuredDirectorySizeAsync(path, { timeoutMs: 120_000, signal, lowPriority })) ?? 0;
}

/**
 * Removes the stale profiles of `target`, then, while `needBytes` are not covered, the `incremental` directory of each
 * remaining profile, largest first. A directory is renamed into `target/.stim-trimmed` after its lock check, so a build
 * that starts meanwhile makes a fresh one, and the lock is read again at the new path: a build that took it in between
 * gets the directory back. Nothing slow runs between the check and the rename. A path a process executes from or holds
 * open, and a profile whose lock file (`.cargo-lock`, `.cargo-build-lock` or `.cargo-artifact-lock`) a build holds, stays.
 */
export async function trimCargoTarget(registeredTarget: string, options: CargoTrimOptions): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const claimed = await withTrimClaim(registeredTarget, (target) => trimClaimed(target, options));
  const done = 'kept' in claimed ? { ...result, kept: [claimed.kept] } : claimed.value;
  return claimed.released ? { ...done, reserveReleased: true } : done;
}

async function withTrimClaim<T>(
  registeredTarget: string,
  run: (target: string) => Promise<T>,
): Promise<({ value: T } | { kept: string }) & { released: boolean }> {
  let released = false;
  let target: string;
  try {
    target = realpathSync.native(registeredTarget);
  } catch {
    return { kept: `${registeredTarget} cannot be resolved to its on-disk path`, released };
  }
  // @ref LLP 0005#never-delete-what-a-build-took-back -- one trim of a target at a time across processes
  let claim: ClaimHandle | null | undefined;
  try {
    // @ref LLP 0005#a-full-disk-releases-the-reserve -- the claim is a write too
    const attempt = await retryWithReserve(
      async () =>
        tryAcquireClaim({
          root: cargoTargetTrimClaims(target),
          mode: 'exclusive',
          label: 'Cargo target trim',
          details: { target },
        }),
      () => {
        released = true;
      },
    );
    if (attempt.pending) releaseClaim(attempt.pending);
    claim = attempt.acquired;
    if (!claim) {
      const holder = attempt.held;
      return {
        kept: `another trim of it holds ${holder?.path ?? 'its claim'}${holder ? ` (pid ${holder.owner.pid})` : ''}`,
        released,
      };
    }
  } catch (error) {
    return { kept: `its trim claim cannot be taken: ${error instanceof Error ? error.message : error}`, released };
  }
  try {
    return { value: await run(target), released };
  } finally {
    releaseClaim(claim);
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
 * Why the top-level entry `name` of a target, now at `path`, shows use within `idleMs`: its own modification time, each
 * of its direct children's, a profile in it or directly inside it with its `.fingerprint`, `deps`, `build` and
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

/**
 * Deletes `target` under its trim claim, every top-level entry but a Solana keypair folder and a symbolic link
 * (`targetEntries`), once it is still a Cargo `target/` Stim recognises, holds no copy a trim could not put back, shows
 * no use within `idleMs` (`recentTargetUse`), has no other filesystem mounted inside, no process uses any path in it
 * and no build holds a Cargo or Exact lock file in it. Each entry is renamed into `target/.stim-trimmed`, its locks are
 * read again at the new path, and once all are moved the processes are read again: a lock taken or any path in the
 * target used meanwhile puts every entry back. The moved entries are then deleted without crossing into another
 * filesystem, and the `target/` goes too when nothing is left in it.
 */
export async function deleteCargoTarget(registeredTarget: string, options: DeleteOptions): Promise<CargoTrimResult> {
  const claimed = await withTrimClaim(registeredTarget, async (target): Promise<CargoTrimResult> =>
    (await cargoTargetDirsAsync(dirname(registeredTarget), { staged: true })).includes(registeredTarget)
      ? deleteClaimed(target, options)
      : { bytes: 0, removed: [], kept: ['it is no longer a Cargo target/ Stim recognises'] },
  );
  const done = 'kept' in claimed ? { bytes: 0, removed: [], kept: [claimed.kept] } : claimed.value;
  return claimed.released ? { ...done, reserveReleased: true } : done;
}

interface DeleteOptions {
  idleMs: number;
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

async function deleteClaimed(
  target: string,
  { idleMs, signal, mountInfo = LINUX_MOUNT_INFO }: DeleteOptions,
): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const keep = (why: string): CargoTrimResult => ({ ...result, kept: [...result.kept, why] });
  // @ref LLP 0005#the-dormant-reduction-deletes-an-idle-target-whole -- never into another filesystem or a bind mount
  const blocked =
    recoveryReason(target) ?? recentTargetUse(target, Date.now(), idleMs) ?? mountedUnder(target, mountInfo);
  if (blocked) return keep(blocked);
  const { dev, ino, atime, mtime } = await lstat(target);
  const sameTarget = async (): Promise<boolean> => {
    const now = await lstat(target).catch(() => null);
    return now?.isDirectory() === true && now.dev === dev && now.ino === ino;
  };
  const replaced = `${target} was replaced during the delete`;
  const keepTimes = () => utimes(target, atime, mtime).catch(() => {});
  const aside = join(target, ASIDE);
  const entries = targetEntries(target);
  if (!entries) return keep(`${target} cannot be listed`);
  // @ref LLP 0005#the-dormant-reduction-deletes-an-idle-target-whole -- everything goes but a Solana keypair folder
  const committed = lstatSync(aside, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!entries.output.length && !committed) return result;
  const walked = await walkEntries(
    [...entries.output.map((name) => join(target, name)), ...(committed ? [aside] : [])],
    dev,
  );
  if (walked.mount) return keep(`${walked.mount} is another filesystem`);
  if (walked.keypairs.has(aside)) return keep(`${aside} holds a Solana keypair`);
  const fresh = writtenWithin(walked.newest, Date.now(), idleMs, aside);
  if (fresh) return keep(`${fresh} holds a file written in that time`);
  const keyed = entries.output.filter((name) => walked.keypairs.has(join(target, name)));
  const names = entries.output.filter((name) => !keyed.includes(name));
  const first = await readTargetUse(target, signal);
  if ('kept' in first) return keep(first.kept);
  if (first.used.length) return keep(`a process uses ${first.used[0]}`);
  for (const name of names) {
    signal?.throwIfAborted();
    const dir = join(target, name);
    const held = await heldLock(dir, name, signal);
    if (held) return keep(`a build holds ${held}`);
  }
  const exactHeld = await heldExactLock(target, signal);
  if (exactHeld) return keep(`a build holds ${exactHeld}`);
  if (committed) {
    const leftover = await removeOnDevice(aside, dev);
    if (leftover.length) return keep(`${leftover[0]} is another filesystem`);
    result.removed.push(ASIDE);
  }
  if (!names.length) {
    await rmdir(target).catch(keepTimes);
    return result;
  }
  type Entry = { dir: string; there: string; name: string };
  const moved: Entry[] = [];
  const unmoved = [...entries.kept, ...keyed];
  const marker = join(aside, STRANDED);
  let strandThrew = false;
  const putBackAll = async (why: string, written = false): Promise<CargoTrimResult> => {
    const stranded: string[] = [];
    let marked = false;
    for (let entry = moved.pop(); entry !== undefined; entry = moved.pop()) {
      const back = await restoreOrStrand(target, entry.there, entry.dir, moved.length, released).catch(
        (error: unknown) => {
          strandThrew = true;
          throw error;
        },
      );
      marked ||= back.marked;
      if (back.home !== entry.dir) stranded.push(back.home);
    }
    const left = stranded.length
      ? `; ${stranded.join(', ')} could not be put back and stay for a person to merge or delete`
      : '';
    if (!marked && !strandThrew) {
      await rm(marker, { force: true });
      await rmdir(aside).catch(() => {});
      if (!written) await keepTimes();
    }
    return { ...result, bytes: 0, kept: [...result.kept, `${why}${left}`] };
  };
  const released = (): void => {
    result.reserveReleased = true;
  };
  try {
    // @ref LLP 0005#a-full-disk-releases-the-reserve -- staging retries once after the reserve is released
    await retryWithReserve(async () => {
      if (!(await sameTarget())) throw new KeptAfterRelease(replaced);
      await mkdir(aside);
    }, released);
  } catch (error) {
    if (error instanceof KeptAfterRelease) return keep(error.message);
    return keep(`${aside} cannot be made: ${error instanceof Error ? error.message : error}`);
  }
  // @ref LLP 0005#never-delete-what-a-build-took-back -- staged entries carry the NOT-RESTORED marker until the checks pass
  try {
    await retryWithReserve(async () => {
      if (!(await sameTarget())) throw new KeptAfterRelease(replaced);
      const file = await open(marker, 'wx');
      let ours: { dev: number; ino: number } | undefined;
      let failure: unknown;
      try {
        ours = await file.stat();
        await file.writeFile(
          `${JSON.stringify(Object.fromEntries(names.map((name, n) => [String(n), name])), null, 2)}\n`,
        );
      } catch (error) {
        failure = error;
      } finally {
        await file.close().catch((error: unknown) => {
          failure ??= error;
        });
      }
      if (failure === undefined) return;
      const now = ours && (await lstat(marker).catch(() => null));
      if (ours && now?.dev === ours.dev && now.ino === ours.ino) await unlink(marker).catch(() => {});
      throw failure;
    }, released);
  } catch (error) {
    await rmdir(aside).catch(() => {});
    if (error instanceof KeptAfterRelease) return keep(error.message);
    if (errorCode(error) === 'EEXIST') return keep(`${marker} already exists, so the target stays`);
    if (!diskFull(error)) throw error;
    return keep(`${marker} cannot be written: ${error instanceof Error ? error.message : error}`);
  }
  try {
    for (const [n, name] of names.entries()) {
      signal?.throwIfAborted();
      const entry = { dir: join(target, name), there: join(aside, String(n)), name };
      // @ref LLP 0005#the-dormant-reduction-deletes-an-idle-target-whole -- no put-back through a swapped path
      if (!(await sameTarget())) return { ...result, bytes: 0, kept: [...result.kept, `${replaced}; ${STAGED_LEFT}`] };
      try {
        await rename(entry.dir, entry.there);
      } catch (error) {
        result.kept.push(`${name}: it could not be moved aside: ${error instanceof Error ? error.message : error}`);
        unmoved.push(name);
        continue;
      }
      moved.push(entry);
      const took = await heldLock(entry.there, name);
      if (took) return await putBackAll(`a build took ${took} during the move`);
    }
    for (const entry of moved) result.bytes += await sizeOf(entry.there, signal);
    const exactTook = await heldExactLock(target);
    if (exactTook) return await putBackAll(`a build took ${exactTook} during the move`);
    const after = moved.length ? await readTargetUse(target, signal) : { used: [] };
    if ('kept' in after) return await putBackAll(after.kept);
    if (after.used.length) return await putBackAll(`a process took ${after.used[0]} during the move`);
    const now = Date.now();
    const staged = await walkEntries(
      moved.map(({ there }) => there),
      dev,
    );
    const stagedKeypairs = staged.keypairs;
    for (const entry of moved) {
      if (stagedKeypairs.has(entry.there) || (isKeypairDir(entry.name) && holdsKeypair(entry.there)))
        return await putBackAll(`${entry.dir} holds a Solana keypair now`, true);
      const used = recentEntryUse(entry.there, entry.name, now, idleMs);
      if (used) return await putBackAll(`${entry.dir} was used during the move: ${used}`, true);
    }
    const stagedFresh = writtenWithin(staged.newest, now, idleMs);
    if (stagedFresh) return await putBackAll(`${stagedFresh} holds a file written during the move`, true);
    const listed = entriesOf(target);
    if (!listed) return await putBackAll(`${target} cannot be listed`);
    const appeared = listed.find(({ name }) => !name.startsWith(OWN_PREFIX) && !unmoved.includes(name));
    if (appeared) return await putBackAll(`${join(target, appeared.name)} appeared during the move`, true);
    for (const name of unmoved) {
      const used = recentEntryUse(join(target, name), name, now, idleMs);
      if (used) return await putBackAll(`${join(target, name)} was used during the move: ${used}`, true);
    }
    const mounted = mountedUnder(target, mountInfo);
    if (mounted) return await putBackAll(mounted);
    if (!(await sameTarget())) return { ...result, bytes: 0, kept: [...result.kept, `${replaced}; ${STAGED_LEFT}`] };
    await rm(marker);
  } catch (error) {
    await putBackAll('the delete was interrupted');
    throw error;
  }
  result.removed.push(...moved.map(({ name }) => name));
  try {
    const stuck = await removeOnDevice(aside, dev);
    if (stuck.length) {
      await writeFile(join(aside, STRANDED), '').catch(() => {});
      result.deleteError = `${stuck.join(', ')} is another filesystem; a person must unmount it and delete ${aside}`;
    } else await rmdir(target).catch(() => {});
  } finally {
    if (existsSync(target)) await keepTimes();
  }
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

/**
 * The lock a build holds in the top-level entry `name` at `path`: a Cargo lock in it or a directory directly in it, or
 * one of Exact's lock files.
 */
async function heldLock(path: string, name: string, signal?: AbortSignal): Promise<string | null> {
  for (const dir of [path, ...(await childProfiles(path))]) {
    const held = await lockOutcome(dir, signal);
    if (lockHeld(held)) return join(dir, held.file ?? '.cargo-lock');
  }
  for (const file of exactLockFiles(path, name)) if (await fileHeld(file, signal)) return file;
  return null;
}

/** The lock file of Exact's at the top of `target` a process holds, which keeps the whole target. */
async function heldExactLock(target: string, signal?: AbortSignal): Promise<string | null> {
  for (const name of [`${EXACT_LEDGER}.lock`, EXACT_APPLE_LOCKS])
    for (const file of exactLockFiles(join(target, name), name)) if (await fileHeld(file, signal)) return file;
  return null;
}

async function fileHeld(file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return lockHeld({
      stdout: await getExecutor().runFileAsync('lsof', ['-t', '--', file], { timeoutMs: 5000, signal }),
    });
  } catch (error) {
    return lockHeld(isRecord(error) ? { status: error.status, stdout: error.stdout } : { status: null, stdout: null });
  }
}

/**
 * One walk of `paths`, never through a symbolic link: the first directory on a device other than `dev` (`mount`), each
 * of `paths` that holds a `*-keypair.json` at any depth, in any letter case (`keypairs`), and the newest modification
 * time of anything in each of `paths` (`newest`).
 */
async function walkEntries(
  paths: readonly string[],
  dev: number,
): Promise<{ mount: string | null; keypairs: Set<string>; newest: Map<string, number> }> {
  const keypairs = new Set<string>();
  const newest = new Map<string, number>();
  const queue = paths.map((path) => ({ path, top: path }));
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const { path, top } = item;
    const stat = await lstat(path);
    newest.set(top, Math.max(newest.get(top) ?? 0, stat.mtimeMs));
    if (!stat.isDirectory()) {
      if (isKeypairName(basename(path))) keypairs.add(top);
      continue;
    }
    if (stat.dev !== dev) return { mount: path, keypairs, newest };
    for (const entry of await readdir(path, { withFileTypes: true })) queue.push({ path: join(path, entry.name), top });
  }
  return { mount: null, keypairs, newest };
}

/** The first of `newest`'s entries but `skip` whose newest time is within `idleMs` of `now`. */
function writtenWithin(newest: Map<string, number>, now: number, idleMs: number, skip?: string): string | null {
  for (const [path, at] of newest) if (path !== skip && now - at <= idleMs) return path;
  return null;
}

/** Deletes `path` without entering a directory on a device other than `dev`; returns those it left. */
async function removeOnDevice(path: string, dev: number): Promise<string[]> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isDirectory()) {
    await unlink(path);
    return [];
  }
  if (stat.dev !== dev) return [path];
  const left: string[] = [];
  for (const name of await readdir(path)) left.push(...(await removeOnDevice(join(path, name), dev)));
  if (!left.length) await rmdir(path);
  return left;
}

/**
 * Puts `there` back at `dir`, or keeps it for a person: renamed to `target/.stim-not-restored-*`, or else left where it
 * is with its `.stim-trimmed` marked NOT-RESTORED (`marked`).
 */
async function restoreOrStrand(
  target: string,
  there: string,
  dir: string,
  n: number,
  released: () => void,
): Promise<{ home: string; marked: boolean }> {
  try {
    const staged = lstatSync(there);
    if (staged.isFile()) {
      await link(there, dir);
      await unlink(there);
      return { home: dir, marked: false };
    }
    // Node has no rename that refuses to replace, and rename(2) replaces an empty directory, so a directory recreated
    // empty between this check and the rename is still replaced.
    if (staged.isDirectory() && !lstatSync(dir, { throwIfNoEntry: false })) {
      await rename(there, dir);
      return { home: dir, marked: false };
    }
  } catch {}
  const stranded = join(target, `${NOT_RESTORED}${Date.now()}-${n}`);
  try {
    await rename(there, stranded);
    return { home: stranded, marked: false };
  } catch {}
  const aside = join(target, ASIDE);
  try {
    // @ref LLP 0005#a-full-disk-releases-the-reserve -- the marker of a failed put-back retries too
    await retryWithReserve(() => writeFile(join(aside, STRANDED), '', { flag: 'a' }), released);
  } catch (error) {
    throw new Error(
      `${there} could not be put back and ${aside} could not be marked for a person: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
  return { home: there, marked: true };
}

interface CargoTrimOptions {
  needBytes: number;
  incremental?: 'toNeed' | 'all';
  units?: 'none' | 'toNeed' | 'all';
  /** A profile no build wrote for this long goes whole; default a day. */
  profileIdleMs?: number;
  lowPriority?: boolean;
  now?: number;
  signal?: AbortSignal;
  /** Stops the trim between units that completed; a unit in flight finishes. */
  stop?: AbortSignal;
  /** Whether to walk what was removed to report its bytes; false reports 0 and removes at once. Default true. */
  measure?: boolean;
}

/** Why no trim of `target` runs until a person acts: its `.stim-trimmed` holds a directory that could not be put back. */
function strandedReason(target: string): string | null {
  const aside = join(target, ASIDE);
  return existsSync(join(aside, STRANDED))
    ? `${aside} holds a directory that could not be put back; a person must merge or delete it`
    : null;
}

/**
 * Deletes the entries `names` a trim staged in `aside`, then `aside` itself, once it is still the real directory `made`
 * identifies. Returns why `aside` stays when anything else appeared in it.
 */
async function deleteStaged(
  aside: string,
  made: { dev: number; ino: number },
  names: readonly string[],
): Promise<string | null> {
  const now = await lstat(aside).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') throw error;
    return null;
  });
  if (!now) return null;
  if (!now.isDirectory() || now.dev !== made.dev || now.ino !== made.ino)
    throw new Error(`${aside} is no longer the directory the trim staged into`);
  for (const name of names) await rm(join(aside, name), { recursive: true, force: true });
  try {
    await rmdir(aside);
  } catch (error) {
    if (errorCode(error) !== 'ENOTEMPTY' && errorCode(error) !== 'EEXIST') throw error;
    return `${aside} holds ${(await readdir(aside)).join(', ')}, which this trim did not stage, so it stays`;
  }
  return null;
}

/** Why `target` must not be deleted whole: it holds a directory a trim could not put back. */
function recoveryReason(target: string): string | null {
  const stranded = strandedReason(target);
  if (stranded) return stranded;
  const entries = entriesOf(target);
  if (!entries) return `${target} cannot be listed`;
  const kept = entries.find((entry) => entry.name.startsWith(NOT_RESTORED));
  return kept
    ? `${join(target, kept.name)} holds a directory a trim could not put back; a person must merge or delete it`
    : null;
}

async function trimClaimed(
  target: string,
  {
    needBytes,
    incremental = 'toNeed',
    units = 'none',
    profileIdleMs = CARGO_PROFILE_IDLE_MS,
    lowPriority = false,
    now = Date.now(),
    signal,
    stop,
    measure = true,
  }: CargoTrimOptions,
): Promise<CargoTrimResult> {
  const result: CargoTrimResult = { bytes: 0, removed: [], kept: [] };
  const stopped = (): boolean => stop?.aborted === true;
  const measured = (path: string): Promise<number> =>
    measure ? sizeOf(path, signal, lowPriority) : Promise.resolve(0);
  const aside = join(target, ASIDE);
  let keepAside = false;
  const blocked = strandedReason(target);
  if (blocked) return { ...result, kept: [blocked] };
  try {
    await rm(aside, { recursive: true, force: true });
  } catch (error) {
    return {
      ...result,
      kept: [`a leftover ${aside} cannot be deleted: ${error instanceof Error ? error.message : error}`],
    };
  }
  const first = await readTargetUse(target, signal, lowPriority);
  if ('kept' in first) return { ...result, kept: [first.kept] };
  let used: string[] = first.used;
  const stale = staleCargoTargetPaths(target, now, profileIdleMs);
  if ('refusal' in stale) return { ...result, kept: [stale.refusal] };
  let latestStale: { paths: string[] } | { refusal: string } = stale;
  let moved = 0;
  let wholeKept = false;
  const released = (): void => {
    result.reserveReleased = true;
  };
  const keptAfterRelease = (label: string, error: KeptAfterRelease): false => {
    wholeKept ||= error.whole;
    result.kept.push(error.whole ? error.message : `${label}: ${error.message}`);
    return false;
  };
  let made: { dev: number; ino: number } | null = null;
  const stagedNames: string[] = [];
  const stage = async (recheck: () => Promise<void>): Promise<boolean> => {
    if (made) return true;
    await retryWithReserve(() => mkdir(aside, { recursive: true }), recheck);
    const dir = await lstat(aside);
    if (!dir.isDirectory()) {
      wholeKept = true;
      result.kept.push(`${aside} is not a directory, so nothing was moved`);
      return false;
    }
    made = { dev: dir.dev, ino: dir.ino };
    return true;
  };
  const profilesAt = async (dir: string) => (fingerprintDir(dir) ? [dir] : await childProfiles(dir));
  const move = async (
    dir: string,
    label: string,
    bytes: number | null,
    locks: (where: string) => Promise<string[]>,
    stalePath = false,
    busy = dir,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    if (wholeKept) return false;
    if (stopped()) {
      if (!result.kept.includes(DEADLINE_KEPT)) result.kept.push(DEADLINE_KEPT);
      return false;
    }
    const profiles = await locks(dir);
    if (inUse(used, busy)) {
      result.kept.push(`${label}: a process uses it`);
      return false;
    }
    for (const profile of profiles) {
      const held = await lockOutcome(profile, signal, lowPriority);
      if (lockHeld(held)) {
        result.kept.push(`${label}: a build holds its ${held.file ?? '.cargo-lock'}`);
        return false;
      }
    }
    const recheck = async (): Promise<void> => {
      released();
      const fresh = await readTargetUse(target, signal, lowPriority);
      if ('kept' in fresh) throw new KeptAfterRelease(fresh.kept, true);
      used = fresh.used;
      if (stalePath) latestStale = staleCargoTargetPaths(target, now, profileIdleMs);
      if ('refusal' in latestStale) throw new KeptAfterRelease(latestStale.refusal);
      if (inUse(used, busy)) throw new KeptAfterRelease('a process uses it');
      for (const profile of profiles) {
        const held = await lockOutcome(profile, signal, lowPriority);
        if (lockHeld(held)) throw new KeptAfterRelease(`a build holds its ${held.file ?? '.cargo-lock'}`);
      }
      if (stalePath && !latestStale.paths.includes(label))
        throw new KeptAfterRelease('it is no longer stale as a whole');
    };
    try {
      // @ref LLP 0005#a-full-disk-releases-the-reserve -- the checks run again before the retry
      if (!(await stage(recheck))) return false;
    } catch (error) {
      if (!(error instanceof KeptAfterRelease)) throw error;
      return keptAfterRelease(label, error);
    }
    const there = join(aside, String(moved));
    stagedNames.push(String(moved++));
    try {
      await retryWithReserve(() => rename(dir, there), recheck);
    } catch (error) {
      if (error instanceof KeptAfterRelease) return keptAfterRelease(label, error);
      result.kept.push(`${label}: it could not be moved aside: ${error instanceof Error ? error.message : error}`);
      return false;
    }
    for (const profile of await locks(there)) {
      const after = await lockOutcome(profile, undefined, lowPriority);
      const lockName = after.file ?? '.cargo-lock';
      if (!renameStands(after)) {
        // @ref LLP 0005#never-delete-what-a-build-took-back -- a build locked it during the move
        const back = await restoreOrStrand(target, there, dir, moved, released);
        keepAside ||= back.marked;
        result.kept.push(
          back.home === dir
            ? `${label}: a build took its ${lockName} during the move`
            : `${label}: a build took its ${lockName} during the move and the directory could not be put back; it stays in ${back.home} for a person to merge or delete`,
        );
        return false;
      }
    }
    result.bytes += bytes ?? (await measured(there));
    result.removed.push(label);
    return true;
  };
  const sweepUnits = async (profile: string, key: string): Promise<{ units: number; bytes: number; kept?: string }> => {
    const none = { units: 0, bytes: 0 };
    const ledgerPath = join(target, EXACT_LEDGER);
    const snapshot = await lstat(ledgerPath, { bigint: true }).catch(() => null);
    if (!snapshot?.isFile()) return none;
    const ledger = readLedger(target);
    if (!ledgerShowsUse(ledger, now) || 'refusal' in ledger) return none;
    const all = readCargoUnits(profile, ledger.units, key, now);
    if (!all) return { ...none, kept: 'its units cannot be listed' };
    const candidates = [...cargoUnitPaths(profile, idleCargoUnits(all, now, CARGO_PROFILE_IDLE_MS))];
    if (!candidates.length) return none;
    const fresh = await readTargetUse(target, signal, lowPriority);
    if ('kept' in fresh) return { ...none, kept: fresh.kept };
    let swept = 0;
    let bytes = 0;
    let unitsUsed = fresh.used;
    const recheck =
      (paths: readonly string[] = [], batch?: string) =>
      async (): Promise<void> => {
        released();
        const again = await readTargetUse(target, signal, lowPriority);
        if ('kept' in again) throw new KeptAfterRelease(again.kept, true);
        unitsUsed = again.used;
        const busy = paths.find(
          (path) =>
            inUse(unitsUsed, join(profile, path)) || (batch !== undefined && inUse(unitsUsed, join(batch, path))),
        );
        if (busy) throw new KeptAfterRelease(`${busy}: a process uses it`);
      };
    // @ref LLP 0005#never-delete-what-a-build-took-back -- Exact serializes access-time resets and ledger replacement
    const locks = [join(target, `${EXACT_LEDGER}.lock`), ...PROFILE_LOCKS.map((name) => join(profile, name))];
    for (let at = 0; at < candidates.length; at += UNIT_CHUNK) {
      signal?.throwIfAborted();
      if (stopped()) return { units: swept, bytes, kept: DEADLINE_KEPT };
      if (wholeKept) return { units: swept, bytes };
      const chunk = candidates
        .slice(at, at + UNIT_CHUNK)
        .filter(([, paths]) => !paths.some((path) => inUse(unitsUsed, join(profile, path))));
      if (!chunk.length) continue;
      const batch = join(aside, `units-${moved}`);
      stagedNames.push(`units-${moved++}`);
      const movedBatch = await withCargoLocks(
        locks,
        async () => {
          // Exact renames the ledger after resetting fingerprint access times under its ledger lock.
          const current = lstatSync(ledgerPath, { bigint: true, throwIfNoEntry: false });
          if (current?.ino !== snapshot.ino || current.dev !== snapshot.dev)
            return { kept: 'Exact updated its ledger, so the sweep stopped' };
          const idle = chunk.filter(([unit]) => !cargoUnitWasRead(join(profile, '.fingerprint', unit.id)));
          const done: string[] = [];
          const order = removalOrder(idle.flatMap(([, paths]) => paths));
          for (const path of order) {
            try {
              // @ref LLP 0005#a-full-disk-releases-the-reserve -- the checks run again before the retry
              const again = recheck(order, batch);
              if (!(await stage(again))) return { units: 0 };
              await retryWithReserve(() => mkdir(dirname(join(batch, path)), { recursive: true }), again);
              await retryWithReserve(() => rename(join(profile, path), join(batch, path)), again);
              done.push(path);
            } catch (error) {
              if (errorCode(error) === 'ENOENT') continue;
              wholeKept ||= error instanceof KeptAfterRelease && error.whole;
              const stranded = await putBack(profile, batch, done);
              return {
                kept:
                  stranded ??
                  (error instanceof KeptAfterRelease
                    ? error.message
                    : `a unit could not be moved aside: ${error instanceof Error ? error.message : error}`),
              };
            }
          }
          return { units: idle.length };
        },
        signal,
      );
      if ('kept' in movedBatch) return { units: swept, bytes, kept: movedBatch.kept };
      if ('kept' in movedBatch.value) return { units: swept, bytes, kept: movedBatch.value.kept };
      swept += movedBatch.value.units;
      if (movedBatch.value.units) bytes += await measured(batch);
    }
    return { units: swept, bytes };
  };
  const putBack = async (profile: string, batch: string, done: readonly string[]): Promise<string | null> => {
    for (const path of done.toReversed()) {
      const home = join(profile, path);
      const there = join(batch, path);
      if (existsSync(home)) {
        await rm(there, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      try {
        await rename(there, home);
      } catch {
        keepAside = true;
        await retryWithReserve(() => writeFile(join(aside, STRANDED), ''), released).catch(() => {});
        return `${path} is missing and could not be put back; it stays in ${batch} for a person to merge or delete`;
      }
    }
    return null;
  };
  for (const path of stale.paths) {
    const latest: { paths: string[] } | { refusal: string } = latestStale;
    if ('refusal' in latest) result.kept.push(`${path}: ${latest.refusal}`);
    else if (!latest.paths.includes(path)) result.kept.push(`${path}: no longer stale as a whole after the rescan`);
    else await move(join(target, path), path, null, profilesAt, true);
  }
  const removedStale = new Set(stale.paths.map((path) => join(target, path)));
  const remaining = (cargoProfileDirs(target) ?? []).filter(
    (profile) => ![...removedStale].some((gone) => profile === gone || profile.startsWith(`${gone}/`)),
  );
  const refreshed =
    stopped() || wholeKept
      ? null
      : incremental === 'all' || result.bytes < needBytes
        ? await readTargetUse(target, signal, lowPriority)
        : { used };
  if (stopped()) {
    if (!result.kept.includes(DEADLINE_KEPT)) result.kept.push(DEADLINE_KEPT);
  } else if (refreshed && 'kept' in refreshed) result.kept.push(refreshed.kept);
  else if (refreshed) used = refreshed.used;
  if (refreshed && 'used' in refreshed && (incremental === 'all' || result.bytes < needBytes)) {
    const candidates: { path: string; bytes: number }[] = [];
    for (const profile of remaining) {
      const dir = join(profile, 'incremental');
      if (incremental === 'toNeed' && inUse(used, profile)) continue;
      if (existsSync(dir))
        candidates.push({ path: dir, bytes: incremental === 'all' ? 0 : await sizeOf(dir, signal, lowPriority) });
    }
    const chosen =
      incremental === 'all'
        ? candidates.map(({ path }) => path)
        : selectIncremental(candidates, needBytes - result.bytes);
    for (const path of chosen) {
      const bytes = candidates.find((candidate) => candidate.path === path)?.bytes ?? 0;
      const parent = dirname(path);
      await move(
        path,
        path.slice(target.length + 1),
        bytes,
        async () => [parent],
        false,
        incremental === 'toNeed' ? parent : path,
      );
    }
  }
  if (!wholeKept && (units === 'all' || (units === 'toNeed' && result.bytes < needBytes)))
    for (const profile of remaining) {
      signal?.throwIfAborted();
      if (stopped() || wholeKept) break;
      const key = profile.slice(target.length + 1);
      const swept = await sweepUnits(profile, key);
      if (swept.kept) result.kept.push(`${key}: ${swept.kept}`);
      if (swept.units) {
        result.bytes += swept.bytes;
        result.removed.push(`${key}: ${swept.units} idle units`);
      }
    }
  if (keepAside || !made) return result;
  try {
    const left = await deleteStaged(aside, made, stagedNames);
    if (left) result.kept.push(left);
  } catch (error) {
    result.deleteError = `${aside} could not be deleted: ${error instanceof Error ? error.message : error}`;
  }
  return result;
}

async function childProfiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
}
