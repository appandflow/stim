import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UNIT_NAME = /^(.+)-([0-9a-f]{16})$/;
const FINGERPRINT = '.fingerprint';

export interface CargoUnit {
  /** The directory name in `.fingerprint`: `<crate>-<hash>`. */
  id: string;
  crate: string;
  hash: string;
  /** The ledger stamp, or now when a build read it since the last sweep; null when it has no stamp. */
  lastUsedMs: number | null;
}

/**
 * The units of a profile to remove: those no build used for `idleMs`, except the newest unit of each crate, which stays
 * whatever its age, and any unit whose last use is unknown. The newest build of a crate is the one the current
 * dependency graph most likely needs, so what is removed is the superseded duplicates Cargo never cleans up.
 */
export function idleCargoUnits(units: readonly CargoUnit[], now: number, idleMs: number): CargoUnit[] {
  const newest = new Map<string, number>();
  for (const unit of units)
    if (unit.lastUsedMs !== null)
      newest.set(unit.crate, Math.max(newest.get(unit.crate) ?? -Infinity, unit.lastUsedMs));
  const keptNewest = new Set<string>();
  return units.filter((unit) => {
    if (unit.lastUsedMs === null || now - unit.lastUsedMs <= idleMs) return false;
    if (unit.lastUsedMs === newest.get(unit.crate) && !keptNewest.has(unit.crate)) {
      keptNewest.add(unit.crate);
      return false;
    }
    return true;
  });
}

/** Exact's sweep sets the access time of every fingerprint file back to 1970-01-02; a later read of one shows a build considered the unit. */
const ACCESS_RESET_MS = 86_400_000;

export function cargoUnitWasRead(path: string): boolean {
  try {
    return readdirSync(path).some((name) => statSync(join(path, name)).atimeMs > ACCESS_RESET_MS);
  } catch {
    return true;
  }
}

/**
 * The units of the profile at `profile`, timed only by Exact's `.exact-sweep.json` stamps (`<profileKey>#<hash>`), which
 * its sweep records from reads of each unit's fingerprint, or by a read since that sweep. Cargo does not touch the
 * fingerprint of a fresh dependency, so file modification times say nothing about use: a unit with no stamp has no
 * time and stays. Null when `.fingerprint` cannot be listed.
 */
export function readCargoUnits(
  profile: string,
  stamps: ReadonlyMap<string, number>,
  profileKey: string,
  now: number,
): CargoUnit[] | null {
  let names: string[];
  try {
    names = readdirSync(join(profile, FINGERPRINT));
  } catch {
    return null;
  }
  const units: CargoUnit[] = [];
  for (const id of names) {
    const match = UNIT_NAME.exec(id);
    if (!match) continue;
    const stamped = stamps.get(`${profileKey}#${match[2]}`);
    units.push({
      id,
      crate: match[1] ?? id,
      hash: match[2] ?? '',
      lastUsedMs: stamped === undefined ? null : cargoUnitWasRead(join(profile, FINGERPRINT, id)) ? now : stamped,
    });
  }
  return units;
}

/**
 * The paths, relative to `profile`, that belong to each unit: its fingerprint directory, the build-script directory
 * carrying its hash, and the `deps` files that carry it.
 */
export function cargoUnitPaths(profile: string, units: readonly CargoUnit[]): Map<CargoUnit, string[]> {
  const byHash = new Map(units.map((unit) => [unit.hash, unit]));
  const found = new Map(units.map((unit): [CargoUnit, string[]] => [unit, [join(FINGERPRINT, unit.id)]]));
  const add = (dir: string, hashOf: (name: string) => string | undefined) => {
    let names: string[] = [];
    try {
      names = readdirSync(join(profile, dir));
    } catch {}
    for (const name of names) {
      const unit = byHash.get(hashOf(name) ?? '');
      if (unit) found.get(unit)?.push(join(dir, name));
    }
  };
  add('build', (name) => UNIT_NAME.exec(name)?.[2]);
  add('deps', (name) => /-([0-9a-f]{16})(\.|$)/.exec(name)?.[1]);
  return found;
}

/** `paths` in the order to remove them: every fingerprint directory first, so an interrupted removal leaves Cargo a unit it must rebuild and never a fingerprint that points at missing files, then `build`, then `deps`. */
export function removalOrder(paths: readonly string[]): string[] {
  const rank = (path: string) => (path.startsWith(`${FINGERPRINT}/`) ? 0 : path.startsWith('build/') ? 1 : 2);
  return paths.toSorted((a, b) => rank(a) - rank(b));
}
