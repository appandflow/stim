import { readFileSync } from 'node:fs';
import { metroBundleState } from '../metro-bundle.ts';

const captured = readFileSync(new URL('./fixtures/metro-bundles.ndjson', import.meta.url), 'utf-8')
  .split('\n')
  .filter(Boolean);
const LAST_FINISH = 1790280380572;

function record(event: string, ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, src: 'metro', level: 'debug', event, platform: 'android', requestId: 'r1', ...extra });
}

test('reports the newest finished request of a captured Expo log, and nothing in flight', () => {
  expect(metroBundleState(captured, { running: true, now: LAST_FINISH + 1000 })).toEqual({
    bundling: false,
    last: { platform: 'ios', status: 'ok', durationMs: 470, finishedAt: '2026-09-24T20:06:20.572Z' },
  });
});

test('a request with no end is in flight only while Metro runs, for at most 10 minutes', () => {
  const lines = [...captured, record('bundle_response_started', LAST_FINISH + 5000)];
  expect(metroBundleState(lines, { running: true, now: LAST_FINISH + 6000 })).toMatchObject({
    bundling: true,
    platform: 'android',
    startedAt: new Date(LAST_FINISH + 5000).toISOString(),
    last: { platform: 'ios' },
  });
  expect(metroBundleState(lines, { running: false, now: LAST_FINISH + 6000 })?.bundling).toBe(false);
  expect(metroBundleState(lines, { running: true, now: LAST_FINISH + 5000 + 600_000 })?.bundling).toBe(false);
});

test('a dev server restart ends every request it had in flight', () => {
  const lines = [
    record('bundle_response_started', 1000),
    JSON.stringify({ src: 'metro', level: 'info', event: 'supervisor_started', msg: 'supervisor starting', ts: 2000 }),
    record('bundle_response_finished', 3000),
  ];
  expect(metroBundleState(lines, { running: true, now: 4000 })).toEqual({ bundling: false });
});

test("Stim's own prefetch counts as bundling, with the percent of its latest progress record", () => {
  const lines = [
    record('bundle_prefetch_started', 1000),
    record('bundle_prefetch_progress', 2000, { done: 500, total: 1000, percent: 50 }),
  ];
  expect(metroBundleState(lines, { running: true, now: 2500 })).toEqual({
    bundling: true,
    platform: 'android',
    startedAt: '1970-01-01T00:00:01.000Z',
    percent: 50,
  });
  lines.push(record('bundle_prefetch_failed', 4000, { statusCode: 500 }));
  expect(metroBundleState(lines, { running: true, now: 4000 })).toEqual({
    bundling: false,
    last: { platform: 'android', status: 'failed', durationMs: 3000, finishedAt: '1970-01-01T00:00:04.000Z' },
  });
});

test('a log without bundle requests reports none', () => {
  expect(metroBundleState(captured.slice(0, 3), { running: true, now: 0 })).toBeNull();
});
