import type { S3Client } from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  accountId?: string;
  credentialScope?: string;
}

interface ScopedRequestConfig {
  endpoint?: string;
  disableClockSkewCorrection: boolean;
  useFipsEndpoint: boolean;
  useDualstackEndpoint: boolean;
  useArnRegion: boolean | undefined;
  disableS3ExpressSessionAuth: boolean | undefined;
  authSchemePreference: string[];
  sigv4aSigningRegionSet: string[] | undefined;
  maxAttempts: number;
  retryMode: string;
  defaultsMode: Extract<S3Client['config']['defaultsMode'], string>;
  userAgentAppId: string | undefined;
}

export interface ScopedClientContext {
  credentials: ScopedCredentials;
  requestConfig: ScopedRequestConfig;
}

export interface ScopedClientMessage {
  credentials: Omit<ScopedCredentials, 'expiration'> & { expiration?: string | undefined };
  requestConfig: ScopedRequestConfig;
}

export function scopedClientContext(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { profile?: string | undefined; region: string; endpoint?: string | undefined },
  signal: AbortSignal,
): Promise<ScopedClientContext> {
  signal.throwIfAborted();
  const worker = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? './credentials-worker.ts' : './credentials-worker.mjs', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      cwd,
      env: { ...env, ...(options.profile ? { AWS_PROFILE: options.profile } : {}) },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let context: ScopedClientMessage | undefined;
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
    child.once('message', (message: ScopedClientMessage) => {
      context = message;
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
      else if (code !== 0 || !context)
        reject(new Error('Could not resolve S3 credentials from the client environment.'));
      else {
        const { expiration, ...credentials } = context.credentials;
        resolve({
          credentials: { ...credentials, ...(expiration ? { expiration: new Date(expiration) } : {}) },
          requestConfig: context.requestConfig,
        });
      }
    });
  });
}
