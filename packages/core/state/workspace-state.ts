import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonObject } from './json-file.ts';
import { workspaceLogsDir, workspaceStateFile } from './paths.ts';

export interface WorkspaceState {
  supervisor?: Record<string, unknown>;
  collectors?: Record<string, unknown>;
  lastBuild?: Record<string, unknown>;
  launches?: Record<string, unknown>;
  remoteDevice?: Record<string, unknown>;
  metroTunnel?: Record<string, unknown>;
  [key: string]: unknown;
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
