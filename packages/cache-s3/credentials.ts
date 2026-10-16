import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  accountId?: string;
  credentialScope?: string;
}

export function scopedCredentials(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { profile?: string | undefined; region: string },
  signal: AbortSignal,
): Promise<ScopedCredentials> {
  signal.throwIfAborted();
  const worker = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? './credentials-worker.ts' : './credentials-worker.mjs', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let credentials: ScopedCredentials | undefined;
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
            if (code !== 0) failure ??= new Error('S3 credential process cleanup failed.');
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
      failure = new Error('S3 credential resolution did not finish within 10 seconds.');
      stop();
    }, 10_000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('spawn', () => {
      if (signal.aborted) stop();
      else
        child.send(options, (error) => {
          if (error) {
            failure = error;
            stop();
          }
        });
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('accessKeyId' in message) || !('secretAccessKey' in message))
        return;
      if (typeof message.accessKeyId !== 'string' || typeof message.secretAccessKey !== 'string') return;
      credentials = {
        accessKeyId: message.accessKeyId,
        secretAccessKey: message.secretAccessKey,
        ...('sessionToken' in message && typeof message.sessionToken === 'string'
          ? { sessionToken: message.sessionToken }
          : {}),
        ...('expiration' in message && typeof message.expiration === 'string'
          ? { expiration: new Date(message.expiration) }
          : {}),
        ...('accountId' in message && typeof message.accountId === 'string' ? { accountId: message.accountId } : {}),
        ...('credentialScope' in message && typeof message.credentialScope === 'string'
          ? { credentialScope: message.credentialScope }
          : {}),
      };
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
      else if (code !== 0 || !credentials)
        reject(new Error('Could not resolve S3 credentials from the client environment.'));
      else resolve(credentials);
    });
  });
}
