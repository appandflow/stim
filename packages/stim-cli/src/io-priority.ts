// @ref LLP 0021#stimd-runs-at-the-priority-of-an-app -- only size walks run at background priority

/**
 * The command line that runs `file` with `args` at background CPU and I/O priority: `taskpolicy -b` on macOS, whose
 * darwin background policy throttles I/O where `nice` lowers only CPU, `ionice -c3 nice -n 19` on Linux, and the
 * command unchanged on Windows. Each wrapper execs `file`, so a timeout or cancel signals the walker itself.
 */
export function backgroundPriority(file: string, args: readonly string[]): [string, string[]] {
  if (process.platform === 'darwin') return ['taskpolicy', ['-b', file, ...args]];
  if (process.platform === 'win32') return [file, [...args]];
  return ['ionice', ['-c3', 'nice', '-n', '19', file, ...args]];
}
