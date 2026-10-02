import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { withConfigLock } from '../workspace/config.ts';
import type { CacheHitLevel } from './build-facts.ts';
import { decodeStats, statsFile, STATS_VERSION, trimSamples, wholePhases } from '@stim-cli/core/state';
import type {
  StatsPlacement as BuildPlacement,
  BuildMachineTotals,
  RunOutcomeKind,
  StatsPlatform,
  StatsRecord,
  StatsScope,
  StatsBucket,
  RunSample,
  RunHistory,
} from '@stim-cli/core/state';
export {
  statsFile,
  statsProjectKey,
  HISTORY_LIMIT,
  PLACEMENT_DECISIONS,
  readStats,
  readRunEstimates,
  offloadSummary,
} from '@stim-cli/core/state';
export type {
  RunOutcomeKind,
  StatsPlatform,
  StatsRecord,
  StatsBucket,
  RunSample,
  RunHistory,
  RunEstimates,
  OffloadSummary,
} from '@stim-cli/core/state';

interface RunPlacement {
  decision: BuildPlacement['decision'];
  reason: string;
  machine?: string;
  /** The offloaded build's total time; a build here takes the run's compile time instead. */
  buildMs?: number;
}

export interface StatsRun {
  platform: StatsPlatform;
  projectKey: string;
  failed: boolean;
  cacheHit: CacheHitLevel;
  waitedForBuild: boolean;
  durationMs: number;
  offloadedTo?: string;
  coldBuildMs?: number;
  podsMs?: number;
  phases?: Record<string, number>;
  deviceSetup?: boolean;
  placement?: RunPlacement;
}

export interface RecordStatsResult {
  recorded: boolean;
  note: string | null;
}

interface RunOutcome {
  failed: boolean;
  cacheHit?: CacheHitLevel;
  waited?: unknown;
  durationMs: number;
  offloadedTo?: string | null;
}

export interface RunRecorder {
  setProject(key: string): void;
  setCacheKey(key: string): void;
  setBuildMs(ms: number): void;
  setPodsMs(ms: number): void;
  setPlacement(placement: RunPlacement): void;
  record(outcome: RunOutcome): void;
}

export const PLACEMENT_LIMIT = 100;
export const PLACEMENT_MAX_AGE_MS: number = 7 * 24 * 60 * 60_000;

export function emptyStats(): StatsRecord {
  return { version: STATS_VERSION, machine: {}, projects: {} };
}

export function updateStats(record: StatsRecord, run: StatsRun, now: number): StatsRecord {
  const at = new Date(now).toISOString();
  const durationMs = wholeMs(run.durationMs);
  const phases = {
    coldBuildMs: wholeMs(run.coldBuildMs),
    podsMs: wholeMs(run.podsMs),
  };
  const projects: Record<string, StatsScope> = { ...record.projects };
  const scope: StatsScope = { ...projects[run.projectKey] };
  const machine: StatsScope = { ...record.machine };
  const before = scope[run.platform] ?? null;
  const credit = creditMs(before, run, durationMs);

  scope[run.platform] = applyRun(before, run, {
    at,
    durationMs,
    credit,
    phases,
  });
  projects[run.projectKey] = scope;
  machine[run.platform] = applyRun(machine[run.platform] ?? null, run, {
    at,
    durationMs,
    credit,
    phases,
  });

  const history = { ...record.history };
  if (run.phases && !run.failed && !run.waitedForBuild && !run.offloadedTo) {
    const outcome: RunOutcomeKind = isHit(run.cacheHit) ? 'hit' : 'cold';
    const project: RunHistory = { ...history[run.projectKey] };
    const lists = { ...project[run.platform] };
    const sample: RunSample = {
      at,
      durationMs,
      phases: wholePhases(run.phases),
      ...(run.deviceSetup === undefined ? {} : { deviceSetup: run.deviceSetup }),
    };
    lists[outcome] = trimSamples([...(lists[outcome] ?? []), sample]);
    project[run.platform] = lists;
    history[run.projectKey] = project;
  }

  let placements = record.placements;
  let buildMachines = record.buildMachines;
  if (run.placement) {
    const placement = buildPlacement(run, before, at);
    placements = trimPlacements([...(placements ?? []), placement], now);
    if (placement.machine && placement.decision !== 'here') {
      buildMachines = {
        ...buildMachines,
        [placement.machine]: applyPlacement(buildMachines?.[placement.machine], placement),
      };
    }
  }

  return {
    version: STATS_VERSION,
    machine,
    projects,
    ...(Object.keys(history).length ? { history } : {}),
    ...(placements?.length ? { placements } : {}),
    ...(buildMachines && Object.keys(buildMachines).length ? { buildMachines } : {}),
  };
}

function buildPlacement(run: StatsRun, before: StatsBucket | null, at: string): BuildPlacement {
  const placement = run.placement!;
  const buildMs = wholeMs(placement.decision === 'offloaded' ? placement.buildMs : run.coldBuildMs);
  const localEstimateMs = wholeMs(before?.lastColdBuildMs);
  return {
    at,
    project: run.projectKey,
    platform: run.platform,
    decision: placement.decision,
    reason: placement.reason,
    ...(placement.machine ? { machine: placement.machine } : {}),
    ...(buildMs > 0 ? { buildMs } : {}),
    ...(localEstimateMs > 0 ? { localEstimateMs } : {}),
    ...(run.failed ? { failed: true as const } : {}),
  };
}

function applyPlacement(totals: BuildMachineTotals | undefined, placement: BuildPlacement): BuildMachineTotals {
  const next: BuildMachineTotals = totals ? { ...totals } : { offloaded: 0, offloadedMs: 0, savedMs: 0, fallbacks: 0 };
  if (placement.decision === 'fell-back') {
    next.fallbacks += 1;
    next.lastFallbackAt = placement.at;
    return next;
  }
  next.offloaded += 1;
  next.offloadedMs += placement.buildMs ?? 0;
  if (placement.localEstimateMs && placement.buildMs) next.savedMs += placement.localEstimateMs - placement.buildMs;
  next.lastOffloadAt = placement.at;
  return next;
}

function trimPlacements(placements: BuildPlacement[], now: number): BuildPlacement[] {
  return placements.filter((each) => now - Date.parse(each.at) <= PLACEMENT_MAX_AGE_MS).slice(-PLACEMENT_LIMIT);
}

export function recordRunStats(run: StatsRun, now: number): RecordStatsResult {
  return withConfigLock(() => {
    const path = statsFile();
    const loaded = loadForUpdate(path, now);
    if (loaded.newerVersion !== null) {
      return {
        recorded: false,
        note:
          `Run statistics at ${path} are version ${loaded.newerVersion}, which this Stim does not understand, ` +
          'so this run was not recorded.',
      };
    }
    writeStats(path, updateStats(loaded.record, run, now));
    return { recorded: true, note: loaded.note };
  });
}

export function createRunRecorder({
  platform,
  write,
  now,
  note,
  phases,
  deviceSetup,
}: {
  platform: StatsPlatform;
  write: (run: StatsRun, now: number) => RecordStatsResult;
  now: () => number;
  note: (line: string) => void;
  phases?: () => Record<string, number>;
  deviceSetup?: () => boolean | undefined;
}): RunRecorder {
  let projectKey: string | null = null;
  let cacheKey: string | null = null;
  let coldBuildMs = 0;
  let podsMs = 0;
  let placement: RunPlacement | null = null;
  let recorded = false;
  return {
    setProject(key: string): void {
      projectKey = key;
    },
    setCacheKey(key: string): void {
      cacheKey = key;
    },
    setBuildMs(ms: number): void {
      coldBuildMs = wholeMs(ms);
    },
    setPodsMs(ms: number): void {
      podsMs = wholeMs(ms);
    },
    setPlacement(next: RunPlacement): void {
      placement = next;
    },
    record({ failed, cacheHit = false, waited = null, durationMs, offloadedTo = null }: RunOutcome): void {
      if (!projectKey || !cacheKey || recorded) return;
      recorded = true;
      const ran = failed ? {} : (phases?.() ?? {});
      try {
        const outcome = write(
          {
            platform,
            projectKey,
            failed,
            cacheHit,
            waitedForBuild: Boolean(waited),
            durationMs,
            ...(offloadedTo ? { offloadedTo } : {}),
            ...(coldBuildMs > 0 ? { coldBuildMs } : {}),
            ...(podsMs > 0 ? { podsMs } : {}),
            ...(Object.keys(ran).length ? { phases: ran } : {}),
            ...(failed || deviceSetup?.() === undefined ? {} : { deviceSetup: deviceSetup()! }),
            ...(placement ? { placement } : {}),
          },
          now(),
        );
        if (outcome?.note) note(outcome.note);
      } catch (error) {
        note(`Run statistics could not be recorded: ${(error as Error)?.message || error}`);
      }
    },
  };
}

function loadForUpdate(
  path: string,
  now: number,
): { record: StatsRecord; note: string | null; newerVersion: number | null } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { record: emptyStats(), note: null, newerVersion: null };
  }
  const parsed = decodeStats(text);
  if (!parsed.record && parsed.newerVersion === null) {
    const aside = `${path}.corrupt-${now}`;
    renameSync(path, aside);
    return {
      record: emptyStats(),
      note: `Run statistics at ${path} could not be read, so they were moved to ${aside} and a new file was started.`,
      newerVersion: null,
    };
  }
  if (parsed.newerVersion !== null) {
    return { record: emptyStats(), note: null, newerVersion: parsed.newerVersion };
  }
  return { record: parsed.record!, note: null, newerVersion: null };
}

function writeStats(path: string, record: StatsRecord): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function applyRun(
  bucket: StatsBucket | null,
  run: StatsRun,
  {
    at,
    durationMs,
    credit,
    phases,
  }: {
    at: string;
    durationMs: number;
    credit: number;
    phases: { coldBuildMs: number; podsMs: number };
  },
): StatsBucket {
  const next: StatsBucket = bucket
    ? { ...bucket }
    : {
        runs: 0,
        failed: 0,
        hits: 0,
        misses: 0,
        coldRuns: 0,
        coldRunMs: 0,
        hitRuns: 0,
        hitRunMs: 0,
        timeSavedMs: 0,
        firstRunAt: at,
        lastRunAt: at,
      };
  next.runs += 1;
  next.lastRunAt = at;
  if (phases.coldBuildMs > 0) next.lastColdBuildMs = phases.coldBuildMs;
  if (phases.podsMs > 0) next.lastPodsMs = phases.podsMs;
  if (run.failed) {
    next.failed += 1;
    return next;
  }
  if (isHit(run.cacheHit)) {
    next.hits += 1;
    if (!run.waitedForBuild) {
      next.hitRuns += 1;
      next.hitRunMs += durationMs;
      next.timeSavedMs += credit;
    }
    return next;
  }
  next.misses += 1;
  if (run.offloadedTo) {
    next.offloadedRuns = (next.offloadedRuns ?? 0) + 1;
    next.offloadedRunMs = (next.offloadedRunMs ?? 0) + durationMs;
    next.lastOffloadHost = run.offloadedTo;
    return next;
  }
  next.coldRuns += 1;
  next.coldRunMs += durationMs;
  return next;
}

function creditMs(bucket: StatsBucket | null, run: StatsRun, durationMs: number): number {
  if (run.failed || !isHit(run.cacheHit) || run.waitedForBuild) return 0;
  if (!bucket || bucket.coldRuns <= 0) return 0;
  return Math.max(0, Math.round(bucket.coldRunMs / bucket.coldRuns) - durationMs);
}

function isHit(cacheHit: CacheHitLevel): boolean {
  return cacheHit === 'local' || cacheHit === 'remote';
}

function wholeMs(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}
