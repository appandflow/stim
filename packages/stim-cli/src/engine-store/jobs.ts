import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import { BUILD_DIR, FORMAT, writeRecord } from './store.ts';

const JOB_KEEP_MS = 24 * 60 * 60_000;
const JOB_BUILDS_KEPT = 3;

/** A client build offload jobs ran here: `<root>/jobs/<build>.json`, written at install and at each job's start. */
export type JobUse = { build: string; version: string | null; usedAt: number };

/** Records that offload jobs use `build` now, before its tree enters the store, so GC keeps it until the job starts. */
export function recordJobUse(root: string, build: string, version: string | null): void {
  mkdirSync(join(root, 'jobs'), { recursive: true });
  writeRecord(join(root, 'jobs', `${build}.json`), { format: FORMAT, version, usedAt: new Date().toISOString() });
}

export function readJobUses(root: string): JobUse[] {
  let names: string[];
  try {
    names = readdirSync(join(root, 'jobs'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const build = name.replace(/\.json$/, '');
    if (!BUILD_DIR.test(build)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(join(root, 'jobs', name), 'utf8'));
      if (!isJsonObject(value) || typeof value.usedAt !== 'string') return [];
      const usedAt = Date.parse(value.usedAt);
      return Number.isFinite(usedAt)
        ? [{ build, version: typeof value.version === 'string' ? value.version : null, usedAt }]
        : [];
    } catch {
      return [];
    }
  });
}

/** The client builds GC keeps on a worker: the three most recently used by offload jobs within the last 24 hours. */
export const keptJobUses = (uses: readonly JobUse[], now: number): JobUse[] =>
  uses
    .filter((use) => now - use.usedAt < JOB_KEEP_MS)
    .toSorted((a, b) => b.usedAt - a.usedAt)
    .slice(0, JOB_BUILDS_KEPT);

/**
 * The npm cache files that hold the tarballs of `versions` of `stim`: each cacache index file whose entry's key names
 * one of those tarballs, and the content file its integrity names (npm's cacache layout: `index-v5/<a>/<b>/<rest>`,
 * `content-v2/<algorithm>/<hex[0..2]>/<hex[2..4]>/<hex[4..]>`).
 */
export function tarballFiles(cache: string, versions: ReadonlySet<string>): Set<string> {
  const kept = new Set<string>();
  if (versions.size === 0) return kept;
  const base = join(cache, '_cacache');
  let entries;
  try {
    entries = readdirSync(join(base, 'index-v5'), { recursive: true, withFileTypes: true });
  } catch {
    return kept;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const json = line.slice(line.indexOf('\t') + 1);
      let record: unknown;
      try {
        record = JSON.parse(json);
      } catch {
        continue;
      }
      if (!isJsonObject(record) || typeof record.key !== 'string' || typeof record.integrity !== 'string') continue;
      const version = /\/stim\/-\/stim-([^/]+)\.tgz$/.exec(record.key)?.[1];
      if (!version || !versions.has(version)) continue;
      kept.add(file);
      const [algorithm, digest] = (record.integrity.split(' ')[0] ?? '').split('-');
      if (!algorithm || !digest) continue;
      const hex = Buffer.from(digest, 'base64').toString('hex');
      kept.add(join(base, 'content-v2', algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)));
    }
  }
  return kept;
}
