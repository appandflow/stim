import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { maintenanceDir } from '@stim-cli/core/state';

const RESERVE_BYTES = 1024 * 1024;
const reserveFile = () => join(maintenanceDir(), 'disk-reserve');

/** What a run reports once it released the reserve. */
export const RESERVE_RELEASED = 'the disk was full, so Stim released its 1 MiB maintenance disk reserve';

/** Deletes the maintenance disk reserve; true when there was one to delete. A second call finds none. */
export function releaseReserve(): boolean {
  try {
    const bytes = statSync(reserveFile()).size;
    rmSync(reserveFile());
    return bytes > 0;
  } catch {
    return false;
  }
}

/** Writes the 1 MiB maintenance disk reserve back when it is missing and there is room for it. */
export function keepReserve(): void {
  try {
    if (statSync(reserveFile()).size === RESERVE_BYTES) return;
  } catch {}
  try {
    mkdirSync(maintenanceDir(), { recursive: true });
    writeFileSync(reserveFile(), randomBytes(RESERVE_BYTES));
  } catch {
    try {
      rmSync(reserveFile(), { force: true });
    } catch {}
  }
}

export function diskFull(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOSPC' || error.code === 'EDQUOT';
}

const FULL_BYTES = 64 * 1024 * 1024;

// @ref LLP 0005#a-full-disk-releases-the-reserve -- once, before a cleanup that writes or unlinks
/**
 * Deletes the maintenance disk reserve when the volume holding `path` has less than 64 MiB free, so the claims and
 * unlinks of a cleanup that follows have room even on APFS; true when it did. A volume that cannot be read keeps it.
 */
export async function releaseReserveWhenFull(path: string): Promise<boolean> {
  try {
    const volume = await statfs(path);
    if (volume.bavail * volume.bsize >= FULL_BYTES) return false;
  } catch {
    return false;
  }
  return releaseReserve();
}
