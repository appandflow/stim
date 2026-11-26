import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsLauncherArgs, windowsDetachedLaunchArgs } from '../detached-entry.ts';
import { getExecutor } from '../exec.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-detached-entry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'win32')(
  'the Windows launcher starts an entry from a path with brackets and a smart quote',
  async () => {
    const cwd = join(dir, '[O\u2019Brien]');
    mkdirSync(cwd);
    const entry = join(cwd, 'entry.cjs');
    const marker = join(dir, 'started.txt');
    // Windows refuses to remove a live process's working directory, and the detached entry may
    // still be exiting when the marker appears, so it leaves `cwd` before writing the marker, and
    // renames the marker into place so the test never deletes it while its write handle is open.
    writeFileSync(
      entry,
      [
        "const fs = require('node:fs');",
        'const cwd = process.cwd();',
        "process.chdir(require('node:os').tmpdir());",
        "fs.writeFileSync(process.env.STIM_LAUNCH_MARKER + '.tmp', cwd);",
        "fs.renameSync(process.env.STIM_LAUNCH_MARKER + '.tmp', process.env.STIM_LAUNCH_MARKER);",
      ].join('\n'),
    );
    const launcher = windowsLauncherArgs({ entry, args: [], cwd, logFile: join(cwd, 'supervisor.log') });
    const result = getExecutor().runFile(launcher.file, launcher.args, {
      cwd: dir,
      env: { ...launcher.env, STIM_LAUNCH_MARKER: marker },
      timeoutMs: 60_000,
    });
    expect(Number(result)).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(marker, 'utf8').toLowerCase()).toBe(cwd.toLowerCase());
  },
  75_000,
);

// Windows OpenSSH runs a session in a job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and JOB_OBJECT_LIMIT_BREAKAWAY_OK.
test.skipIf(process.platform !== 'win32')(
  'a process the Windows launcher starts outlives the kill-on-close job its caller ran in',
  () => {
    const launcher = windowsDetachedLaunchArgs({
      file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'),
      args: ['-n', '60', '127.0.0.1'],
      cwd: tmpdir(),
      console: 'none',
    });
    const job = [
      "$type = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('Job'), 'Run').DefineDynamicModule('Job').DefineType('Job', 'Public, Sealed, Abstract')",
      "$type.DefinePInvokeMethod('CreateJobObjectW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [IntPtr], @([IntPtr], [IntPtr]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
      "$type.DefinePInvokeMethod('SetInformationJobObject', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], @([IntPtr], [int], [IntPtr], [int]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
      "$type.DefinePInvokeMethod('AssignProcessToJobObject', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], @([IntPtr], [IntPtr]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
      '$k = $type.CreateType()',
      '$handle = $k::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)',
      '$limits = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)',
      '[Runtime.InteropServices.Marshal]::Copy([byte[]]::new(144), 0, $limits, 144)',
      '[Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2800)',
      "if (!$k::SetInformationJobObject($handle, 9, $limits, 144) -or !$k::AssignProcessToJobObject($handle, [IntPtr](-1))) { throw 'no job' }",
      '& $env:JOB_LAUNCHER $env:JOB_ARG0 $env:JOB_ARG1 $env:JOB_ARG2 $env:JOB_ARG3',
    ].join('\n');
    const pid = Number(
      getExecutor().runFile(launcher.file, ['-NoProfile', '-NonInteractive', '-Command', job], {
        cwd: dir,
        env: {
          ...launcher.env,
          JOB_LAUNCHER: launcher.file,
          ...Object.fromEntries(launcher.args.map((arg, index) => [`JOB_ARG${index}`, arg])),
        },
        timeoutMs: 60_000,
      }),
    );
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid)).not.toThrow();
  },
  75_000,
);
