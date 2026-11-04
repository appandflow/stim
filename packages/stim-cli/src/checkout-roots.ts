import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutRootsCacheFile, isJsonObject, readJsonObject } from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { nativeCanonicalPath, repoRootAsync } from './workspace/worktree.ts';

const CACHE_SCHEMA = 1;

function dotGitFingerprint(checkout: string): string | null {
  try {
    const stat = lstatSync(join(checkout, '.git'));
    const type = stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : 'o';
    return `${type}:${stat.ino}:${stat.uid}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readCache(): Record<string, string> {
  const cache = readJsonObject(checkoutRootsCacheFile());
  if (cache?.schema !== CACHE_SCHEMA || !isJsonObject(cache.checkouts)) return {};
  const recorded: Record<string, string> = {};
  for (const [path, fingerprint] of Object.entries(cache.checkouts))
    if (typeof fingerprint === 'string') recorded[path] = fingerprint;
  return recorded;
}

/**
 * The canonical checkout paths among `checkouts` that Git reports as their own repository root, asking Git only when
 * the `.git` entry no longer matches the one it last confirmed. Not noticed until that entry changes: `safe.directory`
 * in Git's config, or a `HEAD` removed from a linked worktree's administrative directory.
 */
export async function verifiedCheckoutRoots(
  checkouts: readonly string[],
  rootOf: (path: string) => Promise<string | null> = repoRootAsync,
): Promise<Set<string>> {
  const recorded = readCache();
  const confirmed: Record<string, string> = {};
  const verified = new Set<string>();
  await Promise.all(
    checkouts.map(async (path) => {
      const fingerprint = dotGitFingerprint(path);
      if (fingerprint !== null && recorded[path] === fingerprint) {
        confirmed[path] = fingerprint;
        verified.add(path);
        return;
      }
      const root = await rootOf(path);
      if (!root || nativeCanonicalPath(root) !== path) return;
      verified.add(path);
      if (fingerprint !== null) confirmed[path] = fingerprint;
    }),
  );
  const unchanged =
    Object.keys(recorded).length === Object.keys(confirmed).length &&
    Object.entries(confirmed).every(([path, fingerprint]) => recorded[path] === fingerprint);
  if (!unchanged) writeCacheFile(checkoutRootsCacheFile(), { schema: CACHE_SCHEMA, checkouts: confirmed });
  return verified;
}
