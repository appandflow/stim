import { join } from 'node:path';
import { configDir, workspaceStateDir } from '../index.ts';
import { readJsonObject } from './json-file.ts';

/** Changes whenever fingerprint input rows or their bytes change. */
export const FINGERPRINT_SCHEMA = 3;

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

export function warmedNpmInstallFile(project: string): string {
  return join(workspaceStateDir(project), 'warmed-npm-install.json');
}

export function readWarmedNpmInstall(project: string): { stamp: string; inputStats: string } | null {
  const record = readJsonObject(warmedNpmInstallFile(project));
  return typeof record?.stamp === 'string' && typeof record.inputStats === 'string'
    ? { stamp: record.stamp, inputStats: record.inputStats }
    : null;
}
