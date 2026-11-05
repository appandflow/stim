import type { MetroBundleState, StatsPlatform } from '@stim-cli/core/state';

const IN_FLIGHT_MAX_MS = 10 * 60 * 1000;
const RESTART_EVENTS = new Set(['supervisor_started', 'server_started']);
const BUNDLE_EVENT = /^bundle_(?:response|prefetch)_(started|progress|finished|failed)$/;

interface Request {
  platform: StatsPlatform;
  startedAt: number;
  percent?: number;
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.includes('"bundle_') && !line.includes('_started"')) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function platformOf(value: unknown): StatsPlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

/**
 * The bundle state of a workspace's Metro from the tail of its `metro.ndjson`: the records Stim's middleware writes
 * for each native bundle request, an app's (`bundle_response_*`) or Stim's own prefetch (`bundle_prefetch_*`),
 * matched by `requestId`. A request counts as in flight only while
 * Metro runs, when it started under the current dev server and less than 10 minutes ago, since a dev server that
 * died mid-request never records its end. Null when the tail holds no bundle request.
 */
export function metroBundleState(
  lines: readonly string[],
  { running, now }: { running: boolean; now: number },
): MetroBundleState | null {
  let open = new Map<string, Request>();
  let last: MetroBundleState['last'];
  let seen = false;
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    const { event, requestId, ts } = record;
    if (typeof event !== 'string') continue;
    if (RESTART_EVENTS.has(event)) {
      open = new Map();
      continue;
    }
    const platform = platformOf(record.platform);
    const stage = BUNDLE_EVENT.exec(event)?.[1];
    if (!stage || typeof requestId !== 'string' || typeof ts !== 'number' || !platform) continue;
    seen = true;
    if (stage === 'started') {
      open.set(requestId, { platform, startedAt: ts });
    } else if (stage === 'progress') {
      const request = open.get(requestId);
      const percent = record.percent;
      if (request && typeof percent === 'number' && percent >= 0 && percent <= 100) request.percent = percent;
    } else {
      const request = open.get(requestId);
      open.delete(requestId);
      if (!request) continue;
      last = {
        platform,
        status: stage === 'finished' ? 'ok' : 'failed',
        durationMs: Math.max(0, ts - request.startedAt),
        finishedAt: new Date(ts).toISOString(),
      };
    }
  }
  if (!seen) return null;
  const active = running
    ? [...open.values()]
        .filter((request) => now - request.startedAt < IN_FLIGHT_MAX_MS)
        .toSorted((a, b) => b.startedAt - a.startedAt)[0]
    : undefined;
  return {
    bundling: Boolean(active),
    ...(active
      ? {
          platform: active.platform,
          startedAt: new Date(active.startedAt).toISOString(),
          ...(active.percent === undefined ? {} : { percent: active.percent }),
        }
      : {}),
    ...(last ? { last } : {}),
  };
}
