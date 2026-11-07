import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A digest of Stim's built code: the first 16 hex characters of the sha256 over the sorted `*.mjs` names and
 * bytes of a `stim` `dist` directory. A remote machine that reports no build compatibility version offloads only
 * with the same one. With `suffix` `.cjs` over `dist/injected`, it names the files Stim injects into a project's
 * Metro.
 */
export function stimBuildDigest(dir: string, suffix = '.mjs'): string | null {
  try {
    const hash = createHash('sha256');
    const names = readdirSync(dir)
      .filter((entry) => entry.endsWith(suffix))
      .toSorted();
    if (names.length === 0) return null;
    for (const name of names) {
      hash.update(name);
      hash.update(readFileSync(join(dir, name)));
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** A build's id: the first 12 hex characters of its digest, which names its tree in the engine store. */
export function stimBuildId(dir: string): string | null {
  return stimBuildDigest(dir)?.slice(0, 12) ?? null;
}
