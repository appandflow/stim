import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  logName = 'test',
  signal,
  onOutput,
}: {
  command: readonly [string, ...string[]];
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifactsDir: string;
  logName?: 'test' | 'artifact';
  signal?: AbortSignal;
  onOutput?: (event: { stream: 'stdout' | 'stderr'; message: string }) => void;
}): Promise<CommandResult> {
  signal?.throwIfAborted();
  const started = Date.now();
  const stdout = join(artifactsDir, `${logName}.stdout.log`);
  const stderr = join(artifactsDir, `${logName}.stderr.log`);
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
    let groupError: string | undefined;
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
          if ((caught as NodeJS.ErrnoException).code !== 'ESRCH') groupError ??= String(caught);
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
      const status = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (exitCode, exitSignal) => {
          resolve({ exitCode, signal: exitSignal });
        });
      });
      if (process.platform !== 'win32' && child.pid) {
        const deadline = Date.now() + 2000;
        while (true) {
          try {
            process.kill(-child.pid, 0);
          } catch (caught) {
            const code = (caught as NodeJS.ErrnoException).code;
            if (code === 'ESRCH') break;
            if (code !== 'EPERM') {
              error ??= String(caught);
              break;
            }
            // XNU killpg1 returns EPERM for a zombie-only group; require ESRCH before completion.
            // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c#L1612-L1621
            groupError ??= String(caught);
          }
          if (Date.now() >= deadline) {
            error ??= groupError ?? `Test process group ${child.pid} did not exit after termination`;
            break;
          }
          await delay(20);
        }
      }
      return {
        ...status,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        ...(error ? { error } : {}),
      };
    } finally {
      signal?.removeEventListener('abort', terminate);
      clearTimeout(killTimer);
    }
  } finally {
    closeSync(out);
    if (err !== undefined) closeSync(err);
  }
}
