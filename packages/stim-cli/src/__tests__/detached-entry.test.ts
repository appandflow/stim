import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { relaunchWithLogFile, windowsLauncherArgs } from '../detached-entry.ts';
import { getExecutor } from '../exec.ts';
import { makeChildProcess } from './_factories.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-detached-entry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('the Windows launcher passes paths through the environment without parsing them as PowerShell source', () => {
  const launcher = windowsLauncherArgs({
    entry: 'C:\\Program Files\\stim\\supervisor-run.mjs',
    args: ['--root', "D:\\it's here\\app", '--port', '8082'],
    cwd: "D:\\it's here\\app",
    logFile: 'D:\\home\\logs\\supervisor.log',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  expect(launcher.file).toBe('powershell.exe');
  expect(launcher.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  expect(launcher.args[3]).toContain('[System.Diagnostics.Process]::Start($start)');
  expect(launcher.args[3]).not.toContain("it's here");
  expect(launcher.env).toEqual({
    STIM_WINDOWS_LAUNCH_FILE: 'C:\\Program Files\\nodejs\\node.exe',
    STIM_WINDOWS_LAUNCH_ARGS:
      '"C:\\Program Files\\stim\\supervisor-run.mjs" "--root" "D:\\it\'s here\\app" "--port" "8082" "--log-file" "D:\\home\\logs\\supervisor.log"',
    STIM_WINDOWS_LAUNCH_CWD: "D:\\it's here\\app",
  });
});

test('the Windows launcher escapes a trailing backslash so the closing quote survives the CRT parser', () => {
  const launcher = windowsLauncherArgs({ entry: 'run.mjs', args: ['--root', 'D:\\'], cwd: 'D:\\', logFile: 'x.log' });
  expect(launcher.env.STIM_WINDOWS_LAUNCH_ARGS).toContain('"--root" "D:\\\\"');
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
      timeoutMs: 10000,
    });
    expect(result).toBe('');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(marker, 'utf8').toLowerCase()).toBe(cwd.toLowerCase());
  },
  15000,
);

test('relaunchWithLogFile starts the entry again without the flag, detached, with stdio in the log', () => {
  const logFile = join(dir, 'supervisor.log');
  const calls: Array<{ file: string; args: readonly string[]; opts: SpawnOptions }> = [];
  const child = relaunchWithLogFile(['--root', dir, '--log-file', logFile, '--port', '8082'], {
    entry: '/opt/stim/supervisor-run.mjs',
    spawn(file, args, opts) {
      calls.push({ file, args, opts });
      return makeChildProcess();
    },
  });
  expect(child).not.toBeNull();
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call?.file).toBe(process.execPath);
  expect(call?.args).toEqual(['/opt/stim/supervisor-run.mjs', '--root', dir, '--port', '8082']);
  expect(call?.opts.detached).toBe(true);
  const stdio = call?.opts.stdio;
  expect(Array.isArray(stdio) && stdio[0]).toBe('ignore');
  expect(Array.isArray(stdio) && typeof stdio[1]).toBe('number');
  expect(Array.isArray(stdio) && stdio[1]).toBe(Array.isArray(stdio) && stdio[2]);
  writeSync(Array.isArray(stdio) ? (stdio[1] as number) : -1, 'supervisor output\n');
  expect(readFileSync(logFile, 'utf-8')).toBe('supervisor output\n');
});

test('relaunchWithLogFile leaves an argv without the flag alone', () => {
  let spawned = false;
  const child = relaunchWithLogFile(['--root', dir, '--port', '8082'], {
    spawn() {
      spawned = true;
      return makeChildProcess();
    },
  });
  expect(child).toBeNull();
  expect(spawned).toBe(false);
});
