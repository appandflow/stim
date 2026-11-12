import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';

const CARGO_PROFILE_IDLE_MS: number = 24 * 3_600_000;
const ASIDE = '.stim-trimmed';
const PROFILE_PARTS = ['.fingerprint', 'deps', 'build', 'incremental'];
const NOT_PROFILES = new Set(['.exact-swept', ASIDE]);

export interface CargoProfile {
  /** The profile directory relative to `target/`: `debug` or `<triple>/<profile>`. */
  path: string;
  /** When a build last wrote or read it, in ms, or null when that cannot be read. */
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
 * The newest unit time per profile in Exact's `.exact-sweep.json` ledger (`{ units: { "<profile>#<hash>": ms } }`),
 * which Exact refreshes from the fingerprint files a build read. Null when the text is not that shape.
 */
function parseSweepLedger(text: string): Map<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const units = isRecord(parsed) ? parsed.units : undefined;
  if (!isRecord(units)) return null;
  const newest = new Map<string, number>();
  for (const [key, at] of Object.entries(units)) {
    const profile = key.split('#')[0];
    if (!profile || typeof at !== 'number' || !Number.isFinite(at)) return null;
    newest.set(profile, Math.max(newest.get(profile) ?? 0, at));
  }
  return newest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function subdirectories(path: string): Dirent[] | null {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
}

function profilePaths(target: string): { profiles: string[]; extras: Set<string> } | null {
  const profiles: string[] = [];
  const extras = new Set<string>();
  const top = subdirectories(target);
  if (!top) return null;
  for (const first of top) {
    if (NOT_PROFILES.has(first.name)) continue;
    if (existsSync(join(target, first.name, '.fingerprint'))) {
      profiles.push(first.name);
      continue;
    }
    const inner = subdirectories(join(target, first.name));
    if (!inner) return null;
    for (const second of inner) {
      if (existsSync(join(target, first.name, second.name, '.fingerprint')))
        profiles.push(`${first.name}/${second.name}`);
      else extras.add(first.name);
    }
  }
  return { profiles, extras };
}

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

/** Whether any fingerprint file of the profile was read since `since`: Cargo reads one per unit it considers. */
function fingerprintReadSince(profile: string, since: number): boolean | null {
  const root = join(profile, '.fingerprint');
  try {
    for (const unit of readdirSync(root)) {
      for (const file of readdirSync(join(root, unit)))
        if (statSync(join(root, unit, file)).atimeMs >= since) return true;
    }
    return false;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? false : null;
  }
}

/**
 * What of an Exact app's Cargo `target/` no build used for a day, as paths relative to it, or why that cannot be told.
 * A profile is in use when a build wrote its directories, when Exact's ledger stamps one of its units that recently, or
 * when a build read one of its fingerprint files. Anything unreadable is in use.
 */
export function staleCargoTargetPaths(
  target: string,
  now: number,
  idleMs: number = CARGO_PROFILE_IDLE_MS,
): { paths: string[] } | { refusal: string } {
  const listed = profilePaths(target);
  if (!listed) return { refusal: `${target} cannot be listed` };
  let ledger = new Map<string, number>();
  const ledgerPath = join(target, '.exact-sweep.json');
  if (existsSync(ledgerPath)) {
    let text: string;
    try {
      text = readFileSync(ledgerPath, 'utf8');
    } catch {
      return { refusal: `Exact's ${ledgerPath} cannot be read` };
    }
    const parsed = parseSweepLedger(text);
    if (!parsed) return { refusal: `Exact's ${ledgerPath} is not a unit ledger` };
    ledger = parsed;
  }
  const profiles: CargoProfile[] = listed.profiles.map((path) => {
    const written = newestMtime(join(target, path));
    if (written === null) return { path, lastUsedMs: null };
    const stamped = Math.max(written, ledger.get(path) ?? 0);
    if (now - stamped <= idleMs) return { path, lastUsedMs: stamped };
    const read = fingerprintReadSince(join(target, path), now - idleMs);
    return { path, lastUsedMs: read === false ? stamped : read === true ? now : null };
  });
  return { paths: staleCargoPaths(profiles, listed.extras, now, idleMs) };
}

/** Whether a process has the profile's `.cargo-lock` open, as a running Cargo build does; true when lsof cannot say. */
async function buildHoldsProfile(profile: string, signal?: AbortSignal): Promise<boolean> {
  const lock = join(profile, '.cargo-lock');
  if (!existsSync(lock)) return false;
  try {
    return Boolean((await getExecutor().runFileAsync('lsof', ['-t', '--', lock], { timeoutMs: 5000, signal })).trim());
  } catch (error) {
    return !(isRecord(error) && error.status === 1 && (error.stdout === '' || error.stdout === undefined));
  }
}

/**
 * Removes the stale profiles of `target`: each is renamed into `target/.stim-trimmed` first, so a build that starts
 * meanwhile makes a fresh one, then deleted. A profile a build holds open stays. Returns what was freed and kept.
 */
export async function trimCargoTarget(
  target: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{ bytes: number; removed: string[]; kept: string[] }> {
  const aside = join(target, ASIDE);
  await rm(aside, { recursive: true, force: true });
  const removed: string[] = [];
  const kept: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const dir = join(target, path);
    const profiles = existsSync(join(dir, '.fingerprint')) ? [dir] : await childProfiles(dir);
    if ((await Promise.all(profiles.map((profile) => buildHoldsProfile(profile, signal)))).some(Boolean)) {
      kept.push(`${path}: a build holds its .cargo-lock`);
      continue;
    }
    bytes += (await measuredDirectorySizeAsync(dir, { timeoutMs: 120_000, signal })) ?? 0;
    await mkdir(aside, { recursive: true });
    await rename(dir, join(aside, String(removed.length)));
    removed.push(path);
  }
  await rm(aside, { recursive: true, force: true });
  return { bytes, removed, kept };
}

async function childProfiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
}
