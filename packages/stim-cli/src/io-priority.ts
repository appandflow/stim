import { getExecutor } from './exec.ts';

// @ref LLP 0021#stimd-runs-at-the-priority-of-an-app -- only size walks at normal pressure throttle their I/O

/**
 * The command line that runs a size walk at low priority: under `nice -n 19`, and with `throttleIo` also at a throttled
 * I/O policy, `/usr/sbin/taskpolicy -d utility` on macOS (`nice` lowers only CPU there) and `ionice -t -c3` on Linux
 * when it is on PATH (`-t` runs the walker even when the kernel refuses the class). Each wrapper execs the next, so a
 * timeout or cancel signals the walker itself.
 */
export function lowPriorityCommand(file: string, args: readonly string[], throttleIo: boolean): [string, string[]] {
  const niced = ['-n', '19', file, ...args];
  if (throttleIo && process.platform === 'darwin') return ['/usr/sbin/taskpolicy', ['-d', 'utility', 'nice', ...niced]];
  if (throttleIo && process.platform === 'linux' && getExecutor().findExecutable('ionice') !== null)
    return ['ionice', ['-t', '-c3', 'nice', ...niced]];
  return ['nice', niced];
}

/** Runs `walk` on the low-priority command line, and once more under `nice` alone when the I/O wrapper is missing. */
export async function runLowPriority(
  walk: (file: string, args: string[]) => Promise<string>,
  file: string,
  args: readonly string[],
  throttleIo: boolean,
): Promise<string> {
  const [command, argv] = lowPriorityCommand(file, args, throttleIo);
  try {
    return await walk(command, argv);
  } catch (error) {
    if (command === 'nice' || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return walk(...lowPriorityCommand(file, args, false));
  }
}
