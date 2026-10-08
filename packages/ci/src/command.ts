import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function runCommand({
  command,
  cwd,
  env,
  artifactsDir,
  signal,
  onOutput,
}: {
  command: readonly [string, ...string[]];
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifactsDir: string;
  signal?: AbortSignal;
  onOutput?: (event: { stream: 'stdout' | 'stderr'; message: string }) => void;
}): Promise<CommandResult> {
  signal?.throwIfAborted();
  const started = Date.now();
  const stdout = join(artifactsDir, 'test.stdout.log');
  const stderr = join(artifactsDir, 'test.stderr.log');
  const out = openSync(stdout, 'w');
  let err: number | undefined;
  try {
    err = openSync(stderr, 'w');
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let error: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Windows taskkill requires a live root PID to traverse its descendants; commands must not daemonize.
        spawn.sync('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (caught) {
          if ((caught as NodeJS.ErrnoException).code !== 'ESRCH') error ??= String(caught);
        }
      }
    };
    const terminate = () => {
      if (killTimer) return;
      kill(false);
      killTimer = setTimeout(() => kill(true), 1000);
    };
    const output = (stream: 'stdout' | 'stderr', fd: number, chunk: Buffer) => {
      try {
        writeSync(fd, chunk);
        onOutput?.({ stream, message: chunk.toString('utf8') });
      } catch (caught) {
        error ??= String(caught);
        terminate();
      }
    };
    child.stdout!.on('data', (chunk: Buffer) => output('stdout', out, chunk));
    child.stderr!.on('data', (chunk: Buffer) => output('stderr', err!, chunk));
    child.on('error', (caught) => {
      error ??= caught.message;
    });
    child.once('exit', terminate);
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    try {
      return await new Promise<CommandResult>((resolve) => {
        child.once('close', (exitCode, exitSignal) => {
          resolve({
            exitCode,
            signal: exitSignal,
            durationMs: Date.now() - started,
            stdout,
            stderr,
            ...(error ? { error } : {}),
          });
        });
      });
    } finally {
      signal?.removeEventListener('abort', terminate);
      clearTimeout(killTimer);
    }
  } finally {
    closeSync(out);
    if (err !== undefined) closeSync(err);
  }
}
