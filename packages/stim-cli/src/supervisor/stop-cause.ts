import {
  DEV_SERVER_STOP_REQUEST_KEY,
  readDevServerStopRequest,
  type DevServerStopRecord,
  type DevServerStopRequest,
  type MetroLastStop,
  type WorkspaceState,
  readDevServerStop,
} from '@stim-cli/core/state';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { createNdjsonWriter } from '../ndjson.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { clearWorkspaceStateKey, writeWorkspaceState } from '../workspace/workspace-state.ts';

export interface StopRequester {
  by: string;
  workspace?: string;
}

export function requestDevServerStop(root: string, processToken: string | undefined, requester: StopRequester): void {
  if (!processToken) return;
  try {
    writeWorkspaceState(root, {
      [DEV_SERVER_STOP_REQUEST_KEY]: {
        processToken,
        by: requester.by,
        pid: process.pid,
        at: new Date().toISOString(),
        ...(requester.workspace ? { workspace: requester.workspace } : {}),
      } satisfies DevServerStopRequest,
    });
  } catch {}
}

export function withdrawDevServerStopRequest(root: string, processToken: string | undefined): void {
  if (!processToken) return;
  try {
    clearWorkspaceStateKey(root, DEV_SERVER_STOP_REQUEST_KEY, (value) => {
      return readDevServerStopRequest({ [DEV_SERVER_STOP_REQUEST_KEY]: value })?.processToken === processToken;
    });
  } catch {}
}

export type SupervisorExitTrigger =
  | { kind: 'signal'; signal: string }
  | { kind: 'server-exit'; mode: string; code: number | null; signal: string | null };

export function devServerStopRecord(
  trigger: SupervisorExitTrigger,
  request: DevServerStopRequest | null,
  at: string,
): DevServerStopRecord {
  if (request) {
    return {
      reason: 'requested',
      at,
      by: request.by,
      byPid: request.pid,
      ...(request.workspace ? { byWorkspace: request.workspace } : {}),
    };
  }
  return trigger.kind === 'signal'
    ? { reason: 'signal', at, signal: trigger.signal }
    : { reason: 'server-exited', at, mode: trigger.mode, code: trigger.code, signal: trigger.signal };
}

export function describeDevServerStop(record: DevServerStopRecord): string {
  if (record.reason === 'idle') return `stopped after ${record.idleMinutes} idle minutes (metro.idleStopMinutes)`;
  if (record.reason === 'requested') {
    return `stopped by ${record.by} (pid ${record.byPid}${record.byWorkspace ? ` in ${record.byWorkspace}` : ''})`;
  }
  if (record.reason === 'signal')
    return `received ${record.signal} from outside Stim: no Stim command asked for this stop`;
  const detail = record.signal ? `signal ${record.signal}` : `exit code ${record.code ?? 'unknown'}`;
  const expoSignal =
    record.mode === 'expo-child' && record.code === 0
      ? '; Expo CLI also exits 0 on SIGTERM, and no Stim command asked for this stop'
      : '';
  return `the ${record.mode} dev server exited unexpectedly (${detail})${expoSignal}`;
}

export function devServerStopLevel(record: DevServerStopRecord): 'info' | 'warn' | 'error' {
  if (record.reason === 'server-exited') return 'error';
  return record.reason === 'signal' ? 'warn' : 'info';
}

/** The log line for a recorded supervisor whose process is proven gone, or null while it may still run. */
export function vanishedSupervisorMessage(
  record: { pid?: unknown; processToken?: unknown; startedAt?: unknown } | null | undefined,
  inspect: typeof inspectProcessIdentity = inspectProcessIdentity,
): string | null {
  if (!record || typeof record.pid !== 'number') return null;
  const identity = inspect(record);
  if (identity !== 'gone' && identity !== 'different') return null;
  const started = typeof record.startedAt === 'string' ? ` (started ${record.startedAt})` : '';
  return `supervisor pid ${record.pid}${started} exited without recording a cause: it was killed with SIGKILL, crashed, or the machine restarted`;
}

export function logVanishedSupervisor(
  root: string,
  record: { pid?: unknown; processToken?: unknown; startedAt?: unknown } | null | undefined,
): void {
  const msg = vanishedSupervisorMessage(record);
  if (!msg) return;
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  writer.write({ src: 'metro', level: 'warn', event: 'supervisor_vanished', msg });
  writer.close();
}

/** The recorded stop, else a vanished supervisor when status proved the recorded one gone. */
export function metroLastStop(
  state: WorkspaceState | null | undefined,
  supervisor: { status: string; pid?: number | null; startedAt?: unknown } | null,
): MetroLastStop | null {
  const recorded = readDevServerStop(state);
  if (recorded) return recorded;
  if (supervisor?.status !== 'stale' || typeof supervisor.pid !== 'number') return null;
  const startedAt = typeof supervisor.startedAt === 'string' ? supervisor.startedAt : null;
  return { reason: 'vanished', pid: supervisor.pid, startedAt };
}

export function describeMetroLastStop(stop: MetroLastStop): string {
  return stop.reason === 'vanished'
    ? `supervisor pid ${stop.pid} exited without recording a cause: it was killed with SIGKILL, crashed, or the machine restarted`
    : describeDevServerStop(stop);
}
