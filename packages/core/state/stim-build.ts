import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A digest of Stim's built code: the first 16 hex characters of the sha256 over the sorted `*.mjs` names and
 * bytes of a `stim` `dist` directory. A client and a build machine offload only when both compute the same one.
 */
export function stimBuildDigest(dir: string): string | null {
  try {
    const hash = createHash('sha256');
    const names = readdirSync(dir)
      .filter((entry) => entry.endsWith('.mjs'))
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
