import { copyFileSync } from 'node:fs';

/**
 * Copies a failed build's transcript beside the log, where the next build in the workspace, which truncates the
 * log, leaves it. The name does not end in `.ndjson`, so `stim logs` keeps reading only the current run. A later
 * failed build replaces it. Returns the copy's path, or the log's own path when it cannot be copied.
 */
export function retainFailedTranscript(logFile: string): string {
  const kept = `${logFile}.failed`;
  try {
    copyFileSync(logFile, kept);
    return kept;
  } catch {
    return logFile;
  }
}
