import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonObject } from './json-file.ts';
import { workspaceLogsDir, workspaceStateFile } from './paths.ts';
import type { BuildDiagnostic, BuildMissChange, BuildMissReason, LastBuildReport, StatsPlatform } from './status.ts';

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

/** Why the supervisor last stopped the dev server on its own: `metro.idleStopMinutes` with no use. */
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

/** Each platform's latest run; `lastBuild` holds whichever platform ran last. */
export const LAST_BUILD_KEYS: Readonly<Record<StatsPlatform, string>> = {
  ios: 'lastIosBuild',
  android: 'lastAndroidBuild',
};

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

function missReason(value: unknown): BuildMissReason | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
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
      Number.isInteger(record.changeCount) && (record.changeCount as number) >= changes.length
        ? (record.changeCount as number)
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

function lastBuildReport(platform: StatsPlatform, value: unknown): LastBuildReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.platform !== platform || (record.status !== 'ok' && record.status !== 'failed')) return null;
  if (typeof record.startedAt !== 'string') return null;
  const durationMs = typeof record.durationMs === 'number' && record.durationMs >= 0 ? record.durationMs : null;
  const finished = new Date(Date.parse(record.startedAt) + (durationMs ?? Number.NaN));
  const reason = record.cacheHit === 'local' || record.cacheHit === 'remote' ? null : missReason(record.missReason);
  const diagnostics = record.status === 'failed' ? buildDiagnostics(record.diagnostics) : [];
  return {
    platform,
    status: record.status,
    cacheHit: record.cacheHit === 'local' || record.cacheHit === 'remote' ? record.cacheHit : false,
    cacheSkipped: record.cacheSkipped === true,
    durationMs,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : null,
    startedAt: record.startedAt,
    finishedAt: Number.isNaN(finished.getTime()) ? null : finished.toISOString(),
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(reason ? { missReason: reason } : {}),
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

export function workspaceLastUsed(root: string): number {
  const logs = workspaceLogsDir(root);
  let mtimes: number[] = [];
  try {
    mtimes = readdirSync(logs).flatMap((name) => {
      try {
        return [statSync(join(logs, name)).mtimeMs];
      } catch {
        return [];
      }
    });
  } catch {}
  return lastUseFrom(readWorkspaceState(root), mtimes);
}
