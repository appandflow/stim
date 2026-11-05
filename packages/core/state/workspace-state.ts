import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, readJsonObject } from './json-file.ts';
import { agentSessionOf } from './status-measures.ts';
import { workspaceLogsDir, workspaceMetadataFile, workspaceStateFile } from './paths.ts';
import {
  BUILD_PHASES,
  BUILD_RESULTS,
  type AgentSession,
  type BuildDiagnostic,
  type DevicePlacement,
  type BuildHistoryEntry,
  type BuildMissChange,
  type BuildMissReason,
  type BuildPhase,
  type BuildResult,
  type LastBuildReport,
  type BuildPlatform,
  type StatsPlatform,
  type WarmStep,
} from './status.ts';

export interface WorkspaceState {
  supervisor?: Record<string, unknown>;
  collectors?: Record<string, unknown>;
  lastBuild?: Record<string, unknown>;
  launches?: Record<string, unknown>;
  remoteDevice?: Record<string, unknown>;
  metroTunnel?: Record<string, unknown>;
  [key: string]: unknown;
}

export const IDLE_STOP_KEY = 'devServerStop';

/** Why the dev server last stopped for being idle: `idle.minutes` with no activity. `stim revive` resumes it. */
export interface IdleStopRecord {
  reason: 'idle';
  at: string;
  idleMinutes: number;
}

export function readIdleStop(state: WorkspaceState | null | undefined): IdleStopRecord | null {
  const record = state?.[IDLE_STOP_KEY] as Partial<IdleStopRecord> | undefined;
  if (record?.reason !== 'idle' || typeof record.at !== 'string' || typeof record.idleMinutes !== 'number') {
    return null;
  }
  return { reason: 'idle', at: record.at, idleMinutes: record.idleMinutes };
}

export const IDLE_STAGE_KEY = 'idleStage';

/** The idle stage the daemon last moved the workspace into, and the bytes of build outputs it deleted. */
export interface IdleStageRecord {
  at: string;
  idleMinutes: number;
  freedBytes: number;
}

export function readIdleStage(state: WorkspaceState | null | undefined): IdleStageRecord | null {
  const record = state?.[IDLE_STAGE_KEY];
  if (!isJsonObject(record) || typeof record.at !== 'string' || typeof record.idleMinutes !== 'number') return null;
  return {
    at: record.at,
    idleMinutes: record.idleMinutes,
    freedBytes: typeof record.freedBytes === 'number' ? record.freedBytes : 0,
  };
}

export const DORMANT_STAGE_KEY = 'dormantStage';

/** The dormant stage the daemon last moved the workspace into: the owned devices it deleted, and its archived logs. */
export interface DormantStageRecord {
  at: string;
  dormantDays: number;
  deletedDevices: string[];
  archived: boolean;
}

export function readDormantStage(state: WorkspaceState | null | undefined): DormantStageRecord | null {
  const record = state?.[DORMANT_STAGE_KEY];
  if (!isJsonObject(record) || typeof record.at !== 'string' || typeof record.dormantDays !== 'number') return null;
  return {
    at: record.at,
    dormantDays: record.dormantDays,
    deletedDevices: Array.isArray(record.deletedDevices)
      ? record.deletedDevices.filter((entry): entry is string => typeof entry === 'string')
      : [],
    archived: record.archived === true,
  };
}

/** A stage record the daemon wrote, while no Stim command has run in the workspace since; null otherwise. */
export function currentStage<T extends { at: string }>(
  state: WorkspaceState | null | undefined,
  stage: T | null,
): T | null {
  return stage && !(Date.parse(String(state?.lastUsedAt ?? '')) > Date.parse(stage.at)) ? stage : null;
}

export const INTERACTIONS_KEY = 'interactions';

/** When a person last used each device slot's focused Simulator or emulator window, by device slot key. */
export function readInteractions(state: WorkspaceState | null | undefined): Record<string, string> {
  const records = state?.[INTERACTIONS_KEY];
  if (!isJsonObject(records)) return {};
  return Object.fromEntries(
    Object.entries(records).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

export const DEVICE_RECLAIM_REASON = 'reclaimed for a waiting run';
export const DEVICE_METRO_IDLE_STOP_REASON = "Metro's idle stop";
export const DEVICE_IDLE_SHUTDOWN_KEY = 'deviceIdleShutdowns';

/** An owned simulator or emulator shut down after being idle. */
export interface DeviceIdleShutdownRecord {
  at: string;
  idleMinutes: number;
  reason?: string;
}

/** The recorded idle shutdowns by device slot key (`ios`, `android`, `ios:<slot>`). */
export function readDeviceIdleShutdowns(
  state: WorkspaceState | null | undefined,
): Record<string, DeviceIdleShutdownRecord> {
  const records = state?.[DEVICE_IDLE_SHUTDOWN_KEY];
  if (!records || typeof records !== 'object' || Array.isArray(records)) return {};
  const found: Record<string, DeviceIdleShutdownRecord> = {};
  for (const [key, value] of Object.entries(records as Record<string, unknown>)) {
    const record = value as Partial<DeviceIdleShutdownRecord> | null;
    if (typeof record?.at === 'string' && typeof record.idleMinutes === 'number') {
      found[key] = {
        at: record.at,
        idleMinutes: record.idleMinutes,
        ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      };
    }
  }
  return found;
}

export const DEFERRED_SHUTDOWN_KEY = 'deferredDeviceShutdowns';

/** An owned simulator that `stop` left booted: the stim-daemon shuts it down once `until` passes. */
export interface DeferredShutdownRecord {
  udid: string;
  until: string;
}

/** The simulators `stop` left booted, by device slot key (`ios`, `ios:<slot>`). */
export function readDeferredShutdowns(
  state: WorkspaceState | null | undefined,
): Record<string, DeferredShutdownRecord> {
  const records = state?.[DEFERRED_SHUTDOWN_KEY];
  if (!isJsonObject(records)) return {};
  const found: Record<string, DeferredShutdownRecord> = {};
  for (const [key, value] of Object.entries(records)) {
    if (isJsonObject(value) && typeof value.udid === 'string' && Number.isFinite(Date.parse(String(value.until)))) {
      found[key] = { udid: value.udid, until: String(value.until) };
    }
  }
  return found;
}

export const DEV_SERVER_STOP_REQUEST_KEY = 'devServerStopRequest';

/**
 * A Stim component's intent to stop the supervisor with `processToken`, written before it signals. `idleMinutes`
 * marks the daemon's idle stop, which the supervisor records as an `IdleStopRecord`.
 */
export interface DevServerStopRequest {
  processToken: string;
  by: string;
  pid: number;
  at: string;
  workspace?: string;
  idleMinutes?: number;
}

export function readDevServerStopRequest(state: WorkspaceState | null | undefined): DevServerStopRequest | null {
  const record = state?.[DEV_SERVER_STOP_REQUEST_KEY] as Partial<DevServerStopRequest> | undefined;
  if (
    typeof record?.processToken !== 'string' ||
    typeof record.by !== 'string' ||
    typeof record.pid !== 'number' ||
    typeof record.at !== 'string'
  ) {
    return null;
  }
  return {
    processToken: record.processToken,
    by: record.by,
    pid: record.pid,
    at: record.at,
    ...(typeof record.workspace === 'string' ? { workspace: record.workspace } : {}),
    ...(typeof record.idleMinutes === 'number' ? { idleMinutes: record.idleMinutes } : {}),
  };
}

/**
 * Why the dev server last stopped, stored under `IDLE_STOP_KEY`. `requested` names the Stim component that
 * asked; `signal` is a SIGTERM or SIGINT no Stim component asked for; `server-exited` is the dev server
 * process exiting on its own.
 */
export type DevServerStopRecord =
  | IdleStopRecord
  | { reason: 'requested'; at: string; by: string; byPid: number; byWorkspace?: string }
  | { reason: 'signal'; at: string; signal: string }
  | { reason: 'server-exited'; at: string; mode: string; code: number | null; signal: string | null };

/** A stopped dev server's last cause in status; `vanished` is a supervisor proven gone that recorded none. */
export type MetroLastStop = DevServerStopRecord | { reason: 'vanished'; pid: number; startedAt: string | null };

export function readDevServerStop(state: WorkspaceState | null | undefined): DevServerStopRecord | null {
  const idle = readIdleStop(state);
  if (idle) return idle;
  const record = state?.[IDLE_STOP_KEY] as Record<string, unknown> | undefined;
  if (typeof record?.at !== 'string') return null;
  const at = record.at;
  if (record.reason === 'requested' && typeof record.by === 'string' && typeof record.byPid === 'number') {
    return {
      reason: 'requested',
      at,
      by: record.by,
      byPid: record.byPid,
      ...(typeof record.byWorkspace === 'string' ? { byWorkspace: record.byWorkspace } : {}),
    };
  }
  if (record.reason === 'signal' && typeof record.signal === 'string') {
    return { reason: 'signal', at, signal: record.signal };
  }
  if (record.reason === 'server-exited') {
    return {
      reason: 'server-exited',
      at,
      mode: typeof record.mode === 'string' ? record.mode : 'dev',
      code: typeof record.code === 'number' ? record.code : null,
      signal: typeof record.signal === 'string' ? record.signal : null,
    };
  }
  return null;
}

/** Each platform's latest run; `lastBuild` holds whichever platform ran last. */
export const LAST_BUILD_KEYS: Readonly<Record<StatsPlatform, string>> = {
  ios: 'lastIosBuild',
  android: 'lastAndroidBuild',
};

export const BUILD_HISTORY_KEY = 'buildHistory';

export const BUILD_HISTORY_LIMIT = 10;

const MISS_KINDS: ReadonlySet<string> = new Set([
  'changed',
  'no-baseline',
  'same-sources',
  'cache-skipped',
  'fingerprint-error',
]);
const MISS_CATEGORIES: ReadonlySet<string> = new Set([
  'native-dependency',
  'config-plugin',
  'app-config',
  'app-asset',
  'package',
  'native-dir',
  'autolinking',
  'package-scripts',
  'file',
  'other',
]);
const MISS_CHANGE_CAP = 20;

function missChange(value: unknown): BuildMissChange | null {
  if (!value || typeof value !== 'object') return null;
  const { source, change, category } = value as Record<string, unknown>;
  if (typeof source !== 'string' || (change !== 'added' && change !== 'removed' && change !== 'changed')) return null;
  return {
    source,
    change,
    category:
      typeof category === 'string' && MISS_CATEGORIES.has(category)
        ? (category as BuildMissChange['category'])
        : 'other',
  };
}

/** A recorded miss reason in the shape status reports, without `baseline.cacheKey`; null when malformed. */
export function parseMissReason(value: unknown): BuildMissReason | null {
  if (!isJsonObject(value)) return null;
  const record = value;
  if (typeof record.kind !== 'string' || !MISS_KINDS.has(record.kind) || typeof record.summary !== 'string')
    return null;
  const changes = (Array.isArray(record.changes) ? record.changes : [])
    .map(missChange)
    .filter((change): change is BuildMissChange => change !== null)
    .slice(0, MISS_CHANGE_CAP);
  const baseline = record.baseline as Record<string, unknown> | null | undefined;
  return {
    kind: record.kind as BuildMissReason['kind'],
    summary: record.summary,
    changes,
    changeCount:
      typeof record.changeCount === 'number' &&
      Number.isInteger(record.changeCount) &&
      record.changeCount >= changes.length
        ? record.changeCount
        : changes.length,
    baseline:
      baseline &&
      typeof baseline.fingerprint === 'string' &&
      (baseline.from === 'workspace' || baseline.from === 'project')
        ? { fingerprint: baseline.fingerprint, from: baseline.from }
        : null,
    rekeyedBy: Array.isArray(record.rekeyedBy)
      ? record.rekeyedBy.filter((step): step is string => typeof step === 'string')
      : [],
  };
}

const DIAGNOSTIC_CAP = 5;

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

/**
 * The first diagnostics of a failed build in the shape a last-build record stores and `status` reports, the
 * ones with a source position first.
 */
export function buildDiagnostics(value: unknown): BuildDiagnostic[] {
  return (Array.isArray(value) ? value : [])
    .flatMap((item): BuildDiagnostic[] => {
      if (!item || typeof item !== 'object') return [];
      const { file, line, column, message } = item as Record<string, unknown>;
      if (typeof message !== 'string' || message === '') return [];
      return [
        {
          file: typeof file === 'string' && file ? file : null,
          line: positive(line),
          column: positive(column),
          message,
        },
      ];
    })
    .toSorted((a, b) => Number(b.file !== null) - Number(a.file !== null))
    .slice(0, DIAGNOSTIC_CAP);
}

function devicePlacement(value: unknown): DevicePlacement | null {
  if (!isJsonObject(value)) return null;
  const record = value;
  if (
    (record.decision !== 'local' &&
      record.decision !== 'hosted' &&
      record.decision !== 'waited-locally' &&
      record.decision !== 'eas') ||
    typeof record.reason !== 'string'
  )
    return null;
  return {
    decision: record.decision,
    reason: record.reason,
    ...(typeof record.machine === 'string' ? { machine: record.machine } : {}),
  };
}

export function readDevicePlacement(
  state: WorkspaceState | null,
  platform: StatsPlatform,
  slot = 'default',
): DevicePlacement | null {
  const slots = isJsonObject(state?.deviceSlots) ? state.deviceSlots : {};
  const saved = isJsonObject(slots[slot]) ? slots[slot] : {};
  const device = slot === 'default' ? state?.[platform] : saved[platform];
  return devicePlacement(isJsonObject(device) ? device.devicePlacement : undefined);
}

function lastBuildReport(platform: BuildPlatform, value: unknown): LastBuildReport | null {
  if (!isJsonObject(value)) return null;
  const record = value;
  if (record.platform !== platform) return null;
  const status = record.status === 'success' ? 'ok' : record.status;
  if (status !== 'ok' && status !== 'failed') return null;
  if (typeof record.startedAt !== 'string') return null;
  const durationMs = typeof record.durationMs === 'number' && record.durationMs >= 0 ? record.durationMs : null;
  const finished = new Date(Date.parse(record.startedAt) + (durationMs ?? Number.NaN));
  const reason =
    record.cacheHit === 'local' || record.cacheHit === 'remote' ? null : parseMissReason(record.missReason);
  const diagnostics = status === 'failed' ? buildDiagnostics(record.diagnostics) : [];
  const placed = devicePlacement(record.devicePlacement);
  return {
    platform,
    status,
    cacheHit: record.cacheHit === 'local' || record.cacheHit === 'remote' ? record.cacheHit : false,
    cacheSkipped: record.cacheSkipped === true,
    durationMs,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : null,
    startedAt: record.startedAt,
    finishedAt: Number.isNaN(finished.getTime()) ? null : finished.toISOString(),
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(reason ? { missReason: reason } : {}),
    ...(placed ? { devicePlacement: placed } : {}),
    ...(typeof record.buildMachine === 'string' ? { buildMachine: record.buildMachine } : {}),
    ...(typeof record.builtOn === 'string' ? { builtOn: record.builtOn } : {}),
    ...(typeof record.offloadedTo === 'string' ? { offloadedTo: record.offloadedTo } : {}),
    ...(typeof record.offloadFallback === 'string' ? { offloadFallback: record.offloadFallback } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

export function readLastBuilds(
  state: WorkspaceState | null | undefined,
): Partial<Record<StatsPlatform, LastBuildReport>> {
  const reports: Partial<Record<StatsPlatform, LastBuildReport>> = {};
  for (const platform of ['ios', 'android'] as const) {
    const [report] = [
      lastBuildReport(platform, state?.[LAST_BUILD_KEYS[platform]]),
      lastBuildReport(platform, state?.lastBuild),
    ]
      .filter((candidate): candidate is LastBuildReport => candidate !== null)
      .toSorted((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
    if (report) reports[platform] = report;
  }
  return reports;
}

function historyPhases(value: unknown): Partial<Record<BuildPhase, number>> {
  const phases: Partial<Record<BuildPhase, number>> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return phases;
  for (const phase of BUILD_PHASES) {
    const ms = (value as Record<string, unknown>)[phase];
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) phases[phase] = Math.round(ms);
  }
  return phases;
}

function historyEntry(platform: BuildPlatform, value: unknown): BuildHistoryEntry | null {
  const report = lastBuildReport(platform, value);
  if (!report) return null;
  const record = value as Record<string, unknown>;
  const result =
    record.status === 'success'
      ? 'succeeded'
      : (BUILD_RESULTS as readonly unknown[]).includes(record.result)
        ? (record.result as BuildResult)
        : report.status === 'ok'
          ? 'succeeded'
          : 'failed';
  return {
    ...report,
    result,
    slot: typeof record.slot === 'string' && record.slot ? record.slot : 'default',
    configuration: typeof record.configuration === 'string' ? record.configuration : null,
    cacheKey: typeof record.cacheKey === 'string' ? record.cacheKey : null,
    phases: historyPhases(record.phases),
    ...(typeof record.compileSteps === 'number' && Number.isInteger(record.compileSteps) && record.compileSteps >= 0
      ? { compileSteps: record.compileSteps }
      : {}),
  };
}

/** Each platform's recorded runs, newest first, at most `BUILD_HISTORY_LIMIT` each. */
export function readBuildHistory(
  state: WorkspaceState | null | undefined,
): Partial<Record<BuildPlatform, BuildHistoryEntry[]>> {
  const history = state?.[BUILD_HISTORY_KEY] as Record<string, unknown> | undefined;
  const builds: Partial<Record<BuildPlatform, BuildHistoryEntry[]>> = {};
  for (const platform of ['ios', 'android', 'macos'] as const) {
    const list = history?.[platform];
    if (!Array.isArray(list)) continue;
    const entries = list
      .slice(0, BUILD_HISTORY_LIMIT)
      .map((value) => historyEntry(platform, value))
      .filter((entry): entry is BuildHistoryEntry => entry !== null);
    if (entries.length) builds[platform] = entries;
  }
  return builds;
}

export function readWorkspaceState(root: string): WorkspaceState | null {
  return readJsonObject(workspaceStateFile(root));
}

export function lastUseFrom(state: WorkspaceState | null, logMtimes: readonly number[]): number {
  const candidates = [
    Date.parse(String(state?.lastUsedAt ?? '')),
    Date.parse(String(state?.lastBuild?.startedAt ?? '')),
    Date.parse(String(state?.supervisor?.startedAt ?? '')),
    ...logMtimes,
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : NaN;
}

/**
 * When an ios, android or macos run last finished in the workspace, from its recorded builds (a cache hit counts),
 * in epoch milliseconds; NaN when it records none. Dev server starts, reloads and logs do not count.
 */
export function lastNativeUseFrom(state: WorkspaceState | null): number {
  const runs = [
    ...Object.values(readLastBuilds(state)),
    ...Object.values(readBuildHistory(state)).flatMap((entries) => entries.slice(0, 1)),
  ];
  const times = runs.map((run) => Date.parse(run.finishedAt ?? run.startedAt)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

export const MAINTENANCE_LOG_NAME = 'maintenance.ndjson';

/**
 * When the workspace was last used, in epoch milliseconds. A workspace that recorded no use falls back to the mtime
 * of its workspace.json, which is written once when the workspace is created, so it is a lower bound on the last
 * use. NaN when its state.json exists but does not parse, or when workspace.json cannot be read either.
 */
export function workspaceLastUsed(root: string): number {
  const used = recordedLastUse(root);
  if (Number.isFinite(used)) return used;
  if (existsSync(workspaceStateFile(root)) && readWorkspaceState(root) === null) return NaN;
  try {
    return statSync(workspaceMetadataFile(root)).mtimeMs;
  } catch {
    return NaN;
  }
}

function recordedLastUse(root: string): number {
  const logs = workspaceLogsDir(root);
  let mtimes: number[] = [];
  try {
    mtimes = readdirSync(logs).flatMap((name) => {
      if (name.startsWith(MAINTENANCE_LOG_NAME)) return [];
      try {
        return [statSync(join(logs, name)).mtimeMs];
      } catch {
        return [];
      }
    });
  } catch {}
  return lastUseFrom(readWorkspaceState(root), mtimes);
}

export const WARM_KEY = 'warm';

/** How long a successful warm keeps a workspace `ready` when nothing runs in it. */
export const READY_PHASE_MS: number = 2 * 60 * 60 * 1000;

/**
 * What `stim worktree warm` last recorded in a workspace: a warm in progress, held by the ownership claim
 * `claim` names, or a successful warm that finished at `at`.
 */
export type WarmRecord =
  | { phase: 'warming'; step: WarmStep; startedAt: string; claim: { root: string; claimId: string } }
  | { phase: 'ready'; at: string };

export function readWarmRecord(state: WorkspaceState | null | undefined): WarmRecord | null {
  const record = state?.[WARM_KEY] as Record<string, unknown> | undefined;
  if (!record || typeof record !== 'object') return null;
  if (record.phase === 'ready') return typeof record.at === 'string' ? { phase: 'ready', at: record.at } : null;
  const claim = record.claim as Record<string, unknown> | undefined;
  if (
    record.phase !== 'warming' ||
    (record.step !== 'refresh' && record.step !== 'copy') ||
    typeof record.startedAt !== 'string' ||
    typeof claim?.root !== 'string' ||
    typeof claim.claimId !== 'string'
  ) {
    return null;
  }
  return {
    phase: 'warming',
    step: record.step,
    startedAt: record.startedAt,
    claim: { root: claim.root, claimId: claim.claimId },
  };
}

export const WORKSPACE_AGENT_KEY = 'agentSession';

/**
 * The coding-agent session whose shell ran the Stim command that last recorded `lastUsedAt`, with that command's
 * working directory as `cwd` and its time as `lastActiveAt`.
 */
export function readWorkspaceAgent(state: WorkspaceState | null | undefined): AgentSession | null {
  const session = agentSessionOf(state?.[WORKSPACE_AGENT_KEY]);
  return session?.lastActiveAt ? session : null;
}
