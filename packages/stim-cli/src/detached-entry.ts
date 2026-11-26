import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { openSync } from 'node:fs';
import { getExecutor, windowsSystemExecutable } from './exec.ts';

const LOG_FILE_FLAG = '--log-file';

const LAUNCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$cmd, $cwd, $console, $log = $env:STIM_WINDOWS_LAUNCH_ARGS, $env:STIM_WINDOWS_LAUNCH_CWD, $env:STIM_WINDOWS_LAUNCH_CONSOLE, $env:STIM_WINDOWS_LAUNCH_LOG',
  "foreach ($name in 'ARGS', 'CWD', 'CONSOLE', 'LOG') { [Environment]::SetEnvironmentVariable('STIM_WINDOWS_LAUNCH_' + $name, $null) }",
  "$type = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('StimLaunch'), 'Run').DefineDynamicModule('StimLaunch').DefineType('StimLaunch', 'Public, Sealed, Abstract')",
  "foreach ($native in @(@('CreateProcessW', @([IntPtr], [Text.StringBuilder], [IntPtr], [IntPtr], [bool], [int], [IntPtr], [string], [IntPtr], [IntPtr])), @('InitializeProcThreadAttributeList', @([IntPtr], [int], [int], [IntPtr].MakeByRefType())), @('UpdateProcThreadAttribute', @([IntPtr], [int], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr])), @('SetHandleInformation', @([IntPtr], [int], [int])))) { $type.DefinePInvokeMethod($native[0], 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], $native[1], 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig') }",
  '$k = $type.CreateType()',
  '$p = [IntPtr]::Size',
  '$reserved2 = 4 * $p + 36 + (($p - (4 * $p + 36) % $p) % $p)',
  '$si = [Runtime.InteropServices.Marshal]::AllocHGlobal($reserved2 + 5 * $p)',
  '[Runtime.InteropServices.Marshal]::Copy([byte[]]::new($reserved2 + 5 * $p), 0, $si, $reserved2 + 5 * $p)',
  "$size, $flags, $startFlags, $inherit = ($reserved2 + 4 * $p), $(if ($console -eq 'none') { 0x8 } else { 0x10 }), $(if ($console -eq 'hidden') { 0x1 } else { 0 }), $false",
  'if ($log) {',
  "  $stream = [IO.File]::Open($log, 'Create', 'Write', 'ReadWrite, Delete')",
  '  $handle = $stream.SafeFileHandle.DangerousGetHandle()',
  '  $listSize = [IntPtr]::Zero',
  '  [void]$k::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$listSize)',
  '  $list = [Runtime.InteropServices.Marshal]::AllocHGlobal($listSize)',
  '  $handles = [Runtime.InteropServices.Marshal]::AllocHGlobal($p)',
  '  [Runtime.InteropServices.Marshal]::WriteIntPtr($handles, $handle)',
  "  if (!$k::SetHandleInformation($handle, 1, 1) -or !$k::InitializeProcThreadAttributeList($list, 1, 0, [ref]$listSize) -or !$k::UpdateProcThreadAttribute($list, 0, [IntPtr]0x20002, $handles, [IntPtr]$p, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not pass the log file to the process.' }",
  '  [Runtime.InteropServices.Marshal]::WriteIntPtr($si, $reserved2 + 2 * $p, $handle)',
  '  [Runtime.InteropServices.Marshal]::WriteIntPtr($si, $reserved2 + 3 * $p, $handle)',
  '  [Runtime.InteropServices.Marshal]::WriteIntPtr($si, $reserved2 + 4 * $p, $list)',
  '  $size, $flags, $startFlags, $inherit = ($size + $p), ($flags -bor 0x80000), ($startFlags -bor 0x100), $true',
  '}',
  '[Runtime.InteropServices.Marshal]::WriteInt32($si, 0, $size)',
  '[Runtime.InteropServices.Marshal]::WriteInt32($si, 4 * $p + 28, $startFlags)',
  '$pi = [Runtime.InteropServices.Marshal]::AllocHGlobal(2 * $p + 8)',
  "if (!$k::CreateProcessW([IntPtr]::Zero, [Text.StringBuilder]::new($cmd), [IntPtr]::Zero, [IntPtr]::Zero, $inherit, ($flags -bor 0x1000000), [IntPtr]::Zero, $cwd, $si, $pi) -and !$k::CreateProcessW([IntPtr]::Zero, [Text.StringBuilder]::new($cmd), [IntPtr]::Zero, [IntPtr]::Zero, $inherit, $flags, [IntPtr]::Zero, $cwd, $si, $pi)) { throw ('Could not start ' + $cmd) }",
  '[Console]::Out.Write([Runtime.InteropServices.Marshal]::ReadInt32($pi, 2 * $p))',
].join('\n');

/**
 * How a process that outlives its launcher starts on win32, through a short-lived PowerShell process that prints its id.
 * Windows OpenSSH runs each session in a job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so a process left in
 * that job dies with the session, and libuv's `detached` does not leave the job (libuv `process.c` skips
 * CREATE_BREAKAWAY_FROM_JOB because CreateProcess fails under a job that refuses breakaway). The launcher calls
 * CreateProcessW with CREATE_BREAKAWAY_FROM_JOB, and again without it when that fails. libuv also spawns with
 * bInheritHandles=TRUE (libuv/libuv#1490, fixed by libuv/libuv#5100 but not in a released Node.js), so a child keeps
 * open the pipe a `stim start | Out-File x` pipeline gave this process; the process inherits only `logFile`, through
 * PROC_THREAD_ATTRIBUTE_HANDLE_LIST, as stdout and stderr. `console` is a new hidden console, a new console, or none.
 * The script calls no cmdlet: stimd's launch environment has no PSModulePath, and Windows PowerShell 5.1 then searches
 * for the first cmdlet's module for tens of seconds.
 * The STARTUPINFOEXW offsets follow
 * https://learn.microsoft.com/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow.
 */
export function windowsDetachedLaunchArgs({
  file,
  args,
  cwd,
  console = 'new',
  logFile,
}: {
  file: string;
  args: readonly string[];
  cwd: string;
  console?: 'hidden' | 'new' | 'none';
  logFile?: string;
}): { file: string; args: string[]; env: Record<string, string> } {
  return {
    file: windowsSystemExecutable('powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', LAUNCH_SCRIPT],
    env: {
      STIM_WINDOWS_LAUNCH_ARGS: [file, ...args].map(windowsArgument).join(' '),
      STIM_WINDOWS_LAUNCH_CWD: cwd,
      STIM_WINDOWS_LAUNCH_CONSOLE: console,
      STIM_WINDOWS_LAUNCH_LOG: logFile ?? '',
    },
  };
}

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

function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
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
