import { getExecutor } from './exec.ts';

// @ref LLP 0021#stimd-runs-at-the-priority-of-an-app -- size walks at normal pressure and trash deletes below critical throttle their I/O

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

/**
 * Whether a walk failed before it printed a size: its wrapper could not be spawned, or it exited nonzero with nothing on stdout,
 * as an `ionice` that rejects its arguments or is refused the class does. A walk killed at its deadline is not.
 */
function failedBeforeOutput(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('code' in error && ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))) return true;
  const status = 'status' in error ? error.status : undefined;
  const stdout = 'stdout' in error ? error.stdout : undefined;
  return typeof status === 'number' && status !== 0 && !(typeof stdout === 'string' && stdout.trim());
}

/** Runs `walk` on the low-priority command line, and once more under `nice` alone when a throttled walk printed nothing. */
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
    if (command === 'nice' || !failedBeforeOutput(error)) throw error;
    return walk(...lowPriorityCommand(file, args, false));
  }
}
