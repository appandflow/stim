import type { HostedDeviceSession } from '@stim-cli/core/state';

export const HOSTED_IDLE_SWEEP_MS = 60_000;

const MAX_ELAPSED_MS = 2 * HOSTED_IDLE_SWEEP_MS;

type IdleRecord = Pick<HostedDeviceSession, 'id' | 'client' | 'state' | 'parked' | 'clientAbsentMs'>;

export interface HostedIdlePlan {
  /** New `clientAbsentMs` per session whose stored value changes; null removes it. */
  updates: { id: string; absentMs: number | null }[];
  stops: { id: string; reason: string }[];
  kept: { id: string; reason: string }[];
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * Decides which ready hosted sessions to stop because their client has been gone for `windowMs`. A session's absence
 * is the sum of the sweeps in which this server ran and saw no connection or request from its client. A sweep adds at
 * most two sweep intervals, so time the server was down, or the machine asleep, is not counted, and a stored value
 * survives a restart. Only a ready session that is not parked is tracked, and none is while `windowMs` is 0, so
 * turning the setting back on starts every count from nothing. Anything else is never stopped here.
 * `unresolved` names why a due session cannot be stopped safely now, or returns null.
 */
export function planHostedIdleStops({
  sessions,
  connected,
  active,
  elapsedMs,
  windowMs,
  unresolved,
}: {
  sessions: readonly IdleRecord[];
  connected: (client: string) => boolean;
  active: ReadonlySet<string>;
  elapsedMs: number;
  windowMs: number;
  unresolved: (id: string) => string | null;
}): HostedIdlePlan {
  const plan: HostedIdlePlan = { updates: [], stops: [], kept: [] };
  const step = Math.min(Math.max(elapsedMs, 0), MAX_ELAPSED_MS);
  for (const session of sessions) {
    const stored = session.clientAbsentMs;
    const tracked = session.state === 'ready' && !session.parked;
    if (!tracked || !(windowMs > 0) || connected(session.client) || active.has(session.id)) {
      if (stored !== undefined) plan.updates.push({ id: session.id, absentMs: null });
      continue;
    }
    const absentMs = (stored ?? 0) + step;
    if (absentMs !== stored) plan.updates.push({ id: session.id, absentMs });
    if (absentMs < windowMs) continue;
    const why = unresolved(session.id);
    const reason = `its client had no connection for ${formatDuration(absentMs)}, over maintenance.idleStopHours`;
    if (why) plan.kept.push({ id: session.id, reason: `${why}; ${reason}` });
    else plan.stops.push({ id: session.id, reason });
  }
  return plan;
}
