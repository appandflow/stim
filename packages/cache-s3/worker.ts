import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface WorkerReply<T> {
  value?: T;
  error?: { message: string; code?: string };
}

export function scopedWorker<T>(
  worker: URL,
  input: object,
  {
    env,
    cwd,
    signal,
    timeoutMs,
    name,
  }: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    name: string;
  },
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(worker)], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let reply: WorkerReply<T> | undefined;
    let failure: unknown;
    let closed = false;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (closed || !child.pid) return;
      if (process.platform === 'win32') {
        stopping ??= new Promise<void>((done) => {
          const killer = spawn(
            join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true },
          );
          killer.once('error', (error) => {
            failure ??= error;
          });
          killer.once('close', (code) => {
            if (code !== 0) failure ??= new Error(`${name} process cleanup failed.`);
            done();
          });
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure ??= error;
        }
      }
    };
    const timer = setTimeout(() => {
      failure = new Error(`${name} did not finish within ${timeoutMs / 1000} seconds.`);
      stop();
    }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('spawn', () => {
      if (signal.aborted) stop();
      else
        child.send(input, (error) => {
          if (error) {
            failure = error;
            stop();
          }
        });
    });
    child.once('message', (message: WorkerReply<T>) => {
      reply = message;
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', async (code) => {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      await stopping;
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (reply?.error) reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
      else if (code !== 0 || reply?.value === undefined) reject(new Error(`Could not complete ${name}.`));
      else resolve(reply.value);
    });
  });
}
