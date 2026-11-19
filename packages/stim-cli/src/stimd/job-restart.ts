import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { jobRestartUntil, readJobRestart, stimdJobRestartFile, type JobRestart } from '@stim-cli/core/state';

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Writes `run/job-restart.json`; false when it cannot be written. */
export function writeJobRestart(record: JobRestart): boolean {
  const file = stimdJobRestartFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/**
 * `run/job-restart.json`, whether its stimd still runs, and until when it holds the home for its job. A record whose
 * stimd exited without a `left` gets one now, so every process that waits on it counts from the same moment.
 */
export function jobRestartHold(): { record: JobRestart; running: boolean; until: number } | null {
  let record = readJobRestart();
  if (!record) return null;
  const running = processRuns(record.pid);
  if (!running && record.left === null) {
    const seen = record;
    record = { ...record, left: Date.now() };
    const now = readJobRestart();
    if (now?.pid === seen.pid && now.at === seen.at && now.left === null) writeJobRestart(record);
  }
  return { record, running, until: jobRestartUntil(record, running) };
}
