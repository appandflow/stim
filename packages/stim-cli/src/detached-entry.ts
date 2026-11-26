import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { openSync } from 'node:fs';
import { getExecutor, windowsDetachedLaunchArgs } from './exec.ts';

const LOG_FILE_FLAG = '--log-file';

/**
 * How a detached Node entry starts on win32: through {@link windowsDetachedLaunchArgs} in a hidden console, holding no
 * stray handle, and it redirects itself into `logFile` (`relaunchWithLogFile`).
 */
export function windowsLauncherArgs({
  entry,
  args,
  cwd,
  logFile,
  execPath = process.execPath,
}: {
  entry: string;
  args: readonly string[];
  cwd: string;
  logFile: string;
  execPath?: string;
}): { file: string; args: string[]; env: Record<string, string> } {
  return windowsDetachedLaunchArgs({
    file: execPath,
    args: [entry, ...args, LOG_FILE_FLAG, logFile],
    cwd,
    console: 'hidden',
  });
}

/**
 * Strip `--log-file <path>` from an entry's argv and, when present, start the entry again with
 * the remaining arguments and its stdio in that file. Returns null when the flag is absent; the
 * caller exits after a relaunch.
 */
export function relaunchWithLogFile(
  argv: readonly string[],
  {
    entry = process.argv[1] as string,
    spawn = (file, args, opts) => getExecutor().spawn(file, args, opts),
  }: {
    entry?: string;
    spawn?: (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;
  } = {},
): ChildProcess | null {
  const index = argv.indexOf(LOG_FILE_FLAG);
  if (index < 0) return null;
  const logFile = argv[index + 1];
  if (!logFile) throw new Error(`${LOG_FILE_FLAG} needs a path.`);
  const rest = [...argv.slice(0, index), ...argv.slice(index + 2)];
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry, ...rest], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref?.();
  return child;
}
