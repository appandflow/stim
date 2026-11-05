import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_REPO_PATTERN } from './protocol.ts';

const USE_RECORD = 'last-used';
const USAGE_RECORD = 'usage.json';
const USE_TRACES = ['mirror.json', 'out', 'home', 'build.ndjson', '.'];
const MEASURE_TIMEOUT_MS = 60 * 60_000;

export interface WorkerArea {
  client: string;
  repo: string;
  usedAt: number;
}

/** The last measurement of the worker root, reported by `/health`. */
export interface WorkerRootUsage {
  path: string;
  bytes: number;
  measuredAt: string;
}

export interface AreaEviction extends WorkerArea {
  reason: 'age' | 'space';
}

/** Where the worker root's volume stands against its eviction margin and its disk floor. */
export type DiskSpace = 'ok' | 'low' | 'floor';

const EVICTED_RECORD = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/**
 * An eviction under way, named by its record `<client>/evicted/<id>.json`, which is created before the area moves to
 * `<client>/evicted/<id>/` and deleted last. The record has no content: a client's build can write there, so all of
 * this comes from its name and every path is derived from it.
 */
export interface Eviction {
  id: string;
  repo: string;
  uuid: string;
}

/** The eviction a record's file name stands for, or null when no eviction would be named that. */
export function evictionOf(recordName: string): Eviction | null {
  const [, repo, uuid] = EVICTED_RECORD.exec(recordName) ?? [];
  return repo && uuid && new RegExp(BUILD_REPO_PATTERN).test(repo) ? { id: `${repo}-${uuid}`, repo, uuid } : null;
}

/** Whether something other than a real directory, such as a symlink, is at `path`. */
export function notRealDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    return stats !== undefined && !stats.isDirectory();
  } catch {
    return true;
  }
}

/** Records now as the last use of `area`. An unwritable record never stops the build or fetch that uses the area. */
export function recordAreaUse(area: string): void {
  const tmp = join(area, `${USE_RECORD}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, String(Date.now()));
    renameSync(tmp, join(area, USE_RECORD));
  } catch (error) {
    console.error(`stim-server: could not record the use of the build area ${area}: ${String(error)}`);
  }
}

/**
 * When `area` was last used: its record, or, for an area older than the record or a record dated in the future, the
 * newest of the few paths every build rewrites, so no pass walks the area. An area with neither counts as used now and is not evicted.
 */
export function areaLastUsed(area: string): number {
  try {
    const recorded = Number(readFileSync(join(area, USE_RECORD), 'utf8'));
    if (Number.isSafeInteger(recorded) && recorded > 0 && recorded <= Date.now()) return recorded;
  } catch {}
  let latest = 0;
  for (const trace of USE_TRACES) {
    try {
      latest = Math.max(latest, statSync(join(area, trace)).mtimeMs);
    } catch {}
  }
  return latest || Date.now();
}

/**
 * The areas to evict, least recently used first: those unused for longer than `maxAgeMs` (0 turns age off); while the
 * space is `low`, those unused for at least `recentMs`; at the `floor`, where the worker declines every build, any
 * other. A client's most recently used area is never one of them.
 */
export function areasToEvict(
  areas: readonly WorkerArea[],
  { now, maxAgeMs, recentMs, space }: { now: number; maxAgeMs: number; recentMs: number; space: DiskSpace },
): AreaEviction[] {
  const newest = new Map<string, WorkerArea>();
  for (const area of areas) {
    const kept = newest.get(area.client);
    if (!kept || area.usedAt > kept.usedAt) newest.set(area.client, area);
  }
  const evictions: AreaEviction[] = [];
  for (const area of areas) {
    if (newest.get(area.client) === area) continue;
    const expired = maxAgeMs > 0 && now - area.usedAt > maxAgeMs;
    const spaceNeeded = space === 'floor' || (space === 'low' && now - area.usedAt >= recentMs);
    if (expired || spaceNeeded) evictions.push({ ...area, reason: expired ? 'age' : 'space' });
  }
  return evictions.toSorted((a, b) => a.usedAt - b.usedAt);
}

/** The measurement of `root` an earlier run recorded, so a restart does not walk the root again. */
export function readRootUsage(root: string): WorkerRootUsage | null {
  try {
    const { bytes, measuredAt }: Partial<WorkerRootUsage> = JSON.parse(readFileSync(join(root, USAGE_RECORD), 'utf8'));
    if (typeof bytes !== 'number' || typeof measuredAt !== 'string' || Number.isNaN(Date.parse(measuredAt)))
      return null;
    return { path: root, bytes, measuredAt };
  } catch {
    return null;
  }
}

export function recordRootUsage(usage: WorkerRootUsage): void {
  const tmp = join(usage.path, `${USAGE_RECORD}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(usage));
    renameSync(tmp, join(usage.path, USAGE_RECORD));
  } catch (error) {
    console.error(`stim-server: could not record the worker root's size: ${String(error)}`);
  }
}

/**
 * The bytes under `root` by `du`, whose total still counts when a build removes a file during the walk. Null when it
 * did not finish, and on Windows, which has no `du`.
 */
export function measureTreeBytes(root: string, signal: AbortSignal): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'nice',
      ['-n', '19', 'du', '-skH', root],
      { signal, timeout: MEASURE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (_error, stdout) => {
        const kilobytes = /^(\d+)\s/.exec(stdout)?.[1];
        resolve(kilobytes === undefined ? null : Number(kilobytes) * 1024);
      },
    );
  });
}
