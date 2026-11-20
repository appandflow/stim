import { getExecutor, runsRealCommands } from './exec.ts';

let ionice: boolean | undefined;

function ioniceInstalled(): boolean {
  if (ionice !== undefined) return ionice;
  const found = getExecutor().findExecutable('ionice') !== null;
  if (runsRealCommands()) ionice = found;
  return found;
}

// @ref LLP 0021#stimd-runs-at-the-priority-of-an-app -- only size walks at normal pressure throttle their I/O

/**
 * The command line that runs a size walk at low priority: under `nice -n 19`, and with `throttleIo` also at a throttled
 * I/O policy, `taskpolicy -d utility` on macOS (`nice` lowers only CPU there) and `ionice -c3` on Linux when it is on
 * PATH. Each wrapper execs the next, so a timeout or cancel signals the walker itself.
 */
export function lowPriorityCommand(file: string, args: readonly string[], throttleIo: boolean): [string, string[]] {
  const niced = ['-n', '19', file, ...args];
  if (throttleIo && process.platform === 'darwin') return ['taskpolicy', ['-d', 'utility', 'nice', ...niced]];
  if (throttleIo && process.platform === 'linux' && ioniceInstalled()) return ['ionice', ['-c3', 'nice', ...niced]];
  return ['nice', niced];
}
