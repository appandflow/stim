import { join } from 'node:path';
import { configDir } from '../index.ts';

/** Changes whenever fingerprint input rows or their bytes change. */
export const FINGERPRINT_SCHEMA = 2;

/** The lockfiles that mark an install root, in the order a directory's lockfile is chosen. */
export const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'] as const;

/** Validation records of Stim's own fingerprint, one directory per checkout identity and layout under a platform. */
export function fingerprintIndexDir(platform?: string, home?: string): string {
  const root = join(home ?? configDir(), 'fingerprint');
  return platform ? join(root, platform) : root;
}

/** Index hits waiting for the background passes to recompute them, one file per index directory. */
export function fingerprintPendingVerifyDir(home?: string): string {
  return join(fingerprintIndexDir(undefined, home), 'pending-verify');
}

/** The env each workspace last computed a fingerprint under, so precompute and verification can reproduce it. */
export function fingerprintEnvDir(home?: string): string {
  return join(fingerprintIndexDir(undefined, home), 'env');
}

export function fingerprintIndexLock(home?: string): string {
  return join(home ?? configDir(), 'fingerprint.lock');
}
