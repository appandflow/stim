import { readFileSync, statSync } from 'node:fs';
import { configDir, LOG_ROTATE_BYTES } from '@stim-cli/core';
import { daemonNdjsonFile, sizeFailuresFile } from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { isTimeoutError } from './exec.ts';
import { createNdjsonWriter } from './ndjson.ts';

const RECORD_EVERY_MS = 6 * 60 * 60_000;
const SIZERS = new Set([
  'measureTree',
  'walkTree',
  'refreshMeasure',
  'measuredDirectorySizeAsync',
  'measuredDirectorySize',
  'directorySize',
  'directorySizeAsync',
  'noteSizeFailure',
  'sizeCaller',
]);

/** Why a size walk returned no size. */
export type SizeFailure =
  | { reason: 'timeout'; limitMs: number }
  | { reason: 'exit'; status: number }
  | { reason: 'signal'; signal: string }
  | { reason: 'aborted' }
  | { reason: 'error'; code: string }
  | { reason: 'no-output' };

const failures = new Map<string, { failure: SizeFailure; at: number }>();

/** The failure of a walk from the error it threw, or none; `overran` when it ended at or past `limitMs`. */
export function sizeFailure(error: unknown, limitMs: number | 'unbounded', overran: boolean): SizeFailure {
  const limit = limitMs === 'unbounded' ? 0 : limitMs;
  if (isTimeoutError(error) || (error === undefined && overran)) return { reason: 'timeout', limitMs: limit };
  if (error instanceof Error) {
    if ('signal' in error && typeof error.signal === 'string') return { reason: 'signal', signal: error.signal };
    if ('status' in error && typeof error.status === 'number') return { reason: 'exit', status: error.status };
    if ('code' in error && typeof error.code === 'string') return { reason: 'error', code: error.code };
    return { reason: 'error', code: 'unknown' };
  }
  return { reason: 'no-output' };
}

/** What a size walk that failed with `failure` did, as the end of a sentence. */
export function describeSizeFailure(failure: SizeFailure): string {
  switch (failure.reason) {
    case 'timeout':
      return `did not finish within ${Math.round(failure.limitMs / 1000)} seconds`;
    case 'exit':
      return `exited with status ${failure.status}`;
    case 'signal':
      return `was stopped by ${failure.signal}`;
    case 'aborted':
      return 'was aborted';
    case 'error':
      return `could not run (${failure.code})`;
    case 'no-output':
      return 'printed no size';
  }
}

function sizeCaller(): string {
  for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
    const name = /^\s*at (?:async )?(?:[\w$]+\.)*([\w$]+) \((?!node:|<anonymous>|index )/.exec(line)?.[1];
    const bare = name?.replace(/\$\d+$/, '');
    if (bare && !SIZERS.has(bare)) return bare;
  }
  return 'unknown';
}

/** The last failure noted for `path` in this process. */
export function lastSizeFailure(path: string): SizeFailure | null {
  return failures.get(`${configDir()}\0${path}`)?.failure ?? null;
}

function absent(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  }
}

function expired(at: number, now: number): boolean {
  return now - at >= RECORD_EVERY_MS || now < at;
}

function readRecorded(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sizeFailuresFile(), 'utf8'));
    const recorded: Record<string, number> = {};
    if (parsed && typeof parsed === 'object')
      for (const [slot, at] of Object.entries(parsed)) if (typeof at === 'number') recorded[slot] = at;
    return recorded;
  } catch {
    return {};
  }
}

/**
 * Notes that sizing `path` failed after `ms`, and appends one `size_failed` record to the daemon log, at most once per
 * RECORD_EVERY_MS per path and reason across the home's processes and threads, naming the function that asked for the size. For an entry of a
 * cache, `root` names the cache: its entries share one record per reason, and their failures are not kept. A `du` that
 * exited non-zero on a folder that does not exist is no failure. Never throws.
 */
export function noteSizeFailure(path: string, failure: SizeFailure, ms: number, root?: string): void {
  try {
    const key = `${configDir()}\0${path}`;
    if (failure.reason === 'exit' && absent(path)) {
      failures.delete(key);
      return;
    }
    const now = Date.now();
    const slot = root ? `${failure.reason} entries of ${root}` : `${failure.reason} ${path}`;
    if (!root) failures.set(key, { failure, at: now });
    const recorded = readRecorded();
    const last = recorded[slot];
    if (last !== undefined && !expired(last, now)) return;
    for (const [stale, at] of Object.entries(recorded)) if (expired(at, now)) delete recorded[stale];
    for (const [stale, { at }] of failures) if (expired(at, now)) failures.delete(stale);
    recorded[slot] = now;
    writeCacheFile(sizeFailuresFile(), recorded);
    const caller = sizeCaller();
    const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
    try {
      writer.write({
        src: 'size',
        level: failure.reason === 'aborted' ? 'info' : 'warn',
        event: 'size_failed',
        msg: `could not size ${path} for ${caller}: the walk ${describeSizeFailure(failure)} (ran ${Math.round(ms / 1000)} seconds)`,
        path,
        ...(root ? { root } : {}),
        caller,
        ...failure,
        ms: Math.round(ms),
      });
    } finally {
      writer.close();
    }
  } catch {}
}
