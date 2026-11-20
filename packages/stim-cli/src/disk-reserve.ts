import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maintenanceDir } from '@stim-cli/core/state';

const RESERVE_BYTES = 1024 * 1024;
const reserveFile = () => join(maintenanceDir(), 'disk-reserve');

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
