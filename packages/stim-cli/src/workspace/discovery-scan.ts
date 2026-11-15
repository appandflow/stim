import { lstat, readdir } from 'node:fs/promises';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isScopedHome, withDirLock, type StimContext } from '@stim-cli/core';
import {
  discoveryScanFile,
  maintenanceDir,
  readDiscoveryScan,
  type DiscoveryScan,
  type DaemonMeasurement,
} from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { diskPressure, diskThresholds } from '../daemon/pressure.ts';
import { loadConfig } from './config.ts';
import { recognises } from './discovery.ts';

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MAX_DEPTH = 7;
const MAX_FOLDERS = 200_000;
const BUDGET_MS = 2 * 60_000;
const READ_TIMEOUT_MS = 3000;

/** Folders directly in the home folder the scan never reads: system, media and the two the maintainer excluded. */
const HOME_SKIPPED = new Set([
  'Library',
  'Applications',
  'Desktop',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public',
]);

/** Folders at any depth that hold many files and no projects: dependencies, build output and tool caches. */
const PRUNED = new Set([
  'node_modules',
  'Pods',
  'Carthage',
  'build',
  'dist',
  'out',
  'target',
  'vendor',
  'DerivedData',
  'venv',
  '__pycache__',
  'site-packages',
  'coverage',
  'Library',
]);

// @ref LLP 0004#tool-folders-and-the-full-scan -- what the scan prunes
/** Whether the scan descends into a folder named `name`, `depth` levels below the home folder (1 is a child of it). */
export function scanDescends(name: string, depth: number): boolean {
  if (name.startsWith('.') || PRUNED.has(name)) return false;
  return depth !== 1 || !HOME_SKIPPED.has(name);
}

interface ScanOutcome {
  found: string[];
  unreadable: string[];
  visited: number;
  truncated: boolean;
}

const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? String(error.code) : '');

/**
 * A pruned walk below `home`: folders for which `isCheckout` holds are results and are not entered; dependency, build
 * output, tool-cache and dot-folders, symlinks and other volumes are skipped; a folder the system refuses or that does
 * not answer is recorded as unreadable, never an error. It stops at `MAX_DEPTH` levels, `MAX_FOLDERS` folders or
 * `budgetMs`, and says so in `truncated`.
 */
export async function scanForCheckouts(
  home: string,
  isCheckout: (path: string) => boolean,
  { budgetMs = BUDGET_MS, signal }: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = { found: [], unreadable: [], visited: 0, truncated: false };
  const deadline = Date.now() + budgetMs;
  const volume = (await lstat(home)).dev;
  const walk = async (folder: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (outcome.truncated) return;
    if (Date.now() > deadline || outcome.visited >= MAX_FOLDERS) {
      outcome.truncated = true;
      return;
    }
    outcome.visited++;
    let timer: NodeJS.Timeout | undefined;
    let entries;
    try {
      entries = await Promise.race([
        readdir(folder, { withFileTypes: true }),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), READ_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (['EACCES', 'EPERM', 'ETIMEDOUT'].includes(errorCode(error))) outcome.unreadable.push(folder);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (depth > 0 && isCheckout(folder)) {
      outcome.found.push(folder);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !scanDescends(entry.name, depth + 1)) continue;
      const path = join(folder, entry.name);
      if ((await lstat(path).catch(() => null))?.dev !== volume) continue;
      await walk(path, depth + 1);
    }
  };
  await walk(home, 0);
  return outcome;
}

/** Whether a scan is due: weekly, and once an hour after the disk level rose above normal. */
export function discoveryScanDue(last: Pick<DiscoveryScan, 'ranAt'> | null, now: number, rose: boolean): boolean {
  if (!last || last.ranAt > now) return true;
  return now - last.ranAt >= (rose ? HOUR_MS : WEEK_MS);
}

/** What this process remembers between ticks: when it last tried a scan, and whether the disk level was above normal. */
interface ScanMemory {
  attemptedAt: number;
  wasLow: boolean;
}

const processMemory: ScanMemory = { attemptedAt: 0, wasLow: false };

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
 * Scans the home folder when the weekly schedule says so, or an hour after the last scan when the disk level has just
 * risen above normal, and stores the result under the Stim home. A scan that fails or runs out of time is stored too,
 * with the checkouts the last scan found, and this process does not retry within the interval even when nothing could
 * be stored. Only a daemon tick scans, never a command, and a scoped STIM_HOME never does. Nothing but an abort
 * escapes, so a scan can never stop the maintenance pass it runs in.
 */
export async function runDiscoveryScanIfDue(
  tick: { operation: StimContext; measured: { measurement: Pick<DaemonMeasurement, 'disk'> } } | undefined,
  { home = homedir(), memory = processMemory }: { home?: string; memory?: ScanMemory } = {},
): Promise<void> {
  if (!tick || isScopedHome(tick.operation.env)) return;
  const { operation } = tick;
  const now = Date.now();
  const thresholds = diskThresholds(loadConfig(), operation.env).thresholds;
  const low = diskPressure(tick.measured.measurement.disk, thresholds).level !== 'normal';
  const rose = low && !memory.wasLow;
  memory.wasLow = low;
  const last = readDiscoveryScan();
  const ranAt = Math.max(last?.ranAt ?? 0, memory.attemptedAt);
  if (!discoveryScanDue(ranAt > 0 ? { ranAt } : null, now, rose)) return;
  memory.attemptedAt = now;
  const trigger = rose ? 'low-disk' : 'weekly';
  const store = (scan: Omit<DiscoveryScan, 'version' | 'ranAt' | 'durationMs' | 'trigger'>) =>
    writeScan({ version: 1, ranAt: now, durationMs: Date.now() - now, trigger, ...scan });
  try {
    const outcome = await scanForCheckouts(canonicalPath(home), recognises, { signal: operation.signal });
    store({ ...outcome, found: outcome.found.toSorted() });
  } catch {
    if (operation.signal.aborted) {
      memory.attemptedAt = 0;
      return;
    }
    try {
      store({ visited: 0, found: last?.found ?? [], unreadable: last?.unreadable ?? [], truncated: true });
    } catch {}
  }
}
