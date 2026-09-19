import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The fingerprint this run built or hit, and the one before it.
export const KEEP = 2;

const STAGING = /\.staging-\d+$/;

export function trimBuildCache(root, { keep = KEEP } = {}) {
  const kept = [];
  let platforms;
  try {
    platforms = readdirSync(root);
  } catch {
    return kept;
  }
  for (const platform of platforms) {
    const dir = join(root, platform);
    if (!statSync(dir).isDirectory()) continue;
    const live = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory() && !STAGING.test(name)) live.push({ name, path, mtimeMs: stat.mtimeMs });
      else rmSync(path, { recursive: true, force: true });
    }
    const newest = live.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of newest.slice(keep)) rmSync(entry.path, { recursive: true, force: true });
    for (const entry of newest.slice(0, keep)) kept.push(`${platform}/${entry.name}`);
  }
  return kept.toSorted();
}

export function buildCacheKey(prefix, kept) {
  if (!kept.length) return '';
  return `${prefix}-${kept.map((entry) => entry.split('/')[1].slice(0, 12)).join('-')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, prefix] = process.argv.slice(2);
  if (!root || !prefix) {
    console.error('usage: e2e-build-cache.mjs <build-cache-root> <key-prefix>');
    process.exit(2);
  }
  const kept = trimBuildCache(root);
  console.error(kept.length ? `build cache entries kept: ${kept.join(', ')}` : 'build cache is empty');
  console.log(`key=${buildCacheKey(prefix, kept)}`);
}
