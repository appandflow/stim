import { mkdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { maintenanceAttemptFile, maintenanceChildLogFile, maintenanceDir } from '@stim-cli/core/state';

const CHILD_LOG_MAX_BYTES = 64 * 1024;

/** Records that a child is about to start, so a child that dies before it can write anything does not respawn on every command. */
export function stampAttempt(now: number): void {
  mkdirSync(maintenanceDir(), { recursive: true });
  const file = maintenanceAttemptFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ attemptedAt: now })}\n`);
  try {
    renameSync(tmp, file);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

export function capChildLog(): void {
  try {
    const file = maintenanceChildLogFile();
    if (statSync(file).size > CHILD_LOG_MAX_BYTES) truncateSync(file);
  } catch {}
}
