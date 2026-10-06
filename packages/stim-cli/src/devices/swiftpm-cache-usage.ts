import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSwiftpmCacheUsage, swiftpmCacheUsageFile, type SwiftpmCacheUsage } from '@stim-cli/core/state';
import { canonical, measureDu, writeUsageCache } from './report-only-usage.ts';

export async function getSwiftpmCacheUsage({
  maxAgeMs = 10 * 60_000,
}: { maxAgeMs?: number } = {}): Promise<SwiftpmCacheUsage> {
  const dir = canonical(
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'org.swift.swiftpm')
      : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'org.swift.swiftpm'),
  );
  const cached = readSwiftpmCacheUsage();
  const age = cached ? Date.now() - Date.parse(cached.measuredAt) : Infinity;
  if (cached && cached.dir === dir && age >= 0 && age < maxAgeMs) return cached;
  const present = existsSync(dir);
  const result = present ? await measureDu(['-sk', dir]) : null;
  const bytes = present ? (result?.complete ? (result.sizes.get(dir) ?? null) : null) : 0;
  const usage: SwiftpmCacheUsage = {
    version: 1,
    measuredAt: new Date().toISOString(),
    dir,
    present,
    bytes,
    complete: bytes !== null,
  };
  writeUsageCache(swiftpmCacheUsageFile(), usage);
  return usage;
}
