import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { relaunchWithLogFile, windowsLauncherArgs } from '../detached-entry.ts';
import { makeChildProcess } from './_factories.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-detached-entry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('the Windows launcher starts the entry through Start-Process with every path quoted for both shells', () => {
  const launcher = windowsLauncherArgs({
    entry: 'C:\\Program Files\\stim\\supervisor-run.mjs',
    args: ['--root', "D:\\it's here\\app", '--port', '8082'],
    cwd: "D:\\it's here\\app",
    logFile: 'D:\\home\\logs\\supervisor.log',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  expect(launcher.file).toBe('powershell.exe');
  expect(launcher.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  expect(launcher.args[3]).toBe(
    "Start-Process -WindowStyle Hidden -FilePath 'C:\\Program Files\\nodejs\\node.exe' " +
      `-ArgumentList '"C:\\Program Files\\stim\\supervisor-run.mjs" "--root" "D:\\it''s here\\app" "--port" "8082" "--log-file" "D:\\home\\logs\\supervisor.log"' ` +
      "-WorkingDirectory 'D:\\it''s here\\app'",
  );
});

test('the Windows launcher escapes a trailing backslash so the closing quote survives the CRT parser', () => {
  const launcher = windowsLauncherArgs({ entry: 'run.mjs', args: ['--root', 'D:\\'], cwd: 'D:\\', logFile: 'x.log' });
  expect(launcher.args[3]).toContain('"--root" "D:\\\\"');
});

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
