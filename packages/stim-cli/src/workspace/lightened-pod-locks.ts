import { createHash } from 'node:crypto';
import { isJsonObject, readJsonObject, workspaceLightenedFile } from '@stim-cli/core/state';

export function podLockHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trimEnd()).digest('hex');
}

export function readLockHashes(record: unknown): Record<string, string> {
  const locks = isJsonObject(record) ? record.locks : undefined;
  if (!isJsonObject(locks)) return {};
  return Object.fromEntries(
    Object.entries(locks).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** The hashes of the `Podfile.lock` files that matched their `Pods/Manifest.lock` when gc deleted `Pods`, by lock path. */
export function lightenedPodLocks(keys: readonly string[]): Record<string, string> {
  return Object.assign({}, ...keys.map((key) => readLockHashes(readJsonObject(workspaceLightenedFile(key)))));
}
