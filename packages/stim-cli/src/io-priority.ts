import { getExecutor } from './exec.ts';

// @ref LLP 0021#stimd-runs-at-the-priority-of-an-app -- only size walks at normal pressure throttle their I/O

/**
 * The command line that runs a size walk at low priority: under `nice -n 19`, and with `throttleIo` also at a throttled
 * I/O policy, `/usr/sbin/taskpolicy -d utility` on macOS (`nice` lowers only CPU there) and `ionice -c3` on Linux when
 * it is on PATH. Each wrapper execs the next, so a timeout or cancel signals the walker itself.
 */
export function lowPriorityCommand(file: string, args: readonly string[], throttleIo: boolean): [string, string[]] {
  const niced = ['-n', '19', file, ...args];
  if (throttleIo && process.platform === 'darwin') return ['/usr/sbin/taskpolicy', ['-d', 'utility', 'nice', ...niced]];
  if (throttleIo && process.platform === 'linux' && getExecutor().findExecutable('ionice') !== null)
    return ['ionice', ['-c3', 'nice', ...niced]];
  return ['nice', niced];
}
