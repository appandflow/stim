import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonObject } from './json-file.ts';
import { workspaceLogsDir, workspaceStateFile } from './paths.ts';
import type { LastBuildReport, StatsPlatform } from './status.ts';

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

function lastBuildReport(platform: StatsPlatform, value: unknown): LastBuildReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.platform !== platform || (record.status !== 'ok' && record.status !== 'failed')) return null;
  if (typeof record.startedAt !== 'string') return null;
  const durationMs = typeof record.durationMs === 'number' && record.durationMs >= 0 ? record.durationMs : null;
  const started = Date.parse(record.startedAt);
  return {
    platform,
    status: record.status,
    cacheHit: record.cacheHit === 'local' || record.cacheHit === 'remote' ? record.cacheHit : false,
    cacheSkipped: record.cacheSkipped === true,
    durationMs,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : null,
    startedAt: record.startedAt,
    finishedAt: durationMs !== null && Number.isFinite(started) ? new Date(started + durationMs).toISOString() : null,
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
  };
}

export function readLastBuilds(
  state: WorkspaceState | null | undefined,
): Partial<Record<StatsPlatform, LastBuildReport>> {
  const reports: Partial<Record<StatsPlatform, LastBuildReport>> = {};
  for (const platform of ['ios', 'android'] as const) {
    const report =
      lastBuildReport(platform, state?.[LAST_BUILD_KEYS[platform]]) ?? lastBuildReport(platform, state?.lastBuild);
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
