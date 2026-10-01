import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { getConfigDir, withConfigLock } from '../workspace/config.ts';
import type { CacheHitLevel } from './build-facts.ts';
import type { RunOutcomeKind, StatsPlatform } from '@stim-cli/core/state';

export type { RunOutcomeKind, StatsPlatform } from '@stim-cli/core/state';

export const STATS_VERSION = 1;

export interface StatsBucket {
  runs: number;
  failed: number;
  hits: number;
  misses: number;
  coldRuns: number;
  coldRunMs: number;
  hitRuns: number;
  hitRunMs: number;
  timeSavedMs: number;
  firstRunAt: string;
  lastRunAt: string;
  lastColdBuildMs?: number;
  lastPodsMs?: number;
  offloadedRuns?: number;
  offloadedRunMs?: number;
  lastOffloadHost?: string;
}

export type StatsScope = Partial<Record<StatsPlatform, StatsBucket>>;

export interface RunSample {
  at: string;
  durationMs: number;
  phases: Record<string, number>;
  /** Whether the run created, adopted or cold-booted its device; absent on samples recorded before the tag. */
  deviceSetup?: boolean;
}

export type RunHistory = Partial<Record<StatsPlatform, Partial<Record<RunOutcomeKind, RunSample[]>>>>;

/** Where a compiling build ran: here, on a build machine, or here after offloading it failed. */
export const PLACEMENT_DECISIONS = ['here', 'offloaded', 'fell-back'] as const;

type PlacementDecision = (typeof PLACEMENT_DECISIONS)[number];

interface RunPlacement {
  decision: PlacementDecision;
  reason: string;
  machine?: string;
  /** The offloaded build's total time; a build here takes the run's compile time instead. */
  buildMs?: number;
}

interface BuildPlacement {
  at: string;
  project: string;
  platform: StatsPlatform;
  decision: PlacementDecision;
  reason: string;
  machine?: string;
  buildMs?: number;
  /** The project's last cold build here before this run. */
  localEstimateMs?: number;
  failed?: true;
}

interface BuildMachineTotals {
  offloaded: number;
  offloadedMs: number;
  /** Sum of local estimate minus offloaded build time, over offloaded builds that had an estimate; can be negative. */
  savedMs: number;
  fallbacks: number;
  lastOffloadAt?: string;
  lastFallbackAt?: string;
}

export interface StatsRecord {
  version: number;
  machine: StatsScope;
  projects: Record<string, StatsScope>;
  history?: Record<string, RunHistory>;
  placements?: BuildPlacement[];
  buildMachines?: Record<string, BuildMachineTotals>;
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

/**
 * The two phase durations a run reads back to size its own heartbeat: the
 * project's last cold build and its last `pod install`, in milliseconds.
 */
export interface RunEstimates {
  coldBuildMs: number | null;
  podsMs: number | null;
}

export interface RecordStatsResult {
  recorded: boolean;
  note: string | null;
}

export interface ReadStatsResult {
  record: StatsRecord | null;
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

const PLATFORMS: StatsPlatform[] = ['ios', 'android'];
const OUTCOMES: RunOutcomeKind[] = ['hit', 'cold'];
export const HISTORY_LIMIT = 10;
export const PLACEMENT_LIMIT = 100;
const PLACEMENT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function statsFile(): string {
  return join(getConfigDir(), 'stats.json');
}

export function emptyStats(): StatsRecord {
  return { version: STATS_VERSION, machine: {}, projects: {} };
}

export function statsProjectKey({
  root,
  commonDir,
  repoRoot,
}: {
  root: string;
  commonDir: string | null;
  repoRoot: string | null;
}): string {
  if (commonDir && repoRoot && basename(commonDir) === '.git') {
    return canonical(join(dirname(commonDir), relative(repoRoot, root)));
  }
  return canonical(root);
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

interface BuildMachineDay {
  offloaded: number;
  offloadedMs: number;
  savedMs: number;
  fallbacks: number;
}

export interface OffloadSummary {
  today: { here: number; offloaded: number; fellBack: number };
  machines: Record<string, { today: BuildMachineDay; total: BuildMachineTotals }>;
  /** Newest first. */
  placements: BuildPlacement[];
}

/** Placement counts for the local calendar day of `now`, per-machine totals, and the retained placements. */
export function offloadSummary(record: StatsRecord | null, now: number): OffloadSummary {
  const day = new Date(now).toDateString();
  const placements = record?.placements ?? [];
  const today = { here: 0, offloaded: 0, fellBack: 0 };
  const machines: OffloadSummary['machines'] = {};
  const machine = (name: string) =>
    (machines[name] ??= {
      today: { offloaded: 0, offloadedMs: 0, savedMs: 0, fallbacks: 0 },
      total: record?.buildMachines?.[name] ?? {
        offloaded: 0,
        offloadedMs: 0,
        savedMs: 0,
        fallbacks: 0,
      },
    });
  for (const name of Object.keys(record?.buildMachines ?? {})) machine(name);
  for (const placement of placements) {
    if (new Date(placement.at).toDateString() !== day) continue;
    if (placement.decision === 'here') {
      today.here += 1;
      continue;
    }
    if (placement.decision === 'fell-back') today.fellBack += 1;
    else today.offloaded += 1;
    if (!placement.machine) continue;
    const entry = machine(placement.machine).today;
    if (placement.decision === 'fell-back') {
      entry.fallbacks += 1;
      continue;
    }
    entry.offloaded += 1;
    entry.offloadedMs += placement.buildMs ?? 0;
    if (placement.localEstimateMs && placement.buildMs) entry.savedMs += placement.localEstimateMs - placement.buildMs;
  }
  return { today, machines, placements: placements.toReversed() };
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

function trimSamples(samples: RunSample[]): RunSample[] {
  const kept = { setup: 0, other: 0 };
  const out: RunSample[] = [];
  for (const sample of samples.toReversed()) {
    const kind = sample.deviceSetup === true ? 'setup' : 'other';
    if (kept[kind] >= HISTORY_LIMIT) continue;
    kept[kind] += 1;
    out.push(sample);
  }
  return out.toReversed();
}

export function readStats(): ReadStatsResult {
  const path = statsFile();
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { record: null, note: null };
  }
  const parsed = parseRecord(text);
  if (!parsed) {
    return {
      record: null,
      note: `Run statistics at ${path} could not be read; the next ios or android run moves them aside and starts a new file.`,
    };
  }
  if (parsed.version > STATS_VERSION) {
    return {
      record: null,
      note: `Run statistics at ${path} are version ${parsed.version}, which this Stim does not understand, so none are shown.`,
    };
  }
  return { record: normalize(parsed), note: null };
}

function projectEstimates(record: StatsRecord | null, projectKey: string, platform: StatsPlatform): RunEstimates {
  const bucket = record?.projects?.[projectKey]?.[platform] ?? null;
  return {
    coldBuildMs: positive(bucket?.lastColdBuildMs),
    podsMs: positive(bucket?.lastPodsMs),
  };
}

export function readRunEstimates({
  projectKey,
  platform,
  read = readStats,
}: {
  projectKey: string | null;
  platform: StatsPlatform;
  read?: () => ReadStatsResult;
}): RunEstimates {
  if (!projectKey) return { coldBuildMs: null, podsMs: null };
  try {
    return projectEstimates(read().record, projectKey, platform);
  } catch {
    return { coldBuildMs: null, podsMs: null };
  }
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
  const parsed = parseRecord(text);
  if (!parsed) {
    const aside = `${path}.corrupt-${now}`;
    renameSync(path, aside);
    return {
      record: emptyStats(),
      note: `Run statistics at ${path} could not be read, so they were moved to ${aside} and a new file was started.`,
      newerVersion: null,
    };
  }
  if (parsed.version > STATS_VERSION) {
    return { record: emptyStats(), note: null, newerVersion: parsed.version };
  }
  return { record: normalize(parsed), note: null, newerVersion: null };
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

function parseRecord(text: string): StatsRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  return parsed as StatsRecord;
}

function normalize(record: StatsRecord): StatsRecord {
  const projects: Record<string, StatsScope> = {};
  const source = record.projects;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, scope] of Object.entries(source)) projects[key] = normalizeScope(scope);
  }
  const history: Record<string, RunHistory> = {};
  if (isObject(record.history)) {
    for (const [key, scope] of Object.entries(record.history)) {
      const normalized = normalizeHistory(scope);
      if (Object.keys(normalized).length) history[key] = normalized;
    }
  }
  const placements = Array.isArray(record.placements) ? record.placements.flatMap(normalizePlacement) : [];
  const buildMachines: Record<string, BuildMachineTotals> = {};
  if (isObject(record.buildMachines)) {
    for (const [name, totals] of Object.entries(record.buildMachines)) {
      if (isObject(totals)) buildMachines[name] = normalizeMachineTotals(totals);
    }
  }
  return {
    version: STATS_VERSION,
    machine: normalizeScope(record.machine),
    projects,
    ...(Object.keys(history).length ? { history } : {}),
    ...(placements.length ? { placements } : {}),
    ...(Object.keys(buildMachines).length ? { buildMachines } : {}),
  };
}

function normalizePlacement(value: unknown): BuildPlacement[] {
  if (!isObject(value)) return [];
  const { decision, platform, reason, project, machine } = value;
  if (!PLACEMENT_DECISIONS.includes(decision as PlacementDecision) || !PLATFORMS.includes(platform as StatsPlatform))
    return [];
  if (typeof reason !== 'string' || typeof project !== 'string') return [];
  const buildMs = wholeMs(value.buildMs);
  const localEstimateMs = wholeMs(value.localEstimateMs);
  return [
    {
      at: timestamp(value.at),
      project,
      platform: platform as StatsPlatform,
      decision: decision as PlacementDecision,
      reason,
      ...(typeof machine === 'string' && machine !== '' ? { machine } : {}),
      ...(buildMs > 0 ? { buildMs } : {}),
      ...(localEstimateMs > 0 ? { localEstimateMs } : {}),
      ...(value.failed === true ? { failed: true as const } : {}),
    },
  ];
}

function normalizeMachineTotals(totals: Record<string, unknown>): BuildMachineTotals {
  const savedMs = Number(totals.savedMs);
  return {
    offloaded: count(totals.offloaded),
    offloadedMs: count(totals.offloadedMs),
    savedMs: Number.isFinite(savedMs) ? Math.round(savedMs) : 0,
    fallbacks: count(totals.fallbacks),
    ...(typeof totals.lastOffloadAt === 'string' ? { lastOffloadAt: totals.lastOffloadAt } : {}),
    ...(typeof totals.lastFallbackAt === 'string' ? { lastFallbackAt: totals.lastFallbackAt } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHistory(scope: unknown): RunHistory {
  const history: RunHistory = {};
  if (!isObject(scope)) return history;
  for (const platform of PLATFORMS) {
    const lists = scope[platform];
    if (!isObject(lists)) continue;
    const normalized: Partial<Record<RunOutcomeKind, RunSample[]>> = {};
    for (const outcome of OUTCOMES) {
      const samples = lists[outcome];
      if (!Array.isArray(samples)) continue;
      const kept = samples.filter(isObject).flatMap((sample): RunSample[] => {
        const durationMs = wholeMs(sample.durationMs);
        if (durationMs <= 0) return [];
        return [
          {
            at: timestamp(sample.at),
            durationMs,
            phases: wholePhases(sample.phases),
            ...(typeof sample.deviceSetup === 'boolean' ? { deviceSetup: sample.deviceSetup } : {}),
          },
        ];
      });
      if (kept.length) normalized[outcome] = trimSamples(kept);
    }
    if (Object.keys(normalized).length) history[platform] = normalized;
  }
  return history;
}

function wholePhases(phases: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(phases)) return out;
  for (const [name, ms] of Object.entries(phases)) {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 0) out[name] = Math.round(value);
  }
  return out;
}

function normalizeScope(scope: unknown): StatsScope {
  const normalized: StatsScope = {};
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return normalized;
  for (const platform of PLATFORMS) {
    const bucket = (scope as Record<string, unknown>)[platform];
    if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
      normalized[platform] = normalizeBucket(bucket as Record<string, unknown>);
    }
  }
  return normalized;
}

function normalizeBucket(bucket: Record<string, unknown>): StatsBucket {
  return {
    runs: count(bucket.runs),
    failed: count(bucket.failed),
    hits: count(bucket.hits),
    misses: count(bucket.misses),
    coldRuns: count(bucket.coldRuns),
    coldRunMs: count(bucket.coldRunMs),
    hitRuns: count(bucket.hitRuns),
    hitRunMs: count(bucket.hitRunMs),
    timeSavedMs: count(bucket.timeSavedMs),
    firstRunAt: timestamp(bucket.firstRunAt),
    lastRunAt: timestamp(bucket.lastRunAt),
    ...(count(bucket.lastColdBuildMs) > 0 ? { lastColdBuildMs: count(bucket.lastColdBuildMs) } : {}),
    ...(count(bucket.lastPodsMs) > 0 ? { lastPodsMs: count(bucket.lastPodsMs) } : {}),
    ...(count(bucket.offloadedRuns) > 0
      ? {
          offloadedRuns: count(bucket.offloadedRuns),
          offloadedRunMs: count(bucket.offloadedRunMs),
        }
      : {}),
    ...(typeof bucket.lastOffloadHost === 'string' ? { lastOffloadHost: bucket.lastOffloadHost } : {}),
  };
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

function positive(value: unknown): number | null {
  const ms = wholeMs(value);
  return ms > 0 ? ms : null;
}

function wholeMs(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

function count(value: unknown): number {
  return wholeMs(value);
}

function timestamp(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : new Date(0).toISOString();
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
