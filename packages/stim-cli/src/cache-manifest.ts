import { register as registerAt, unregister as unregisterAt, type CacheEntry } from './cache/cache-manifest.ts';

export type { CacheEntry };

/** Lists a cache directory in this Stim home's cache manifest, so `stim gc` measures and prunes it. */
export function register(entry: CacheEntry): CacheEntry {
  return registerAt(entry);
}

/** Removes a cache directory from this Stim home's cache manifest; returns whether it was listed. */
export function unregister(dir: string): boolean {
  return unregisterAt(dir);
}
