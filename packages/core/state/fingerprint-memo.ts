import { join } from 'node:path';
import { configDir } from '../index.ts';
import { isJsonObject, readJsonObject } from './json-file.ts';

export const FINGERPRINT_MEMO_SCHEMA = 1;

/** Full native fingerprints shared by every workspace of this Stim home, one file per platform and static digest. */
export function fingerprintMemoDir(platform?: string): string {
  const root = join(configDir(), 'fingerprint-memo');
  return platform ? join(root, platform) : root;
}

export function fingerprintMemoFile(platform: string, digest: string): string {
  return join(fingerprintMemoDir(platform), `${digest}.json`);
}

export function fingerprintMemoLock(): string {
  return join(configDir(), 'fingerprint-memo.lock');
}

/** The full fingerprint a tree with this static digest produced, written by the CLI. */
export interface FingerprintMemoRecord {
  schema: typeof FINGERPRINT_MEMO_SCHEMA;
  platform: string;
  digest: string;
  recordedAt: number;
  hash: string;
  sources: unknown[];
  /** The packages the static check counted as native, to name the ones a disagreeing check found it missed. */
  nativePackages: string[];
}

export function readFingerprintMemo(platform: string, digest: string): FingerprintMemoRecord | null {
  const record = readJsonObject(fingerprintMemoFile(platform, digest));
  if (
    !record ||
    record.schema !== FINGERPRINT_MEMO_SCHEMA ||
    record.platform !== platform ||
    record.digest !== digest ||
    typeof record.recordedAt !== 'number' ||
    typeof record.hash !== 'string' ||
    !record.hash ||
    !Array.isArray(record.sources) ||
    !record.sources.every(isJsonObject) ||
    !Array.isArray(record.nativePackages) ||
    !record.nativePackages.every((name) => typeof name === 'string')
  )
    return null;
  return {
    schema: FINGERPRINT_MEMO_SCHEMA,
    platform,
    digest,
    recordedAt: record.recordedAt,
    hash: record.hash,
    sources: record.sources,
    nativePackages: record.nativePackages,
  };
}
