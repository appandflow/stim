import { statSync } from 'node:fs';
import { configDir, LOG_ROTATE_BYTES } from '@stim-cli/core';
import { daemonNdjsonFile } from '@stim-cli/core/state';
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

const failures = new Map<string, SizeFailure>();
const recorded = new Map<string, number>();

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
  return failures.get(`${configDir()}\0${path}`) ?? null;
}

function absent(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  }
}

/**
 * Notes that sizing `path` failed after `ms`, and appends one `size_failed` record to the daemon log, at most once per
 * RECORD_EVERY_MS per path and reason in this process, naming the function that asked for the size. A `du` that exited
 * non-zero on a folder that does not exist is no failure. Never throws.
 */
export function noteSizeFailure(path: string, failure: SizeFailure, ms: number): void {
  try {
    if (failure.reason === 'exit' && absent(path)) return;
    const key = `${configDir()}\0${path}`;
    failures.set(key, failure);
    const slot = `${key}\0${failure.reason}`;
    const now = Date.now();
    const last = recorded.get(slot);
    if (last !== undefined && now - last < RECORD_EVERY_MS && now >= last) return;
    recorded.set(slot, now);
    const caller = sizeCaller();
    const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
    try {
      writer.write({
        src: 'size',
        level: 'warn',
        event: 'size_failed',
        msg: `could not size ${path} for ${caller}: the walk ${describeSizeFailure(failure)} (ran ${Math.round(ms / 1000)} seconds)`,
        path,
        caller,
        ...failure,
        ms: Math.round(ms),
      });
    } finally {
      writer.close();
    }
  } catch {}
}
