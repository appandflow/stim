import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cargoTargetTrimClaims } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { getExecutor } from '../exec.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { withCargoLocks } from './cargo-lock.ts';
import { launcherReason, type Launching } from './launchers.ts';
import { cargoUnitPaths, cargoUnitWasRead, idleCargoUnits, readCargoUnits, removalOrder } from './cargo-units.ts';

const CARGO_PROFILE_IDLE_MS: number = 24 * 3_600_000;
const ASIDE = '.stim-trimmed';
const PROFILE_PARTS = ['.fingerprint', 'deps', 'build', 'incremental'];
/** The files Cargo itself writes in a target triple directory; any other entry there belongs to something else. */
const CARGO_TRIPLE_FILES = new Set(['CACHEDIR.TAG', '.rustc_info.json', '.cargo-lock']);
/** Cargo 1.97 locks the build and artifact directories separately and takes .cargo-lock for older Cargo. */
const PROFILE_LOCKS = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];
const UNIT_CHUNK = 25;
const EXACT_LEDGER = '.exact-sweep.json';
const NOT_PROFILES = new Set(['.exact-swept']);
const OWN_PREFIX = '.stim-';
const STRANDED = 'NOT-RESTORED';
const CANNOT_READ = 'the files processes hold open or the executables on PATH cannot be read';
const DEADLINE_KEPT = 'the rest was left at the build headroom deadline';
const NOT_RESTORED = `${OWN_PREFIX}not-restored-`;
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
  const ledgerPath = join(target, EXACT_LEDGER);
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
 * The paths under `target` a running process executes from or holds open, from one `lsof` and one `ps` read, with the
 * launcher reading taken at the same moment: an executable on PATH that resolves into the owning checkout, a launcher
 * read that has not answered, or process evidence that cannot be read, keeps everything.
 */
async function readTargetUse(
  target: string,
  launching: Launching,
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
    const used = targetPathsInUse(target, lsof, ps);
    const scan = await launching.anew();
    const launcher = launcherReason(launching.checkout, scan);
    if (launcher) return { kept: launcher };
    const prefix = `${folded(target)}/`;
    for (const path of scan.targets) if (folded(path).startsWith(prefix)) used.push(folded(path));
    return { used };
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
  return 'kept' in claimed ? { ...result, kept: [claimed.kept] } : claimed.value;
}

async function withTrimClaim<T>(
  registeredTarget: string,
  run: (target: string) => Promise<T>,
): Promise<{ value: T } | { kept: string }> {
  let target: string;
  try {
    target = realpathSync.native(registeredTarget);
  } catch {
    return { kept: `${registeredTarget} cannot be resolved to its on-disk path` };
  }
  // @ref LLP 0005#never-delete-what-a-build-took-back -- one trim of a target at a time across processes
  let claim: ClaimHandle | null | undefined;
  try {
    const attempt = tryAcquireClaim({
      root: cargoTargetTrimClaims(target),
      mode: 'exclusive',
      label: 'Cargo target trim',
      details: { target },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    claim = attempt.acquired;
    if (!claim) {
      const holder = attempt.held;
      return {
        kept: `another trim of it holds ${holder?.path ?? 'its claim'}${holder ? ` (pid ${holder.owner.pid})` : ''}`,
      };
    }
  } catch (error) {
    return { kept: `its trim claim cannot be taken: ${error instanceof Error ? error.message : error}` };
  }
  try {
    return { value: await run(target) };
  } finally {
    releaseClaim(claim);
  }
}

/**
 * Why a build used `target` within `idleMs`: a profile written or stamped in Exact's ledger that recently, or a
 * profile or ledger that cannot be read. Null when every profile went unused that long.
 */
export function recentCargoUse(target: string, now: number, idleMs: number): string | null {
  const stale = staleCargoTargetPaths(target, now, idleMs);
  if ('refusal' in stale) return stale.refusal;
  const profiles = profilePaths(target)?.profiles;
  if (!profiles) return `${target} cannot be listed`;
  const used = profiles.find(
    (profile) => !stale.paths.some((gone) => profile === gone || profile.startsWith(`${gone}/`)),
  );
  return used === undefined ? null : `a build used its ${used} profile in that time`;
}

/**
 * Deletes `target` whole under its trim claim, after checking that it holds no copy a trim could not put back, that no
 * profile was used within `idleMs`, that no process executes from or holds open a path in it (the launchers read at the
 * same moment), and that no build holds a profile's lock file. Returns why it stays, or null once it is gone. Nothing
 * slow runs between the lock check and the delete, but they are not atomic.
 */
export async function deleteCargoTarget(
  registeredTarget: string,
  {
    idleMs,
    launching,
    signal,
    remove,
  }: {
    idleMs: number;
    launching: Launching;
    signal?: AbortSignal;
    remove: (target: string) => Promise<void>;
  },
): Promise<string | null> {
  const claimed = await withTrimClaim(registeredTarget, async (target): Promise<string | null> => {
    const recovery = recoveryReason(target);
    if (recovery) return recovery;
    const recent = recentCargoUse(target, Date.now(), idleMs);
    if (recent) return recent;
    const use = await readTargetUse(target, launching, signal);
    if ('kept' in use) return use.kept;
    if (use.used.length) return `a process uses ${use.used[0]}`;
    const profiles = cargoProfileDirs(target);
    if (!profiles) return `${target} cannot be listed`;
    for (const profile of profiles) {
      const held = await lockOutcome(profile, signal);
      if (lockHeld(held)) return `a build holds ${join(profile, held.file ?? '.cargo-lock')}`;
    }
    await remove(registeredTarget);
    return null;
  });
  return 'kept' in claimed ? claimed.kept : claimed.value;
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
  /**
   * The checkout that owns the target and how to read the launchers anew, which the trim does after each read of the
   * processes using the target; a launcher into any of the checkout keeps the whole target. Every caller states it.
   */
  launching: Launching;
}

/** Why no trim of `target` runs until a person acts: its `.stim-trimmed` holds a directory that could not be put back. */
function strandedReason(target: string): string | null {
  const aside = join(target, ASIDE);
  return existsSync(join(aside, STRANDED))
    ? `${aside} holds a directory that could not be put back; a person must merge or delete it`
    : null;
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
    launching,
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
  const first = await readTargetUse(target, launching, signal, lowPriority);
  if ('kept' in first) return { ...result, kept: [first.kept] };
  let used: string[] = first.used;
  const stale = staleCargoTargetPaths(target, now, profileIdleMs);
  if ('refusal' in stale) return { ...result, kept: [stale.refusal] };
  let moved = 0;
  const profilesAt = async (dir: string) => (fingerprintDir(dir) ? [dir] : await childProfiles(dir));
  const move = async (
    dir: string,
    label: string,
    bytes: number | null,
    locks: (where: string) => Promise<string[]>,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    if (stopped()) {
      if (!result.kept.includes(DEADLINE_KEPT)) result.kept.push(DEADLINE_KEPT);
      return false;
    }
    const profiles = await locks(dir);
    if (inUse(used, dir)) {
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
    await mkdir(aside, { recursive: true });
    const there = join(aside, String(moved++));
    try {
      await rename(dir, there);
    } catch (error) {
      result.kept.push(`${label}: it could not be moved aside: ${error instanceof Error ? error.message : error}`);
      return false;
    }
    for (const profile of await locks(there)) {
      const after = await lockOutcome(profile, undefined, lowPriority);
      const lockName = after.file ?? '.cargo-lock';
      if (!renameStands(after)) {
        try {
          await rename(there, dir);
          result.kept.push(`${label}: a build took its ${lockName} during the move`);
        } catch {
          // @ref LLP 0005#never-delete-what-a-build-took-back -- a build locked it during the move
          const stranded = join(target, `${NOT_RESTORED}${Date.now()}-${moved}`);
          const home = await rename(there, stranded).then(
            () => stranded,
            async () => {
              keepAside = true;
              try {
                await writeFile(join(aside, STRANDED), '');
              } catch (error) {
                throw new Error(
                  `${there} could not be put back and ${aside} could not be marked for a person: ${error instanceof Error ? error.message : error}`,
                  { cause: error },
                );
              }
              return there;
            },
          );
          result.kept.push(
            `${label}: a build took its ${lockName} during the move and the directory could not be put back; it stays in ${home} for a person to merge or delete`,
          );
        }
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
    const fresh = await readTargetUse(target, launching, signal, lowPriority);
    if ('kept' in fresh) return { ...none, kept: fresh.kept };
    let swept = 0;
    let bytes = 0;
    // @ref LLP 0005#never-delete-what-a-build-took-back -- Exact serializes access-time resets and ledger replacement
    const locks = [join(target, `${EXACT_LEDGER}.lock`), ...PROFILE_LOCKS.map((name) => join(profile, name))];
    for (let at = 0; at < candidates.length; at += UNIT_CHUNK) {
      signal?.throwIfAborted();
      if (stopped()) return { units: swept, bytes, kept: DEADLINE_KEPT };
      const chunk = candidates
        .slice(at, at + UNIT_CHUNK)
        .filter(([, paths]) => !paths.some((path) => inUse(fresh.used, join(profile, path))));
      if (!chunk.length) continue;
      const batch = join(aside, `units-${moved++}`);
      const movedBatch = await withCargoLocks(
        locks,
        async () => {
          // Exact renames the ledger after resetting fingerprint access times under its ledger lock.
          const current = lstatSync(ledgerPath, { bigint: true, throwIfNoEntry: false });
          if (current?.ino !== snapshot.ino || current.dev !== snapshot.dev)
            return { kept: 'Exact updated its ledger, so the sweep stopped' };
          const idle = chunk.filter(([unit]) => !cargoUnitWasRead(join(profile, '.fingerprint', unit.id)));
          const done: string[] = [];
          for (const path of removalOrder(idle.flatMap(([, paths]) => paths))) {
            try {
              await mkdir(dirname(join(batch, path)), { recursive: true });
              await rename(join(profile, path), join(batch, path));
              done.push(path);
            } catch (error) {
              if (errorCode(error) === 'ENOENT') continue;
              const stranded = await putBack(profile, batch, done);
              return {
                kept: stranded ?? `a unit could not be moved aside: ${error instanceof Error ? error.message : error}`,
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
        await writeFile(join(aside, STRANDED), '').catch(() => {});
        return `${path} is missing and could not be put back; it stays in ${batch} for a person to merge or delete`;
      }
    }
    return null;
  };
  for (const path of stale.paths) await move(join(target, path), path, null, profilesAt);
  const removedStale = new Set(stale.paths.map((path) => join(target, path)));
  const remaining = (cargoProfileDirs(target) ?? []).filter(
    (profile) => ![...removedStale].some((gone) => profile === gone || profile.startsWith(`${gone}/`)),
  );
  const refreshed = stopped()
    ? null
    : incremental === 'all' || result.bytes < needBytes
      ? await readTargetUse(target, launching, signal, lowPriority)
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
      await move(path, path.slice(target.length + 1), bytes, async () => [parent]);
    }
  }
  if (units === 'all' || (units === 'toNeed' && result.bytes < needBytes))
    for (const profile of remaining) {
      signal?.throwIfAborted();
      if (stopped()) break;
      const key = profile.slice(target.length + 1);
      const swept = await sweepUnits(profile, key);
      if (swept.kept) result.kept.push(`${key}: ${swept.kept}`);
      if (swept.units) {
        result.bytes += swept.bytes;
        result.removed.push(`${key}: ${swept.units} idle units`);
      }
    }
  if (keepAside) return result;
  try {
    await rm(aside, { recursive: true, force: true });
  } catch (error) {
    result.deleteError = `${aside} could not be deleted: ${error instanceof Error ? error.message : error}`;
  }
  return result;
}

async function childProfiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
}
