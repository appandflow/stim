import type { NdjsonRecord } from '../ndjson.ts';

export const APP_READINESS_TIMEOUT_MS = 30_000;
export type AppReadiness = 'ready' | 'timed-out' | 'error';

export function appReadinessSignal(
  record: NdjsonRecord,
  platform: 'ios' | 'android' | null,
): 'pending' | 'ready' | null {
  if (record.src !== 'device' || !platform || record.platform !== platform) return null;
  if (record.level !== 'info' && record.level !== 'debug') return null;
  if (typeof record.msg !== 'string') return null;
  const text = record.msg.trim();
  const message = /^(?:'[^']*'|"[^"]*")$/.test(text) ? text.slice(1, -1) : text;
  const match = /^\[stim:readiness\] (pending|ready)$/.exec(message);
  return (match?.[1] as 'pending' | 'ready' | undefined) ?? null;
}
