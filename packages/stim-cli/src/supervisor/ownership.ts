import { isPidAlive } from '../metro.ts';
import { inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';

export interface SupervisorStateRecord extends ProcessRecord {
  pid?: number;
  port?: number;
  mode?: string | null;
  startedAt?: string | null;
  [key: string]: unknown;
}

export interface SupervisorTarget {
  processToken?: string;
  status: string;
  pid?: number;
  reason?: string;
  port?: number | null;
  mode?: string | null;
  startedAt?: string | null;
}

export function resolveSupervisorTarget({
  state,
  record,
  reservedPort,
  isAlive = isPidAlive,
  inspectIdentity = inspectProcessIdentity,
}: {
  state?: SupervisorStateRecord | null;
  record?: SupervisorStateRecord | null;
  reservedPort?: number | null;
  isAlive?: (pid: number) => boolean;
  inspectIdentity?: typeof inspectProcessIdentity;
} = {}): SupervisorTarget {
  const statePid = numberOrNull(state?.pid);
  const recordPid = numberOrNull(record?.pid);
  const pid = statePid ?? recordPid;
  if (!pid) return { status: 'none' };

  if (statePid && recordPid && statePid !== recordPid) {
    return {
      status: 'unverified',
      pid,
      reason: `workspace state.json records supervisor pid ${statePid} but the registry records pid ${recordPid}`,
    };
  }

  if (!isAlive(pid)) return { status: 'stale', pid };
  const port = numberOrNull(state?.port) ?? numberOrNull(record?.port);
  if (reservedPort !== null && reservedPort !== undefined && port !== null && port !== reservedPort) {
    return {
      status: 'unverified',
      pid,
      reason: `supervisor pid ${pid} records port ${port}, but this project reserved port ${reservedPort}`,
    };
  }
  if (reservedPort !== null && reservedPort !== undefined && port === null) {
    return {
      status: 'unverified',
      pid,
      reason: `supervisor pid ${pid} has no recorded port, so it cannot be matched against reserved port ${reservedPort}`,
    };
  }

  const identityRecord = statePid ? state : record;
  if (statePid && recordPid && state?.processToken !== record?.processToken) {
    return { status: 'unverified', pid, reason: 'workspace state and registry process identities disagree' };
  }
  const identity = inspectIdentity(identityRecord);
  if (identity === 'gone' || identity === 'different') return { status: 'stale', pid };
  if (identity !== 'same')
    return { status: 'unverified', pid, reason: 'the recorded process identity could not be verified' };
  return {
    status: 'ours',
    processToken: identityRecord!.processToken as string,
    pid,
    port,
    mode: state?.mode ?? record?.mode ?? null,
    startedAt: state?.startedAt ?? record?.startedAt ?? null,
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}
