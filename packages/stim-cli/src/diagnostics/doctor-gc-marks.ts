import { isJsonObject, daemonNdjsonFile, type DaemonStatus, type GcMarkHealth } from '@stim-cli/core/state';
import type { Finding } from './doctor.ts';

function health(value: unknown): GcMarkHealth | null {
  if (
    !isJsonObject(value) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(new Date(value.at).getTime()) ||
    (value.state !== 'ready' && value.state !== 'partial' && value.state !== 'unavailable') ||
    !Array.isArray(value.stale) ||
    value.stale.length > 5
  )
    return null;
  if (
    value.state === 'ready' &&
    (!Number.isSafeInteger(value.checkedRoots) ||
      Number(value.checkedRoots) < 0 ||
      !Number.isSafeInteger(value.staleCount) ||
      Number(value.staleCount) < value.stale.length ||
      Number(value.staleCount) > Number(value.checkedRoots))
  )
    return null;
  const stale: GcMarkHealth['stale'] = [];
  for (const entry of value.stale) {
    if (
      !isJsonObject(entry) ||
      typeof entry.root !== 'string' ||
      typeof entry.markedAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.markedAt)) ||
      typeof entry.intervalMs !== 'number' ||
      !Number.isFinite(entry.intervalMs) ||
      entry.intervalMs <= 0 ||
      value.at <= Date.parse(entry.markedAt) + 2 * entry.intervalMs
    )
      return null;
    stale.push({ root: entry.root, markedAt: entry.markedAt, intervalMs: entry.intervalMs });
  }
  return {
    at: value.at,
    state: value.state,
    stale,
    ...(value.state === 'ready'
      ? { checkedRoots: Number(value.checkedRoots), staleCount: Number(value.staleCount) }
      : {}),
  };
}

export function gcMarkHealthFindings(status: DaemonStatus, now: number): Finding[] {
  if (!status.running) return [];
  const observed = health(status.gcMarks);
  if (!observed) return [];
  const fix = `Read ${daemonNdjsonFile()} for failed mark generation, then run stim doctor again.`;
  if (observed.state === 'unavailable' || observed.at > now || now - observed.at > 3 * (status.intervalMs ?? 60_000))
    return [
      {
        code: 'gc-mark-health-unavailable',
        level: 'note',
        title: 'Cleanup mark freshness is unavailable',
        detail: `The daemon has no current complete mark observation (last observation ${new Date(observed.at).toISOString()}).`,
        fix,
      },
    ];
  const findings = observed.stale.map((entry): Finding => ({
    code: 'gc-mark-stale',
    level: 'note',
    title: `Cleanup mark is overdue: ${entry.root}`,
    detail: `Last generated ${entry.markedAt}; its refresh interval is ${entry.intervalMs / 60_000} minutes. This mark was more than twice that interval old when checked at ${new Date(observed.at).toISOString()}.`,
    fix,
  }));
  if (observed.state === 'partial')
    findings.push({
      code: 'gc-mark-health-incomplete',
      level: 'note',
      title: 'Cleanup mark freshness covers only part of the saved inventory',
      detail:
        'Some saved marks could not be read or authorized. Any specific overdue marks reported were checked in the current scope.',
      fix,
    });
  return findings;
}
