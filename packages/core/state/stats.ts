import { readSwiftpmCacheUsage, type SwiftpmCacheUsage } from './swiftpm-cache-usage.ts';
import { readAgentDeviceUsage, type AgentDeviceUsage } from './agent-device-usage.ts';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readStateFile } from './json-file.ts';
import { statsFile } from './paths.ts';
import type { RunOutcomeKind, StatsPlatform } from './status.ts';

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

export interface StatsPlacement {
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

export interface BuildMachineTotals {
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
  placements?: StatsPlacement[];
  buildMachines?: Record<string, BuildMachineTotals>;
}

/**
 * The two phase durations a run reads back to size its own heartbeat: the
 * project's last cold build and its last `pod install`, in milliseconds.
 */
export interface RunEstimates {
  coldBuildMs: number | null;
  podsMs: number | null;
}

export interface ReadStatsResult {
  record: StatsRecord | null;
  note: string | null;
}

const PLATFORMS: StatsPlatform[] = ['ios', 'android'];
const OUTCOMES: RunOutcomeKind[] = ['hit', 'cold'];
export const HISTORY_LIMIT = 10;

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
    return canonical(join(canonical(dirname(commonDir)), relative(canonical(repoRoot), canonical(root))));
  }
  return canonical(root);
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
  placements: StatsPlacement[];
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

export function trimSamples(samples: RunSample[]): RunSample[] {
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
    text = readStateFile(path);
  } catch {
    return { record: null, note: null };
  }
  const parsed = decodeStats(text);
  if (!parsed.record && parsed.newerVersion === null) {
    return {
      record: null,
      note: `Run statistics at ${path} could not be read; the next ios or android run moves them aside and starts a new file.`,
    };
  }
  if (parsed.newerVersion !== null) {
    return {
      record: null,
      note: `Run statistics at ${path} are version ${parsed.newerVersion}, which this Stim does not understand, so none are shown.`,
    };
  }
  return { record: parsed.record, note: null };
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

function normalizePlacement(value: unknown): StatsPlacement[] {
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

export function wholePhases(phases: unknown): Record<string, number> {
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
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function decodeStats(text: string): { record: StatsRecord | null; newerVersion: number | null } {
  const parsed = parseRecord(text);
  if (!parsed) return { record: null, newerVersion: null };
  if (parsed.version > STATS_VERSION) return { record: null, newerVersion: parsed.version };
  return { record: normalize(parsed), newerVersion: null };
}

export interface StatsReport {
  version: number;
  project: ({ key: string } & StatsReport['machine']) | null;
  machine: { ios: StatsBucket | null; android: StatsBucket | null };
  offload: OffloadSummary;
  agentDevice: AgentDeviceUsage | null;
  swiftpmCache: SwiftpmCacheUsage | null;
}

export function readStatsReport(key: string | null, now: number): { report: StatsReport; note: string | null } {
  const { record, note } = readStats();
  const project = key ? record?.projects[key] : null;
  return {
    report: {
      version: STATS_VERSION,
      project: key ? { key, ios: project?.ios ?? null, android: project?.android ?? null } : null,
      machine: { ios: record?.machine.ios ?? null, android: record?.machine.android ?? null },
      offload: offloadSummary(record, now),
      agentDevice: readAgentDeviceUsage(),
      swiftpmCache: readSwiftpmCacheUsage(),
    },
    note,
  };
}

export function findProjectRoot(startDir: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(resolve(startDir));
  } catch {
    dir = resolve(startDir);
  }
  while (true) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'Package.swift'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
