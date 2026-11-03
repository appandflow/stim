import { statSync, truncateSync } from 'node:fs';
import { maintenanceChildLogFile } from '@stim-cli/core/state';

const CHILD_LOG_MAX_BYTES = 64 * 1024;

export function capChildLog(): void {
  try {
    const file = maintenanceChildLogFile();
    if (statSync(file).size > CHILD_LOG_MAX_BYTES) truncateSync(file);
  } catch {}
}
