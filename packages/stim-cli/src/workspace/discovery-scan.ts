import { lstat, readdir } from 'node:fs/promises';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isScopedHome, withDirLock, type StimContext } from '@stim-cli/core';
import {
  type ScanTruncation,
  discoveryScanFile,
  maintenanceDir,
  readDiscoveryScan,
  type DaemonMeasurement,
  type DiscoveryScan,
} from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { diskPressure, diskThresholds } from '../daemon/pressure.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
import { loadConfig } from './config.ts';
import { recognises } from './discovery.ts';
import {
  MAX_DEPTH,
  REAL_RECOGNITION_IO,
  folderSafety,
  nestedSafety,
  scanDescends,
  scanSkipper,
  type RecognitionIo,
} from './scan-rules.ts';

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MAX_FOLDERS = 200_000;
const BUDGET_MS = 45_000;
const READ_TIMEOUT_MS = 3000;

interface ScanOutcome {
  found: string[];
  unreadable: string[];
  visited: number;
  truncated: boolean;
  /** Why it stopped early, for the schedule and the doctor listing. */
  truncation: Exclude<ScanTruncation, 'failed'>;
}

const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? String(error.code) : '');

const refused = (error: unknown) => ['EACCES', 'EPERM'].includes(errorCode(error));

/**
 * A pruned walk below `home` (`scanDescends`, `skip`): folders for which `isCheckout` holds are results and are not
 * entered; symlinks and other volumes are skipped; a folder the system refuses is recorded as unreadable, never an error.
 * A read that does not answer within 3 seconds stops the walk at once: the folder is recorded unreadable, the result is
 * truncated, and the read stays the pending one (`bounded-read.ts`), so no further read starts, here or in a later scan,
 * until it settles. It also stops at `MAX_DEPTH` levels, `MAX_FOLDERS` folders or `budgetMs`, and says so in
 * `truncated`, with the reason in `truncation`. Before `isCheckout` runs on a folder, `folderSafety` has proved, for it and
 * for every folder above it down from the home folder, and `nestedSafety` for what detection inspects below it, that
 * project detection cannot block: an unsafe folder (a non-regular detection file, or an Xcode container without an app
 * dependency) makes its whole subtree unrecognisable, and a manifest read that does not answer ends the walk like any
 * other timed-out read. An abort rejects.
 */
export async function scanForCheckouts(
  home: string,
  isCheckout: (path: string) => boolean,
  {
    budgetMs = BUDGET_MS,
    signal,
    skip = () => false,
    readTimeoutMs = READ_TIMEOUT_MS,
    stat: statOf = (path) => lstat(path),
    entries: entriesOf = (path) => readdir(path, { withFileTypes: true }),
    recognition = REAL_RECOGNITION_IO,
  }: {
    budgetMs?: number;
    signal?: AbortSignal;
    skip?: (path: string) => boolean;
    readTimeoutMs?: number;
    stat?: (path: string) => Promise<{ dev: number }>;
    entries?: RecognitionIo['readEntries'];
    recognition?: RecognitionIo;
  } = {},
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = { found: [], unreadable: [], visited: 0, truncated: false, truncation: 'none' };
  const deadline = Date.now() + budgetMs;
  const stop = (truncation: Exclude<ScanTruncation, 'none' | 'failed'>): void => {
    if (outcome.truncated) return;
    outcome.truncated = true;
    outcome.truncation = truncation;
  };
  const exhausted = (): boolean => {
    signal?.throwIfAborted();
    if (hungRead() !== null) stop('read');
    else if (Date.now() > deadline) stop('budget');
    else if (outcome.visited >= MAX_FOLDERS) stop('folders');
    return outcome.truncated;
  };
  const stopAt = (folder: string, error: unknown): boolean => {
    signal?.throwIfAborted();
    if (error instanceof Unanswered) {
      outcome.unreadable.push(folder);
      stop('read');
      return true;
    }
    if (refused(error)) outcome.unreadable.push(folder);
    return false;
  };
  if (hungRead() !== null) {
    stop('read');
    return outcome;
  }
  let volume: number;
  try {
    volume = (await answered(home, () => statOf(home), readTimeoutMs)).dev;
  } catch (error) {
    if (!stopAt(home, error)) throw error;
    return outcome;
  }
  const walk = async (folder: string, depth: number, unsafeAbove: boolean): Promise<void> => {
    if (exhausted()) return;
    outcome.visited++;
    let entries;
    try {
      entries = await answered(folder, () => entriesOf(folder), readTimeoutMs);
    } catch (error) {
      stopAt(folder, error);
      return;
    }
    const safety = await folderSafety(folder, entries, readTimeoutMs, recognition, exhausted);
    if (safety === 'stopped') return;
    if (safety === 'unreadable') {
      outcome.unreadable.push(folder);
      stop('read');
      return;
    }
    const above = unsafeAbove || safety === 'unsafe';
    if (above) return;
    if (depth > 0) {
      const nested = await nestedSafety(folder, entries, readTimeoutMs, recognition, exhausted);
      if (nested === 'stopped') return;
      if (nested === 'unreadable') {
        outcome.unreadable.push(folder);
        stop('read');
        return;
      }
      if (nested === 'unsafe' || exhausted()) return;
      if (isCheckout(folder)) {
        outcome.found.push(folder);
        return;
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (exhausted()) return;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !scanDescends(entry.name, depth + 1)) continue;
      const path = join(folder, entry.name);
      if (skip(path)) continue;
      let info;
      try {
        info = await answered(path, () => statOf(path), readTimeoutMs);
      } catch (error) {
        if (stopAt(path, error)) return;
        continue;
      }
      if (info.dev === volume) await walk(path, depth + 1, false);
    }
  };
  await walk(home, 0, false);
  return outcome;
}

/**
 * The finds to store: a complete scan's, plus the previous ones under a folder it could not read; a truncated scan's,
 * plus every previous one. A worse result never replaces a better one, and a stale entry is dropped at read by
 * `scanEntryValid`, not here.
 */
export function mergeFound(previous: readonly string[], outcome: ScanOutcome): string[] {
  const under = (path: string) => outcome.unreadable.some((folder) => path.startsWith(`${folder}${sep}`));
  const kept = outcome.truncated ? previous : previous.filter(under);
  return [...new Set([...outcome.found, ...kept])].toSorted();
}

/**
 * Whether a scan is due. Never twice within an hour, so a rise and fall of the disk level cannot start a run of scans.
 * After that hour an attempt that ended on a failure or a read that timed out is retried whatever the disk level; one
 * that finished, or stopped at the folder cap or the time budget (the same limit would stop a retry), follows the weekly
 * schedule from the last scan that did not end on a read or failure, and runs hourly while the level is above normal
 * and no scan has run during it for an hour.
 */
export function discoveryScanDue(
  last: Pick<DiscoveryScan, 'ranAt' | 'completedAt' | 'lowScanAt' | 'truncation'> | null,
  now: number,
  low: boolean,
): boolean {
  if (!last || last.ranAt > now) return true;
  if (now - last.ranAt < HOUR_MS) return false;
  if (last.truncation === 'read' || last.truncation === 'failed') return true;
  return now - last.completedAt >= WEEK_MS || (low && now - last.lowScanAt >= HOUR_MS);
}

/** When this process last tried a scan, so a result that cannot be stored does not start a walk on every tick. */
const attempts = { at: 0 };

function writeScan(scan: DiscoveryScan): void {
  mkdirSync(maintenanceDir(), { recursive: true });
  withDirLock(join(maintenanceDir(), 'discovery-scan.lock'), () => {
    const file = discoveryScanFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(scan)}\n`);
    try {
      renameSync(tmp, file);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  });
}

/**
 * Scans the home folder when the schedule says so (`discoveryScanDue`) and stores the result under the Stim home, with
 * the schedule's own times, so a retired worker or a restarted daemon forgets nothing. A failed scan stores nothing but
 * its attempt time, keeps the previous finds and is retried after an hour, as is a scan that ended on a read that timed
 * out; one that stopped at the folder cap or the time budget counts as finished, since a retry would hit the same limit. Only a daemon tick scans, never a command,
 * and a scoped STIM_HOME never does. Only an abort escapes, so a scan can never end the maintenance pass it follows.
 */
export async function runDiscoveryScanIfDue(
  tick: { operation: StimContext; measured: { measurement: Pick<DaemonMeasurement, 'disk'> } } | undefined,
  {
    home = homedir(),
    now = Date.now(),
    attempted = attempts,
    scanOptions = {},
  }: {
    home?: string;
    now?: number;
    attempted?: { at: number };
    /** Limits and readers of the walk, for tests. */
    scanOptions?: Parameters<typeof scanForCheckouts>[2];
  } = {},
): Promise<void> {
  if (!tick || isScopedHome(tick.operation.env)) return;
  const { operation } = tick;
  let last: DiscoveryScan | null;
  let low: boolean;
  try {
    const thresholds = diskThresholds(loadConfig(), operation.env).thresholds;
    low = diskPressure(tick.measured.measurement.disk, thresholds).level !== 'normal';
    last = readDiscoveryScan();
  } catch {
    return;
  }
  if (!discoveryScanDue(last, now, low) || (now >= attempted.at && now - attempted.at < HOUR_MS) || hungRead() !== null)
    return;
  attempted.at = now;
  const attempt = {
    version: 2,
    ranAt: now,
    lowScanAt: low ? now : (last?.lowScanAt ?? 0),
    trigger: low ? 'low-disk' : 'weekly',
  } as const;
  const failedTruncation: ScanTruncation = 'failed';
  const failed = {
    ...attempt,
    completedAt: last?.completedAt ?? 0,
    durationMs: 0,
    visited: 0,
    truncated: true,
    truncation: failedTruncation,
  };
  const realHome = canonicalPath(home);
  const dotFolder = (path: string) => relative(realHome, path).startsWith('.');
  try {
    const outcome = await scanForCheckouts(realHome, recognises, {
      signal: operation.signal,
      skip: scanSkipper(realHome),
      ...scanOptions,
    });
    writeScan({
      ...attempt,
      completedAt: outcome.truncation === 'read' ? (last?.completedAt ?? 0) : now,
      durationMs: Date.now() - now,
      ...outcome,
      found: mergeFound(last?.found ?? [], { ...outcome, found: outcome.found.filter((p) => !dotFolder(p)) }),
      dotFolderFound: mergeFound(last?.dotFolderFound ?? [], { ...outcome, found: outcome.found.filter(dotFolder) }),
    });
  } catch {
    if (operation.signal.aborted) {
      attempted.at = 0;
      operation.signal.throwIfAborted();
    }
    try {
      writeScan({
        ...failed,
        found: last?.found ?? [],
        dotFolderFound: last?.dotFolderFound ?? [],
        unreadable: last?.unreadable ?? [],
      });
    } catch {}
  }
}
