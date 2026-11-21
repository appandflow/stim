import { realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
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
import { answered, Unanswered } from '../workspace/bounded-read.ts';
import type { Config } from '../workspace/config.ts';
import { idleOutputs } from './idle.ts';
import type { CheckoutReading } from './stages.ts';

const realpathAsync = promisify(realpath);

/** The mark writer of one walk, which resolves the Metro cache root once for every checkout it marks. */
export function markWriter(config: Config, signal?: AbortSignal): (reading: CheckoutReading) => Promise<void> {
  const metroCache = metroCacheRoot();
  return async (reading) => {
    const expiresAt = Date.now() + 3_000;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Unanswered('mark read deadline')), 3_000);
    const readingSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      await writeMark(config, reading, readingSignal, metroCache, expiresAt);
    } finally {
      clearTimeout(timer);
    }
  };
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
  expiresAt: number,
): Promise<void> {
  const root = await answered(reading.path, () => realpathAsync(reading.path), 3_000, signal);
  // Node's synchronous filesystem checks inside idleOutputs cannot be interrupted by this deadline.
  const { paths, targets } = await idleOutputs(reading.path, config, undefined, {
    signal,
    inUse: false,
    metroCache,
  });
  if (Date.now() >= expiresAt) throw new Unanswered('mark read deadline');
  const device = (await answered(root, () => stat(root), 3_000, signal)).dev;
  signal?.throwIfAborted();
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
    device,
    markedAt,
    ...(dirtyAt && Date.parse(dirtyAt) > reading.at ? { dirtyAt } : {}),
    lastActivityAt: reading.lastActivityAt === null ? null : new Date(reading.lastActivityAt).toISOString(),
    candidates,
  };
  signal?.throwIfAborted();
  if (Date.now() >= expiresAt) throw new Unanswered('mark read deadline');
  writeCacheFile(gcMarkFile(root), mark);
}
