import { execFile } from 'node:child_process';

export function listProcesses(columns = 'pid=,command='): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-A', '-ww', '-o', columns],
      { timeout: 10_000, maxBuffer: 64 * 1024 ** 2 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
