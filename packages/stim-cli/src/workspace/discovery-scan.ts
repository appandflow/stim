import { lstat, readdir } from 'node:fs/promises';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isScopedHome, withDirLock, type StimContext } from '@stim-cli/core';
import {
  discoveryScanFile,
  maintenanceDir,
  readDiscoveryScan,
  type DaemonMeasurement,
  type DiscoveryScan,
} from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { diskPressure, diskThresholds } from '../daemon/pressure.ts';
import { loadConfig } from './config.ts';
import { recognises } from './discovery.ts';
import { MAX_DEPTH, scanDescends, scanSkipper } from './scan-rules.ts';

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
}

const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? String(error.code) : '');

/** `read`'s result, or an ETIMEDOUT rejection when it has not answered in time, as a hung mount or a permission prompt would not. */
async function answered<T>(read: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const unanswered = (error: unknown) => ['EACCES', 'EPERM', 'ETIMEDOUT'].includes(errorCode(error));

/**
 * A pruned walk below `home` (`scanDescends`, `skip`): folders for which `isCheckout` holds are results and are not
 * entered; symlinks and other volumes are skipped; a folder the system refuses or that does not answer within 3 seconds
 * is recorded as unreadable, never an error. It stops at `MAX_DEPTH` levels, `MAX_FOLDERS` folders or `budgetMs`, and
 * says so in `truncated`. An abort rejects.
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
  }: {
    budgetMs?: number;
    signal?: AbortSignal;
    skip?: (path: string) => boolean;
    readTimeoutMs?: number;
    stat?: (path: string) => Promise<{ dev: number }>;
  } = {},
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = { found: [], unreadable: [], visited: 0, truncated: false };
  const deadline = Date.now() + budgetMs;
  const volume = (await statOf(home)).dev;
  const exhausted = (): boolean => {
    signal?.throwIfAborted();
    if (!outcome.truncated && (Date.now() > deadline || outcome.visited >= MAX_FOLDERS)) outcome.truncated = true;
    return outcome.truncated;
  };
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (exhausted()) return;
    outcome.visited++;
    let entries;
    try {
      entries = await answered(readdir(folder, { withFileTypes: true }), readTimeoutMs);
    } catch (error) {
      signal?.throwIfAborted();
      if (unanswered(error)) outcome.unreadable.push(folder);
      return;
    }
    if (depth > 0 && isCheckout(folder)) {
      outcome.found.push(folder);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (exhausted()) return;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !scanDescends(entry.name, depth + 1)) continue;
      const path = join(folder, entry.name);
      if (skip(path)) continue;
      let info;
      try {
        info = await answered(statOf(path), readTimeoutMs);
      } catch (error) {
        signal?.throwIfAborted();
        if (unanswered(error)) outcome.unreadable.push(path);
        continue;
      }
      if (info.dev === volume) await walk(path, depth + 1);
    }
  };
  await walk(home, 0);
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
 * Whether a scan is due. Never twice within an hour, so a failing or truncated scan is retried hourly and a rise and
 * fall of the disk level cannot start a run of scans; then weekly from the last attempt that did not fail, or hourly
 * while the level is above normal and no scan has run during it for an hour.
 */
export function discoveryScanDue(
  last: Pick<DiscoveryScan, 'ranAt' | 'completedAt' | 'lowScanAt'> | null,
  now: number,
  low: boolean,
): boolean {
  if (!last || last.ranAt > now) return true;
  if (now - last.ranAt < HOUR_MS) return false;
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
 * its attempt time, keeps the previous finds and is retried after an hour. Only a daemon tick scans, never a command,
 * and a scoped STIM_HOME never does. Only an abort escapes, so a scan can never end the maintenance pass it follows.
 */
export async function runDiscoveryScanIfDue(
  tick: { operation: StimContext; measured: { measurement: Pick<DaemonMeasurement, 'disk'> } } | undefined,
  {
    home = homedir(),
    now = Date.now(),
    attempted = attempts,
  }: { home?: string; now?: number; attempted?: { at: number } } = {},
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
  if (!discoveryScanDue(last, now, low) || (now >= attempted.at && now - attempted.at < HOUR_MS)) return;
  attempted.at = now;
  const attempt = {
    version: 2,
    ranAt: now,
    lowScanAt: low ? now : (last?.lowScanAt ?? 0),
    trigger: low ? 'low-disk' : 'weekly',
  } as const;
  const failed = { ...attempt, completedAt: last?.completedAt ?? 0, durationMs: 0, visited: 0, truncated: true };
  const realHome = canonicalPath(home);
  const dotFolder = (path: string) => relative(realHome, path).startsWith('.');
  try {
    const outcome = await scanForCheckouts(realHome, recognises, {
      signal: operation.signal,
      skip: scanSkipper(realHome),
    });
    writeScan({
      ...attempt,
      completedAt: now,
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
