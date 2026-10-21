import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a client and a remote machine must agree on to build for each other: what a worker builds and how, the
 * artifacts it returns and the build and artifact messages. Two machines with the same value offload whatever their
 * Stim builds; `scripts/build-compat.json` records the files a change to which needs a bump or a recorded no-bump.
 */
export const STIM_BUILD_COMPAT = 1;

/**
 * A digest of Stim's built code: the first 16 hex characters of the sha256 over the sorted `*.mjs` names and
 * bytes of a `stim` `dist` directory. A remote machine that reports no {@link STIM_BUILD_COMPAT} offloads only with the
 * same one.
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
