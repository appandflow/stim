import type { S3Client } from '@aws-sdk/client-s3';
import { scopedWorker } from './worker.ts';

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
  return scopedWorker<ScopedClientMessage>(
    new URL(import.meta.url.endsWith('.ts') ? './credentials-worker.ts' : './credentials-worker.mjs', import.meta.url),
    options,
    {
      env: { ...env, ...(options.profile ? { AWS_PROFILE: options.profile } : {}) },
      cwd,
      signal,
      timeoutMs: 10_000,
      name: 'S3 credential resolution',
    },
  ).then((context) => {
    const { expiration, ...credentials } = context.credentials;
    return {
      credentials: { ...credentials, ...(expiration ? { expiration: new Date(expiration) } : {}) },
      requestConfig: context.requestConfig,
    };
  });
}
