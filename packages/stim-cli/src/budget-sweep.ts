import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { budgetSweepFile, budgetSweepLock, readJsonObject } from '@stim-cli/core/state';
import { withDirLock } from './dir-lock.ts';

export const EMPTY_SWEEP_WINDOW_MS: number = 5 * 60 * 1000;
export const EMPTY_SWEEP_DISK_DROP_MB: number = 1024;

/** A cache trim that removed nothing: when it ran, the lowest free disk it saw, and which caches it walked. */
export interface EmptySweep {
  at: number;
  freeMb: number;
  marker: string;
}

/** Identifies the set of caches a trim walked and the age it trimmed at; a new or removed cache changes it. */
export function sweepMarker(caches: readonly { name: string; dir: string }[], olderThanDays: number): string {
  const hash = createHash('sha256').update(String(olderThanDays));
  for (const line of caches.map((cache) => `${cache.name}\0${cache.dir}`).toSorted()) hash.update('\n').update(line);
  return hash.digest('hex');
}

/**
 * Whether a trim can be skipped: the last one removed nothing, from the same caches, under
 * EMPTY_SWEEP_WINDOW_MS ago, and free disk has not fallen more than EMPTY_SWEEP_DISK_DROP_MB since.
 */
export function canSkipEmptySweep(
  recorded: EmptySweep | null,
  now: { at: number; freeMb: number; marker: string },
): boolean {
  if (!recorded || recorded.marker !== now.marker) return false;
  const age = now.at - recorded.at;
  return age >= 0 && age < EMPTY_SWEEP_WINDOW_MS && recorded.freeMb - now.freeMb <= EMPTY_SWEEP_DISK_DROP_MB;
}

export function readEmptySweep(): EmptySweep | null {
  const value = readJsonObject(budgetSweepFile());
  if (!value) return null;
  const { at, freeMb, marker } = value;
  return typeof at === 'number' &&
    Number.isFinite(at) &&
    typeof freeMb === 'number' &&
    Number.isFinite(freeMb) &&
    typeof marker === 'string'
    ? { at, freeMb, marker }
    : null;
}

/** Records an empty trim, or forgets the record when `sweep` is null. A failed write only costs the next run a walk. */
export function writeEmptySweep(sweep: EmptySweep | null): void {
  const file = budgetSweepFile();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    withDirLock(budgetSweepLock(), () => {
      if (!sweep) return rmSync(file, { force: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(sweep), { mode: 0o600 });
      renameSync(tmp, file);
    });
  } catch {}
}
