import type { BuildReport, DeviceActivity } from '@/protocol/types';

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** The `h`/`m` form apps/desktop uses on activity badges. */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function clockDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

export type ActivityBadge = { kind: 'driven' | 'idle' | 'unknown'; text: string };

/** Matches apps/desktop ActivityBadge: nothing for a device used in the last 10 minutes. */
export function activityBadge(activity: DeviceActivity | undefined, now: number): ActivityBadge | null {
  if (!activity) return null;
  switch (activity.state) {
    case 'driven': {
      const tool = activity.driver?.tool ?? 'an unknown tool';
      const since = activity.driver?.since ? Date.parse(activity.driver.since) : NaN;
      const text = Number.isFinite(since)
        ? `Driven by ${tool} \u00B7 ${shortDuration(Math.max(0, now - since))}`
        : `Driven by ${tool}`;
      return { kind: 'driven', text };
    }
    case 'idle': {
      const last = activity.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN;
      if (Number.isFinite(last) && now - last < ACTIVE_WINDOW_MS) return null;
      return { kind: 'idle', text: Number.isFinite(last) ? `Idle ${shortDuration(Math.max(0, now - last))}` : 'Idle' };
    }
    case 'unknown':
      return { kind: 'unknown', text: 'Activity unknown' };
    default:
      return null;
  }
}

export interface BuildProgress {
  elapsedMs: number;
  /** Elapsed over the median of comparable runs, capped below 1; null without history. */
  fraction: number | null;
  remaining: string | null;
}

export function buildProgress(build: BuildReport, now: number): BuildProgress {
  const started = Date.parse(build.startedAt);
  const elapsedMs = Math.max(0, now - (Number.isFinite(started) ? started : now));
  const expected = build.expectedMs;
  if (!expected || expected <= 0) return { elapsedMs, fraction: null, remaining: null };
  const remainingMs = expected - elapsedMs;
  const remaining =
    remainingMs <= 0
      ? 'longer than usual'
      : remainingMs < 60_000
        ? 'under a minute left'
        : `about ${Math.ceil(remainingMs / 60_000)} min left`;
  return { elapsedMs, fraction: Math.min(elapsedMs / expected, 0.99), remaining };
}
