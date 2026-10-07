import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatElapsed, plural } from '../command-output.ts';
import { readClaimSet, type ClaimHandle, type ClaimSurvey } from '../ownership-claim.ts';
import { clearWorkspaceStateKey, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { readStats, type RunHistory, type RunOutcomeKind, type RunSample, type StatsPlatform } from './stats.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createBuildDetailParser } from './build-detail.ts';
import {
  BUILD_HISTORY_KEY,
  BUILD_HISTORY_LIMIT,
  BUILD_PHASES,
  LAST_BUILD_KEYS,
  parseMissReason,
  workspaceBuildDetailFile,
  type ActiveBuildState,
  type BuildDetail,
  type BuildMissReason,
  type BuildPhase,
  type BuildPlacement,
  type BuildReport,
  type BuildWaitingFor,
  type BuildResult,
  type PlannedPhase,
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
  missReason?: BuildMissReason;
  missProvisional?: true;
  placement?: Exclude<BuildPlacement, 'local'>;
  /** The workspace whose identical build this run waits on, while its phase is `wait`. */
  waitingOn?: { path: string };
  waitingFor?: BuildWaitingFor;
  /** Whether the run created, adopted or cold-booted its device, once `ensureOwnedDevice`/`ensureDevice` returned. */
  deviceSetup?: boolean;
  /** The run's cache outcome, once it entered a phase that settles it. */
  outcome?: RunOutcomeKind;
  /** The estimate the run made when it knew its project, and again when it knew its outcome. */
  estimate?: BuildEstimate;
}

/**
 * A run's estimate from its project's recent comparable runs: their median duration, how many there were, the median
 * of each phase they entered, and the phases at least half of them entered, in phase order.
 */
export interface BuildEstimate {
  outcome: RunOutcomeKind | null;
  expectedMs: number | null;
  basis: number;
  phaseMs: Partial<Record<BuildPhase, number>>;
  planned: BuildPhase[];
}

export interface BuildProgress {
  step(phase: BuildPhase): void;
  /** Estimates the run from the recent runs of the project with `projectKey`, and again once its outcome is known. */
  estimate(projectKey: string): void;
  /**
   * Records why the run's cache lookup missed. `provisional` marks a miss of the pre-mutation key that prebuild or
   * pod install will re-check; the run counts as a cold one unless `hit` says otherwise.
   */
  miss(reason: BuildMissReason, provisional?: boolean): void;
  /** Records a resolved cache hit, replacing any earlier miss of the lookup or pre-mutation key. */
  hit(): void;
  /** Records whether the run set up its device (created, adopted or cold-booted) rather than reusing a booted one. */
  deviceSetup(setup: boolean | undefined): void;
  /** What `deviceSetup` recorded, or undefined before the run knows. */
  deviceSetupKnown(): boolean | undefined;
  /** Records the build machine the run compiles on and its phase there; null when it compiles here again. */
  place(remote: { host: string; phase: string } | null): void;
  /** Records the workspace root whose build of the same artifact the run waits on; null when it is not known. */
  waitingOn(root: string | null): void;
  waitingFor(info: BuildWaitingFor | null, kind?: BuildWaitingFor['kind']): void;
  /** Reads one record the run writes to its build log, for the native tool's progress. */
  output(record: unknown): void;
  durations(): Record<string, number>;
  clear(): void;
}

export const NO_BUILD_PROGRESS: BuildProgress = {
  step: () => {},
  estimate: () => {},
  miss: () => {},
  hit: () => {},
  deviceSetup: () => {},
  deviceSetupKnown: () => undefined,
  place: () => {},
  waitingOn: () => {},
  waitingFor: () => {},
  output: () => {},
  durations: () => ({}),
  clear: () => {},
};

/** `writer`, with each record it writes also passed to `progress.output`. */
export function tapBuildLog(writer: NdjsonWriter, progress: BuildProgress): NdjsonWriter {
  if (progress === NO_BUILD_PROGRESS) return writer;
  return {
    get file() {
      return writer.file;
    },
    write(record) {
      progress.output(record);
      return writer.write(record);
    },
    close: () => writer.close(),
    get written() {
      return writer.written;
    },
    get dropped() {
      return writer.dropped;
    },
    get lastError() {
      return writer.lastError;
    },
  };
}

const DETAIL_WRITE_MS = 2000;

function toolLine(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const { src, level, msg } = record as Record<string, unknown>;
  return src === 'build' && level === 'debug' && typeof msg === 'string' ? msg : null;
}

function writeBuildDetail(root: string, claimId: string, detail: BuildDetail): void {
  const file = workspaceBuildDetailFile(root);
  const tmp = `${file}.tmp-${process.pid}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify({ claimId, detail }));
  renameSync(tmp, file);
}

const COLD_PHASES: readonly BuildPhase[] = ['prebuild', 'pods', 'compile'];
const HIT_PHASES: readonly BuildPhase[] = ['install', 'launch'];

function settledOutcome(phase: BuildPhase, entered: ActiveBuildRecord['phases']): RunOutcomeKind | null {
  if (COLD_PHASES.includes(phase)) return 'cold';
  if (phase === 'device') return entered.some((entry) => entry.phase === 'cache-lookup') ? 'hit' : null;
  return HIT_PHASES.includes(phase) ? 'hit' : null;
}

function projectHistory(projectKey: string): RunHistory | undefined {
  try {
    return readStats().record?.history?.[projectKey];
  } catch {
    return undefined;
  }
}

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
  let projectKey: string | null = null;
  const parser = createBuildDetailParser();
  let detailWrittenAt = -Infinity;
  let detailTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDetail = () => {
    detailTimer = null;
    detailWrittenAt = now();
    const detail = parser.detail(new Date(detailWrittenAt).toISOString());
    if (detail) guard(() => writeBuildDetail(root, record.claim.claimId, detail));
  };
  const settle = (outcome: RunOutcomeKind): void => {
    record.outcome = outcome;
    if (projectKey) record.estimate = estimateBuild(projectHistory(projectKey), platform, outcome, record.deviceSetup);
  };
  const waits = new Map<BuildWaitingFor['kind'], BuildWaitingFor>();
  return {
    step(phase) {
      if (phase === record.phase) return;
      const at = new Date(now()).toISOString();
      record.phase = phase;
      record.phaseStartedAt = at;
      record.phases.push({ phase, startedAt: at });
      if (phase !== 'wait') delete record.waitingOn;
      const outcome = record.outcome ? null : settledOutcome(phase, record.phases);
      if (outcome) settle(outcome);
      write();
    },
    estimate(key) {
      projectKey = key;
      record.estimate = estimateBuild(
        projectHistory(key),
        platform,
        record.outcome ?? null,
        record.outcome ? record.deviceSetup : undefined,
      );
      write();
    },
    miss(reason, provisional = false) {
      record.missReason = reason;
      settle('cold');
      if (provisional) {
        record.missProvisional = true;
      } else {
        delete record.missProvisional;
      }
      write();
    },
    hit() {
      delete record.missReason;
      delete record.missProvisional;
      settle('hit');
      write();
    },
    deviceSetup(setup) {
      if (setup === undefined) return;
      record.deviceSetup = setup;
      write();
    },
    deviceSetupKnown() {
      return record.deviceSetup;
    },
    place(remote) {
      const current = record.placement;
      if (!remote) {
        if (!current) return;
        delete record.placement;
        return write();
      }
      if (current?.host === remote.host && current.phase === remote.phase) return;
      const at = new Date(now()).toISOString();
      record.placement = {
        host: remote.host,
        phase: remote.phase,
        startedAt: current?.host === remote.host ? current.startedAt : at,
        phaseStartedAt: at,
      };
      write();
    },
    waitingFor(info, kind) {
      if (info) waits.set(info.kind, info);
      else if (kind) waits.delete(kind);
      else waits.clear();
      const first = [...waits.values()].toSorted((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
      if (first) record.waitingFor = first;
      else delete record.waitingFor;
      write();
    },
    waitingOn(holder) {
      if (holder === null) {
        if (!record.waitingOn) return;
        delete record.waitingOn;
      } else {
        if (record.waitingOn?.path === holder) return;
        record.waitingOn = { path: holder };
      }
      write();
    },
    output(line) {
      const msg = toolLine(line);
      if (msg === null || !parser.push(msg) || detailTimer) return;
      const wait = detailWrittenAt + DETAIL_WRITE_MS - now();
      if (wait <= 0) return flushDetail();
      detailTimer = setTimeout(flushDetail, wait);
      detailTimer.unref?.();
    },
    durations() {
      return phaseDurations(record.phases, now());
    },
    clear() {
      if (detailTimer) clearTimeout(detailTimer);
      detailTimer = null;
      guard(() => rmSync(workspaceBuildDetailFile(root), { force: true }));
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

export function completedPhaseDurations(phases: ActiveBuildRecord['phases']): BuildReport['completedPhaseMs'] {
  if (phases.length < 2) return undefined;
  const durations = phaseDurations(phases.slice(0, -1), Date.parse(phases.at(-1)!.startedAt));
  return Object.keys(durations).length ? durations : undefined;
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
  'buildMachine',
  'builtOn',
  'offloadedTo',
  'offloadFallback',
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
    phases: { ...phaseDurations(left.phases, Date.parse(left.phaseStartedAt)), [left.phase]: 0 },
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
  const missReason = parseMissReason(record.missReason);
  const placement = parsePlacement(record.placement);
  const waitingOn = parseWaitingOn(record.waitingOn);
  const waitingFor = parseWaitingFor(record.waitingFor);
  const estimate = parseEstimate(record.estimate);
  return {
    platform: record.platform,
    slot: typeof record.slot === 'string' ? record.slot : 'default',
    startedAt: record.startedAt,
    phase: record.phase,
    phaseStartedAt: record.phaseStartedAt,
    phases,
    ...(missReason ? { missReason } : {}),
    ...(missReason && record.missProvisional === true ? { missProvisional: true as const } : {}),
    ...(placement ? { placement } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    ...(waitingFor ? { waitingFor } : {}),
    ...(typeof record.deviceSetup === 'boolean' ? { deviceSetup: record.deviceSetup } : {}),
    ...(record.outcome === 'hit' || record.outcome === 'cold' ? { outcome: record.outcome } : {}),
    ...(estimate ? { estimate } : {}),
    claim: {
      root: claim.root,
      path: typeof claim.path === 'string' ? claim.path : '',
      claimId: claim.claimId,
      pid: typeof claim.pid === 'number' ? claim.pid : 0,
    },
  };
}

function parsePlacement(value: unknown): ActiveBuildRecord['placement'] | null {
  if (!value || typeof value !== 'object') return null;
  const { host, phase, startedAt, phaseStartedAt } = value as Record<string, unknown>;
  if ([host, phase, startedAt, phaseStartedAt].some((field) => typeof field !== 'string')) return null;
  return {
    host: host as string,
    phase: phase as string,
    startedAt: startedAt as string,
    phaseStartedAt: phaseStartedAt as string,
  };
}

function parseWaitingFor(value: unknown): BuildWaitingFor | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, inUse, max, since } = value as BuildWaitingFor;
  if (kind !== 'build-slot' && kind !== 'device-slot') return null;
  if (!Number.isInteger(inUse) || inUse < 0 || !Number.isInteger(max) || max <= 0) return null;
  if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) return null;
  return { kind, inUse, max, since };
}

function parseWaitingOn(value: unknown): ActiveBuildRecord['waitingOn'] | null {
  const path = (value as { path?: unknown } | null | undefined)?.path;
  return typeof path === 'string' && path ? { path } : null;
}

function parseEstimate(value: unknown): BuildEstimate | null {
  if (!value || typeof value !== 'object') return null;
  const { outcome, expectedMs, basis, phaseMs, planned } = value as Record<string, unknown>;
  if (outcome !== null && outcome !== 'hit' && outcome !== 'cold') return null;
  if (expectedMs !== null && typeof expectedMs !== 'number') return null;
  if (typeof basis !== 'number' || !Array.isArray(planned) || !phaseMs || typeof phaseMs !== 'object') return null;
  const durations = Object.entries(phaseMs).filter(
    (entry): entry is [BuildPhase, number] => isPhase(entry[0]) && typeof entry[1] === 'number',
  );
  return {
    outcome,
    expectedMs,
    basis,
    phaseMs: Object.fromEntries(durations),
    planned: planned.filter(isPhase),
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
  deviceSetup?: boolean,
): BuildEstimate {
  const lists = history?.[platform];
  const outcome = known ?? latestOutcome(lists);
  const samples = matchDeviceSetup((outcome && lists?.[outcome]) || [], deviceSetup);
  const phaseMs: Partial<Record<BuildPhase, number>> = {};
  const planned: BuildPhase[] = [];
  for (const phase of BUILD_PHASES) {
    const durations = samples.flatMap((sample) => (phase in sample.phases ? [sample.phases[phase]!] : []));
    const ms = median(durations);
    if (ms === null) continue;
    phaseMs[phase] = ms;
    if (durations.length * 2 >= samples.length) planned.push(phase);
  }
  return {
    outcome,
    expectedMs: median(samples.map((sample) => sample.durationMs)),
    basis: samples.length,
    phaseMs,
    planned,
  };
}

const MIN_TAGGED_SAMPLES = 3;

function matchDeviceSetup(samples: RunSample[], deviceSetup: boolean | undefined): RunSample[] {
  if (deviceSetup === undefined) return samples;
  const tagged = samples.filter((sample) => sample.deviceSetup === deviceSetup);
  if (deviceSetup || tagged.length >= MIN_TAGGED_SAMPLES) return tagged;
  return samples.filter((sample) => sample.deviceSetup !== true);
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
  const estimate =
    record.estimate ??
    estimateBuild(history, record.platform, record.outcome ?? null, record.outcome ? record.deviceSetup : undefined);
  const plannedPhases: PlannedPhase[] = estimate.planned.flatMap((phase) => {
    const expectedMs = estimate.phaseMs[phase];
    return expectedMs === undefined ? [] : [{ phase, expectedMs }];
  });
  const completedPhaseMs = completedPhaseDurations(record.phases);
  return {
    platform: record.platform,
    slot: record.slot,
    state,
    phase: record.phase,
    startedAt: record.startedAt,
    phaseStartedAt: record.phaseStartedAt,
    outcome: estimate.outcome,
    outcomeKnown: record.outcome !== undefined,
    ...(record.outcome && record.phases.some(({ phase }) => phase === 'cache-lookup')
      ? { cacheLookupOutcome: record.outcome === 'hit' ? ('hit' as const) : ('miss' as const) }
      : {}),
    expectedMs: estimate.expectedMs,
    expectedPhaseMs: estimate.phaseMs[record.phase] ?? null,
    ...(completedPhaseMs ? { completedPhaseMs } : {}),
    basis: estimate.basis,
    plannedPhases: plannedPhases.length ? plannedPhases : null,
    ...(record.missReason ? { missReason: record.missReason } : {}),
    ...(record.missReason && record.missProvisional ? { missProvisional: true as const } : {}),
    placement: record.placement ?? 'local',
    ...(record.waitingOn ? { waitingOn: record.waitingOn } : {}),
    ...(record.waitingFor ? { waitingFor: record.waitingFor } : {}),
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
  const remote =
    typeof report.placement === 'object'
      ? ` on ${report.placement.host} (${report.placement.phase}, ${formatElapsed(Math.max(0, now - Date.parse(report.placement.phaseStartedAt)))})`
      : '';
  const waiting = report.waitingOn ? ` on ${report.waitingOn.path}` : '';
  const head = `build: ${report.platform}${slot} ${report.phase}${waiting}${remote}, ${formatElapsed(elapsedMs)} elapsed`;
  if (report.state === 'unknown') return `${head} (its native-run claim cannot be resolved, so it may not be running)`;
  if (report.expectedMs === null) return head;
  const basis = `median of ${plural(report.basis, `${report.outcome} run`)}`;
  const remainingMs = report.expectedMs - elapsedMs;
  return remainingMs > 0
    ? `${head} -- ${remainingText(remainingMs)} (${basis})`
    : `${head} (usually ~${formatElapsed(report.expectedMs)}, ${basis})`;
}
