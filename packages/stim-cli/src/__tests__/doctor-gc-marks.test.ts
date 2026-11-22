import type { DaemonStatus, GcMarkHealth } from '@stim-cli/core/state';
import { gcMarkHealthFindings } from '../diagnostics/doctor-gc-marks.ts';

const now = Date.now();
const markedAt = new Date(now - 3_600_000).toISOString();
const observation = (): GcMarkHealth => ({
  at: now,
  state: 'ready',
  checkedRoots: 1,
  staleCount: 1,
  stale: [{ root: '/projects/mobile', markedAt, intervalMs: 600_000 }],
});
const status = (): DaemonStatus => ({
  mode: 'on',
  running: { pid: 123, since: new Date(now - 7_200_000).toISOString() },
  lastTickAt: new Date(now).toISOString(),
  intervalMs: 60_000,
  gcMarks: observation(),
});

test('doctor names the positively authorized stale root and generation time from its saved observation', () => {
  expect(gcMarkHealthFindings(status(), now)).toMatchObject([
    {
      code: 'gc-mark-stale',
      title: expect.stringContaining('/projects/mobile'),
      detail: expect.stringContaining(markedAt),
    },
  ]);
});

test('partial coverage retains a concrete stale warning without reporting a total', () => {
  const input = status();
  input.gcMarks = { at: now, state: 'partial', stale: observation().stale };
  const findings = gcMarkHealthFindings(input, now);
  expect(findings.map(({ code }) => code)).toEqual(['gc-mark-stale', 'gc-mark-health-incomplete']);
});

test('an unavailable or expired reader observation never replays old stale evidence', () => {
  const input = status();
  input.gcMarks = { ...observation(), at: now - 3 * 60_000 - 1 };
  expect(gcMarkHealthFindings(input, now).map(({ code }) => code)).toEqual(['gc-mark-health-unavailable']);
  input.gcMarks = { at: now, state: 'unavailable', stale: [] };
  expect(gcMarkHealthFindings(input, now).map(({ code }) => code)).toEqual(['gc-mark-health-unavailable']);
});

test('old, malformed and stopped-daemon snapshots carry no invented zero or stale root diagnosis', () => {
  const input = status();
  delete input.gcMarks;
  expect(gcMarkHealthFindings(input, now)).toEqual([]);
  input.gcMarks = { ...observation(), staleCount: -1 };
  expect(gcMarkHealthFindings(input, now)).toEqual([]);
  input.gcMarks = status().gcMarks;
  input.running = null;
  expect(gcMarkHealthFindings(input, now)).toEqual([]);
});
