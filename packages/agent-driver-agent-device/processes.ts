import { execFile } from 'node:child_process';

const PROCESS_LIST_TIMEOUT_MS = 10_000;

export function listProcesses(columns = 'pid=,command='): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-A', '-ww', '-o', columns],
      { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 ** 2 },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        const details = [
          error.killed && `timed out after ${PROCESS_LIST_TIMEOUT_MS / 1000}s`,
          typeof error.code === 'number' ? `exit code ${error.code}` : error.code,
          error.signal && `signal ${error.signal}`,
        ].filter(Boolean);
        reject(new Error(`Could not list processes with /bin/ps: ${details.join(', ') || 'unknown error'}.`));
      },
    );
  });
}
