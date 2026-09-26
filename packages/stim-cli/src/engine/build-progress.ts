import { formatElapsed, plural } from '../command-output.ts';
import { readClaimSet, type ClaimHandle, type ClaimSurvey } from '../ownership-claim.ts';
import { clearWorkspaceStateKey, updateWorkspaceState } from '../workspace/workspace-state.ts';
import type { RunHistory, RunOutcomeKind, RunSample, StatsPlatform } from './stats.ts';
import {
  BUILD_HISTORY_KEY,
  BUILD_HISTORY_LIMIT,
  BUILD_PHASES,
  LAST_BUILD_KEYS,
  type ActiveBuildState,
  type BuildPhase,
  type BuildReport,
  type BuildResult,
  type WorkspaceState,
} from '@stim-cli/core/state';

export type { ActiveBuildState, BuildPhase, BuildReport } from '@stim-cli/core/state';

export const ACTIVE_BUILD_KEY = 'activeBuild';

export interface ActiveBuildClaim {
  root: string;
  path: string;
  claimId: string;
  pid: number;
}

export interface ActiveBuildRecord {
  platform: StatsPlatform;
  slot: string;
  startedAt: string;
  phase: BuildPhase;
  phaseStartedAt: string;
  phases: { phase: BuildPhase; startedAt: string }[];
  claim: ActiveBuildClaim;
}

export interface BuildProgress {
  step(phase: BuildPhase): void;
  durations(): Record<string, number>;
  clear(): void;
}

export const NO_BUILD_PROGRESS: BuildProgress = {
  step: () => {},
  durations: () => ({}),
  clear: () => {},
};

const COLD_PHASES: readonly BuildPhase[] = ['prebuild', 'pods', 'compile'];
const DEVICE_PHASES: readonly BuildPhase[] = ['install', 'launch'];

export function startBuildProgress({
  root,
  platform,
  slot,
  claim,
  now = Date.now,
  note = () => {},
}: {
  root: string;
  platform: StatsPlatform;
  slot: string;
  claim: ClaimHandle;
  now?: () => number;
  note?: (line: string) => void;
}): BuildProgress {
  const startedAt = new Date(now()).toISOString();
  const record: ActiveBuildRecord = {
    platform,
    slot,
    startedAt,
    phase: 'prepare',
    phaseStartedAt: startedAt,
    phases: [{ phase: 'prepare', startedAt }],
    claim: { root: claim.root, path: claim.path, claimId: claim.claimId, pid: claim.owner.pid },
  };
  let warned = false;
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      if (warned) return;
      warned = true;
      note(`Build progress could not be recorded in the workspace state: ${(error as Error)?.message || error}`);
    }
  };
  const write = (before: (state: WorkspaceState) => WorkspaceState = (state) => state) =>
    guard(() => updateWorkspaceState(root, (state) => ({ ...before(state), [ACTIVE_BUILD_KEY]: record })));
  write(withInterruptedBuild);
  return {
    step(phase) {
      if (phase === record.phase) return;
      const at = new Date(now()).toISOString();
      record.phase = phase;
      record.phaseStartedAt = at;
      record.phases.push({ phase, startedAt: at });
      write();
    },
    durations() {
      return phaseDurations(record.phases, now());
    },
    clear() {
      guard(() => {
        clearWorkspaceStateKey(
          root,
          ACTIVE_BUILD_KEY,
          (value) => parseActiveBuild(value)?.claim.claimId === record.claim.claimId,
        );
      });
    },
  };
}

function phaseDurations(phases: ActiveBuildRecord['phases'], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  phases.forEach(({ phase, startedAt }, index) => {
    const start = Date.parse(startedAt);
    const next = phases[index + 1];
    const end = next ? Date.parse(next.startedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    out[phase] = (out[phase] ?? 0) + Math.max(0, end - start);
  });
  return out;
}

const HISTORY_FIELDS = [
  'platform',
  'status',
  'configuration',
  'fingerprint',
  'cacheKey',
  'cacheHit',
  'cacheSkipped',
  'durationMs',
  'startedAt',
  'errorCode',
  'missReason',
  'diagnostics',
] as const;

function withHistoryEntry(
  state: WorkspaceState,
  platform: StatsPlatform,
  entry: Record<string, unknown>,
): WorkspaceState {
  const saved = state[BUILD_HISTORY_KEY];
  const history = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const list = Array.isArray(history[platform]) ? (history[platform] as unknown[]) : [];
  return {
    ...state,
    [BUILD_HISTORY_KEY]: { ...history, [platform]: [entry, ...list].slice(0, BUILD_HISTORY_LIMIT) },
  };
}

function finishedResult(record: Record<string, unknown>): BuildResult {
  if (record.status === 'ok') return 'succeeded';
  return record.errorCode === 'STIM_CANCELLED' ? 'cancelled' : 'failed';
}

/** Record a finished run as its platform's last build and the newest entry of its history, in one locked write. */
export function recordFinishedBuild(
  root: string,
  record: Record<string, unknown>,
  { update = updateWorkspaceState, now = Date.now }: { update?: typeof updateWorkspaceState; now?: () => number } = {},
): void {
  const platform = record.platform as StatsPlatform;
  update(root, (state) => {
    const active = parseActiveBuild(state[ACTIVE_BUILD_KEY]);
    const own = active?.platform === platform ? active : null;
    const entry: Record<string, unknown> = {
      ...Object.fromEntries(HISTORY_FIELDS.filter((key) => key in record).map((key) => [key, record[key]])),
      result: finishedResult(record),
      slot: own?.slot ?? 'default',
      phases: own ? phaseDurations(own.phases, now()) : {},
    };
    return withHistoryEntry({ ...state, lastBuild: record, [LAST_BUILD_KEYS[platform]]: record }, platform, entry);
  });
}

function withInterruptedBuild(state: WorkspaceState): WorkspaceState {
  const left = parseActiveBuild(state[ACTIVE_BUILD_KEY]);
  if (!left) return state;
  const last = state[LAST_BUILD_KEYS[left.platform]] as { startedAt?: unknown } | undefined;
  if (Date.parse(String(last?.startedAt)) >= Date.parse(left.startedAt)) return state;
  return withHistoryEntry(state, left.platform, {
    platform: left.platform,
    status: 'failed',
    result: 'interrupted',
    slot: left.slot,
    configuration: null,
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    cacheSkipped: false,
    durationMs: null,
    startedAt: left.startedAt,
    phases: phaseDurations(left.phases, Date.parse(left.phaseStartedAt)),
  });
}

export function parseActiveBuild(value: unknown): ActiveBuildRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ActiveBuildRecord>;
  const claim = record.claim as Partial<ActiveBuildClaim> | undefined;
  if (record.platform !== 'ios' && record.platform !== 'android') return null;
  if (!isPhase(record.phase)) return null;
  if (typeof record.startedAt !== 'string' || typeof record.phaseStartedAt !== 'string') return null;
  if (!claim || typeof claim.root !== 'string' || typeof claim.claimId !== 'string') return null;
  const phases = Array.isArray(record.phases)
    ? record.phases.filter((entry) => isPhase(entry?.phase) && typeof entry?.startedAt === 'string')
    : [];
  return {
    platform: record.platform,
    slot: typeof record.slot === 'string' ? record.slot : 'default',
    startedAt: record.startedAt,
    phase: record.phase,
    phaseStartedAt: record.phaseStartedAt,
    phases,
    claim: {
      root: claim.root,
      path: typeof claim.path === 'string' ? claim.path : '',
      claimId: claim.claimId,
      pid: typeof claim.pid === 'number' ? claim.pid : 0,
    },
  };
}

function isPhase(value: unknown): value is BuildPhase {
  return (BUILD_PHASES as readonly unknown[]).includes(value);
}

export function activeBuildState(
  claim: ActiveBuildClaim,
  survey: ClaimSurvey = readClaimSet(claim.root),
): ActiveBuildState {
  if (survey.live.some((holder) => holder.claimId === claim.claimId)) return 'running';
  if (survey.dead.some((holder) => holder.claimId === claim.claimId)) return 'stale';
  return survey.unresolved.length ? 'unknown' : 'stale';
}

function liveOutcome(record: ActiveBuildRecord): RunOutcomeKind | null {
  const seen = new Set(record.phases.map((entry) => entry.phase));
  if (COLD_PHASES.some((phase) => seen.has(phase))) return 'cold';
  if (DEVICE_PHASES.some((phase) => seen.has(phase))) return 'hit';
  return null;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function estimateBuild(
  history: RunHistory | undefined,
  platform: StatsPlatform,
  known: RunOutcomeKind | null,
  phase: BuildPhase,
): Pick<BuildReport, 'outcome' | 'expectedMs' | 'expectedPhaseMs' | 'basis'> {
  const lists = history?.[platform];
  const outcome = known ?? latestOutcome(lists);
  const samples: RunSample[] = (outcome && lists?.[outcome]) || [];
  const phaseSamples = samples.flatMap((sample) => (phase in sample.phases ? [sample.phases[phase]!] : []));
  return {
    outcome,
    expectedMs: median(samples.map((sample) => sample.durationMs)),
    expectedPhaseMs: median(phaseSamples),
    basis: samples.length,
  };
}

function latestOutcome(lists: Partial<Record<RunOutcomeKind, RunSample[]>> | undefined): RunOutcomeKind | null {
  let latest: { outcome: RunOutcomeKind; at: number } | null = null;
  for (const outcome of ['hit', 'cold'] as const) {
    const last = lists?.[outcome]?.at(-1);
    const at = last ? Date.parse(last.at) : Number.NaN;
    if (Number.isFinite(at) && (!latest || at > latest.at)) latest = { outcome, at };
  }
  return latest?.outcome ?? null;
}

export function buildReport(
  record: ActiveBuildRecord,
  { state, history }: { state: ActiveBuildState; history: RunHistory | undefined },
): BuildReport {
  return {
    platform: record.platform,
    slot: record.slot,
    state,
    phase: record.phase,
    startedAt: record.startedAt,
    phaseStartedAt: record.phaseStartedAt,
    ...estimateBuild(history, record.platform, liveOutcome(record), record.phase),
  };
}

function remainingText(remainingMs: number): string {
  return remainingMs < 60_000 ? 'under a minute left' : `about ${Math.ceil(remainingMs / 60_000)} min left`;
}

export function buildStatusLine(report: BuildReport, now: number): string {
  const slot = report.slot === 'default' ? '' : ` [${report.slot}]`;
  if (report.state === 'stale') {
    return `build: stale ${report.platform}${slot} record from ${report.startedAt} (its run is gone; the next run replaces it)`;
  }
  const elapsedMs = Math.max(0, now - Date.parse(report.startedAt));
  const head = `build: ${report.platform}${slot} ${report.phase}, ${formatElapsed(elapsedMs)} elapsed`;
  if (report.state === 'unknown') return `${head} (its native-run claim cannot be resolved, so it may not be running)`;
  if (report.expectedMs === null) return head;
  const basis = `median of ${plural(report.basis, `${report.outcome} run`)}`;
  const remainingMs = report.expectedMs - elapsedMs;
  return remainingMs > 0
    ? `${head} -- ${remainingText(remainingMs)} (${basis})`
    : `${head} (usually ~${formatElapsed(report.expectedMs)}, ${basis})`;
}
