import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isScopedHome, withDirLock, type StimContext } from '@stim-cli/core';
import {
  discoveryCensusFile,
  machineSettingValue,
  maintenanceDir,
  readDiscoveryCensusFile,
  readDiscoveryScanFile,
  type CensusFind,
  type DiscoveryCensus,
} from '@stim-cli/core/state';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { refreshMeasure } from '../disk-usage.ts';
import { appRoots } from '../stimd/passes/artifacts.ts';
import { loadConfig } from './config.ts';
import { discoveredEvidence } from './discovered-activity.ts';
import { discoveredReads, type DiscoveredReads } from './discovered-reads.ts';
import { DISCOVER_ROOTS_KEY, rootsOf } from './discovery-report.ts';
import { isBroadFolder, unmanagedScanFinds } from './discovery.ts';
import { existingBuildDirsAsync } from './regenerable-dirs.ts';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Per build directory: the walk of the one disk-usage walk the machine allows at a time. */
const WALK_TIMEOUT_MS = 10_000;
/** The most checkouts one run measures, and the longest it starts new walks for; the rest wait for the next run. */
const MAX_CHECKOUTS = 25;
const BUDGET_MS = 90_000;

/** When this process last tried a run, so a census that cannot be stored does not start walks on every tick. */
const attempts = { at: 0 };

// @ref LLP 0004#the-doctor-listing-and-the-low-disk-line -- the daemon measures, commands read
/**
 * Whether a census run is due: none exists, the scan it came from is not the last one, `maintenance.discoverRoots`
 * changed, some directory is still waiting for a measurement and an hour passed, or a day passed.
 */
export function censusDue(
  last: Pick<DiscoveryCensus, 'at' | 'scanRanAt' | 'roots' | 'pending'> | null,
  scanRanAt: number,
  roots: readonly string[],
  now: number,
): boolean {
  if (!last || last.at > now || last.scanRanAt !== scanRanAt) return true;
  if (last.roots.length !== roots.length || last.roots.some((root, at) => root !== roots[at])) return true;
  return now - last.at >= (last.pending ? HOUR_MS : DAY_MS);
}

function writeCensus(census: DiscoveryCensus): void {
  mkdirSync(maintenanceDir(), { recursive: true });
  withDirLock(join(maintenanceDir(), 'discovery-census.lock'), () => {
    const file = discoveryCensusFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(census)}\n`);
    try {
      renameSync(tmp, file);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  });
}

interface Budget {
  deadline: number;
  checkouts: number;
}

type Measurement = Pick<CensusFind, 'dirs' | 'measuredDirs' | 'failedDirs' | 'bytes'>;

/**
 * The build output Stim recognises in a checkout, measured one directory at a time through `refreshMeasure`: the disk
 * usage cache while an entry is under a day old, else one walk under the machine's walk claim, with the walk timeout.
 * A walk that failed or timed out counts as failed, never as zero; a directory not reached before the budget ran out, or
 * while another walk held the claim, is not measured yet.
 */
async function measureBuildOutput(path: string, operation: StimContext, budget: Budget): Promise<Measurement> {
  const dirs = new Set<string>();
  for (const root of appRoots({ path, keys: [], linked: false, locked: false, reduceOnly: true }, 'build'))
    for (const dir of await existingBuildDirsAsync(root)) dirs.add(dir);
  const result: Measurement = { dirs: dirs.size, measuredDirs: 0, failedDirs: 0, bytes: 0 };
  for (const dir of dirs) {
    operation.signal.throwIfAborted();
    if (Date.now() > budget.deadline || !existsSync(dir)) continue;
    const { outcome, measure } = await refreshMeasure(dir, {
      timeoutMs: WALK_TIMEOUT_MS,
      maxAgeMs: DAY_MS,
      claim: true,
      operation,
      private: false,
      failures: true,
    });
    if (measure) {
      result.measuredDirs++;
      result.bytes += measure.bytes;
    } else if (outcome !== 'busy') result.failedDirs++;
  }
  return result;
}

/**
 * The newest activity of a reduce-only checkout when the idle stage's own evidence proves it idle for `idleMs` and nothing
 * uses it, else null. The evidence stops at the first activity newer than the threshold, so a value is always the
 * checkout's real newest activity, never a bound.
 */
async function idleSince(
  path: string,
  idleMs: number,
  now: number,
  reads: DiscoveredReads,
  operation: StimContext,
): Promise<number | null> {
  const { activity, keep } = await discoveredEvidence(path, { now, idleMs, reads, operation, reduceOnly: true });
  if (keep.length || !activity.length) return null;
  const newest = Math.max(...activity.map(({ at }) => at));
  return newest <= now - idleMs ? newest : null;
}

/**
 * Classifies the finds of the last full scan that Stim does not fully manage, and measures their recognised build
 * output, for the doctor listing and the low-disk line. It runs in the daemon after the scan, never in a command, and
 * a scoped STIM_HOME never does. It reads the scan result the daemon wrote and writes `maintenance/discovery-census.json`.
 *
 * Bounds: at most `MAX_CHECKOUTS` checkouts are measured per run, none after `BUDGET_MS`, one walk at a time machine-wide
 * (`refreshMeasure` with a claim), each with `WALK_TIMEOUT_MS`. A checkout measured within a day is carried over without a
 * walk; one left over stays unmeasured and the next run, within the hour, continues. Only an abort escapes.
 */
export async function runDiscoveryCensusIfDue(
  tick: { operation: StimContext } | undefined,
  {
    now = Date.now(),
    attempted = attempts,
    reads,
    maxCheckouts = MAX_CHECKOUTS,
    budgetMs = BUDGET_MS,
  }: {
    now?: number;
    attempted?: { at: number };
    /** The process and agent-session readers; tests inject them. */
    reads?: DiscoveredReads;
    maxCheckouts?: number;
    budgetMs?: number;
  } = {},
): Promise<void> {
  if (!tick || isScopedHome(tick.operation.env)) return;
  const { operation } = tick;
  try {
    const scanFile = readDiscoveryScanFile();
    const file = readDiscoveryCensusFile();
    if (scanFile.status !== 'read' || !scanFile.scan || file.status === 'unreadable') return;
    const { scan } = scanFile;
    const config = loadConfig();
    const setting = machineSettingValue(DISCOVER_ROOTS_KEY, { config, env: operation.env });
    const roots = rootsOf(setting, homedir());
    const last = file.status === 'read' ? file.census : null;
    if (!censusDue(last, scan.ranAt, roots, now) || (now >= attempted.at && now - attempted.at < HOUR_MS)) return;
    attempted.at = now;
    const { value: days, error } = machineSettingValue('maintenance.olderThanDays', { config, env: operation.env });
    const idleDays = !error && typeof days === 'number' && days > 0 ? days : null;
    const finds = await unmanagedScanFinds(config, listedRoots(), operation);
    const previous = new Map((last?.finds ?? []).map((find) => [`${find.kind}\0${find.path}`, find]));
    const budget: Budget = { deadline: Date.now() + budgetMs, checkouts: 0 };
    const sharedReads = reads ?? discoveredReads(operation.signal, operation);
    const entries: CensusFind[] = [];
    const groups: Array<[CensusFind['kind'], string[]]> = [
      ['reduce-only', finds.reduceOnly],
      ['dot-folder', finds.dotFolder],
    ];
    for (const [kind, paths] of groups)
      for (const path of paths) {
        operation.signal.throwIfAborted();
        const folder = dirname(path);
        const earlier = previous.get(`${kind}\0${path}`);
        const placement = { path, kind, folder, adoptable: !isBroadFolder(folder) };
        const complete =
          earlier && earlier.measuredDirs === earlier.dirs && earlier.failedDirs === 0 && earlier.evaluatedAt > 0;
        if (earlier && complete && now - earlier.evaluatedAt < DAY_MS && last?.idleDays === idleDays) {
          entries.push({ ...earlier, ...placement });
          continue;
        }
        if (budget.checkouts >= maxCheckouts || Date.now() > budget.deadline) {
          entries.push(
            earlier
              ? { ...earlier, ...placement }
              : {
                  ...placement,
                  evaluatedAt: 0,
                  dirs: 0,
                  measuredDirs: 0,
                  failedDirs: 0,
                  bytes: 0,
                  lastActivityAt: null,
                },
          );
          continue;
        }
        budget.checkouts++;
        const measured = await measureBuildOutput(path, operation, budget);
        entries.push({
          ...placement,
          ...measured,
          evaluatedAt: now,
          lastActivityAt:
            kind === 'reduce-only' && idleDays !== null
              ? await idleSince(path, idleDays * DAY_MS, now, sharedReads, operation)
              : null,
        });
      }
    operation.signal.throwIfAborted();
    writeCensus({
      version: 1,
      at: now,
      scanRanAt: scan.ranAt,
      roots,
      idleDays,
      pending: entries.some((find) => find.evaluatedAt === 0 || find.measuredDirs + find.failedDirs < find.dirs),
      finds: entries,
    });
  } catch {
    operation.signal.throwIfAborted();
  }
}
