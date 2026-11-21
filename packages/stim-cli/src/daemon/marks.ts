import { statSync } from 'node:fs';
import {
  GC_MARK_VERSION,
  gcMarkFile,
  readDiskUsage,
  readGcMark,
  type GcMark,
  type GcMarkCandidate,
} from '@stim-cli/core/state';
import { metroCacheRoot } from '@stim-cli/core';
import { writeCacheFile } from '../cache-file.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import type { Config } from '../workspace/config.ts';
import { idleOutputs } from './idle.ts';
import type { CheckoutReading } from './stages.ts';

/** The mark writer of one walk, which resolves the Metro cache root once for every checkout it marks. */
export function markWriter(config: Config, signal?: AbortSignal): (reading: CheckoutReading) => Promise<void> {
  const metroCache = metroCacheRoot();
  return (reading) => writeMark(config, reading, signal, metroCache);
}

// @ref LLP 0001#the-lane-marks-what-each-checkout-could-free -- rung 1's outputs without its in-use reads, sized from the cache
/**
 * Writes the mark of one checkout the lane's walk read: the outputs rung 1 lists there and its Cargo `target/`, before
 * the in-use reads, sized from the disk-usage cache. A `dirtyAt` after the walk began reading the checkout stays.
 */
async function writeMark(
  config: Config,
  reading: CheckoutReading,
  signal: AbortSignal | undefined,
  metroCache: string,
): Promise<void> {
  const root = canonicalPath(reading.path);
  const { paths, targets } = await idleOutputs(reading.path, config, undefined, { signal, inUse: false, metroCache });
  const markedAt = new Date(reading.at).toISOString();
  const candidates = paths.map((path): GcMarkCandidate => {
    const size = readDiskUsage(path);
    const candidate: GcMarkCandidate = {
      kind: targets.includes(path) ? 'cargo-target' : 'outputs',
      path,
      bytes: size?.bytes ?? null,
      measuredAt: size?.measuredAt ?? null,
    };
    if (reading.kept !== null) candidate.keep = { reason: reading.kept, at: markedAt };
    return candidate;
  });
  const dirtyAt = readGcMark(root)?.dirtyAt;
  const mark: GcMark = {
    v: GC_MARK_VERSION,
    root,
    device: statSync(root).dev,
    markedAt,
    ...(dirtyAt && Date.parse(dirtyAt) > reading.at ? { dirtyAt } : {}),
    lastActivityAt: reading.lastActivityAt === null ? null : new Date(reading.lastActivityAt).toISOString(),
    candidates,
  };
  writeCacheFile(gcMarkFile(root), mark);
}
