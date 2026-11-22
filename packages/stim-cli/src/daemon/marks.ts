import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { join, resolve } from 'node:path';
import { realpathAsync } from '../commands/gc/paths.ts';
import { readFile, readdir, stat } from 'node:fs/promises';
import {
  GC_MARK_VERSION,
  gcMarkFile,
  gcLogDir,
  parseGcMark,
  isJsonObject,
  readDiskUsage,
  readGcMark,
  type GcMark,
  type GcMarkCandidate,
} from '@stim-cli/core/state';
import { metroCacheRoot, type StimContext } from '@stim-cli/core';
import { writeCacheFile } from '../cache-file.ts';
import { answered, Unanswered } from '../workspace/bounded-read.ts';
import type { Config } from '../workspace/config.ts';
import { idleOutputs } from './idle.ts';
import { dormantAfterMs, readCheckout, type CheckoutReading, type DeviceReading } from './stages.ts';
import { discoverCheckouts, targetedCheckouts } from '../workspace/discovery.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';

/** The mark writer of one walk, which resolves the Metro cache root once for every checkout it marks. */
export function markWriter(
  config: Config,
  signal?: AbortSignal,
  dueOnly = false,
): (reading: CheckoutReading) => Promise<void> {
  const metroCache = metroCacheRoot();
  return async (reading) => {
    const expiresAt = Date.now() + 3_000;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Unanswered('mark read deadline')), 3_000);
    const readingSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      await writeMark(config, reading, readingSignal, metroCache, expiresAt, dueOnly);
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
  dueOnly: boolean,
): Promise<void> {
  const root = await answered(reading.path, () => realpathAsync(reading.path), 3_000, signal);
  if (dueOnly && !markDue(readGcMark(root), reading.at, dormantAfterMs(config))) return;
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
  const candidates: GcMarkCandidate[] = [];
  for (const path of paths) {
    const size = readDiskUsage(path);
    const candidate: GcMarkCandidate = {
      kind: targets.includes(path) ? 'cargo-target' : 'outputs',
      path,
      device: (await answered(path, () => stat(path), 3_000, signal)).dev,
      bytes: size?.bytes ?? null,
      measuredAt: size?.measuredAt ?? null,
    };
    if (reading.kept !== null) candidate.keep = { reason: reading.kept, at: markedAt };
    candidates.push(candidate);
  }
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

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function markInterval(mark: GcMark, now: number, dormantMs: number): number {
  const markedAt = Date.parse(mark.markedAt);
  const activity = Date.parse(mark.lastActivityAt ?? '');
  const age = now - activity;
  const dirty = Date.parse(mark.dirtyAt ?? '') > markedAt;
  return dirty || !Number.isFinite(activity) || age < DAY_MS
    ? 10 * MINUTE_MS
    : dormantMs > 0 && age >= dormantMs
      ? DAY_MS
      : 60 * MINUTE_MS;
}

export function markDue(mark: GcMark | null, now: number, dormantMs: number): boolean {
  if (!mark) return true;
  const markedAt = Date.parse(mark.markedAt);
  return !Number.isFinite(markedAt) || now >= markedAt + markInterval(mark, now, dormantMs);
}

// @ref LLP 0001#the-lane-marks-what-each-checkout-could-free -- saved roots need current targeted discovery authorization
export async function outputMarks(config: Config, operation?: StimContext): Promise<GcMark[]> {
  return (await outputMarkBatch(config, operation)).marks;
}

export async function outputMarkBatch(
  config: Config,
  operation?: StimContext,
): Promise<{ marks: GcMark[]; complete: boolean; listed: boolean }> {
  const registered = new Set<string>();
  for (const root of Object.keys(config.projects)) {
    try {
      registered.add(await answered(root, () => realpathAsync(root), 3_000, operation?.signal));
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
        registered.add(resolve(root));
      else throw error;
    }
  }
  const dir = join(gcLogDir(), 'marks');
  let files: string[];
  try {
    files = await answered(dir, () => readdir(dir), 3_000, operation?.signal);
  } catch {
    operation?.signal.throwIfAborted();
    return { marks: [], complete: false, listed: false };
  }
  const marks: GcMark[] = [];
  let complete = true;
  for (const file of files) {
    const path = join(dir, file);
    try {
      const value: unknown = JSON.parse(await answered(path, () => readFile(path, 'utf8'), 3_000, operation?.signal));
      const root = isJsonObject(value) ? value.root : null;
      const mark = typeof root === 'string' && gcMarkFile(root) === path ? parseGcMark(root, value) : null;
      if (mark) marks.push(mark);
      else complete = false;
    } catch {
      operation?.signal.throwIfAborted();
      complete = false;
    }
  }
  const unregistered = marks.filter((mark) => !registered.has(mark.root));
  if (!unregistered.length) return { marks, complete, listed: true };
  const allowed = new Set(
    (
      await targetedCheckouts(
        config,
        listedRoots(),
        unregistered.map(({ root }) => root),
        operation,
      )
    ).map(({ path }) => path),
  );
  const selected = marks.filter((mark) => registered.has(mark.root) || allowed.has(mark.root));
  return { marks: selected, complete: complete && selected.length === marks.length, listed: true };
}

export async function refreshOutputMarks(config: Config, reading: DeviceReading): Promise<GcMark[]> {
  const found = await discoverCheckouts(config, listedRoots(), reading.operation);
  const roots = new Set([...Object.keys(config.projects), ...found.map(({ path }) => path)]);
  const write = markWriter(config, reading.operation?.signal);
  const refreshed: GcMark[] = [];
  for (const path of roots) {
    reading.operation?.signal.throwIfAborted();
    try {
      const root = await answered(path, () => realpathAsync(path), 3_000, reading.operation?.signal);
      const previous = readGcMark(root);
      if (!markDue(previous, Date.now(), dormantAfterMs(config, reading.operation?.env))) {
        if (previous) refreshed.push(previous);
        continue;
      }
      const current = await readCheckout(path, config.projects[path] ?? {}, reading, 2 * MINUTE_MS);
      await write(current);
      const mark = readGcMark(root);
      if (mark?.markedAt === new Date(current.at).toISOString() && current.kept === null) refreshed.push(mark);
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      reading.operation?.signal.throwIfAborted();
    }
  }
  return refreshed;
}

export function keepOutputMark(mark: GcMark, reason: string): void {
  const current = readGcMark(mark.root);
  if (!current || current.markedAt !== mark.markedAt) return;
  const at = new Date().toISOString();
  writeCacheFile(gcMarkFile(mark.root), {
    ...current,
    candidates: current.candidates.map((candidate) =>
      candidate.kind === 'outputs' ? Object.assign({}, candidate, { keep: { reason, at } }) : candidate,
    ),
  });
}
