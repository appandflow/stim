import { join } from 'node:path';
import { configDir } from '../index.ts';

/** The lockfiles that mark an install root, in the order a directory's lockfile is chosen. */
export const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'] as const;

/** Validation records of Stim's own fingerprint, one directory per checkout identity and layout under a platform. */
export function fingerprintIndexDir(platform?: string): string {
  const root = join(configDir(), 'fingerprint');
  return platform ? join(root, platform) : root;
}

/** Index hits waiting for the background passes to recompute them, one file per index directory. */
export function fingerprintPendingVerifyDir(): string {
  return join(fingerprintIndexDir(), 'pending-verify');
}

/** The env each workspace last computed a fingerprint under, so precompute and verification can reproduce it. */
export function fingerprintEnvDir(): string {
  return join(fingerprintIndexDir(), 'env');
}

export function fingerprintIndexLock(): string {
  return join(configDir(), 'fingerprint.lock');
}
