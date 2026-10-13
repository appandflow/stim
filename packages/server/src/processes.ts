import { execFile } from 'node:child_process';

function run(file: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 ** 2 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

function listProcesses(columns = 'pid=,command='): Promise<string> {
  return run('/bin/ps', ['-A', '-ww', '-o', columns]);
}

/** One `<pid> <command line>` line per process. Windows has no `ps`; its Win32_Process class carries the command line. */
export function listCommandLines(): Promise<string> {
  if (process.platform !== 'win32') return listProcesses();
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
    ],
    30_000,
  );
}
