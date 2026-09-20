import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { openSync } from 'node:fs';
import { getExecutor } from './exec.ts';

const LOG_FILE_FLAG = '--log-file';

/**
 * How a detached Node entry is started on win32. libuv spawns with bInheritHandles=TRUE and never
 * closes the CRT's stdio descriptors, so every child inherits every inheritable handle this process
 * holds, including the pipe a `stim start | Out-File x` pipeline gave it for stdout; a detached
 * child then keeps that pipe open and the pipeline never completes (libuv/libuv#1490, fixed by
 * libuv/libuv#5100 but not in a released Node.js). ShellExecuteEx passes no handles, and Windows
 * PowerShell's Start-Process uses it when nothing is redirected, so the entry is started through
 * it and, holding no stray handle, redirects itself into the log file (`relaunchWithLogFile`).
 * The direct child is only the short-lived PowerShell process.
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
}): { file: string; args: string[] } {
  const commandLine = [entry, ...args, LOG_FILE_FLAG, logFile].map(windowsArgument).join(' ');
  const script =
    `Start-Process -WindowStyle Hidden -FilePath ${powershellString(execPath)} ` +
    `-ArgumentList ${powershellString(commandLine)} -WorkingDirectory ${powershellString(cwd)}`;
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
