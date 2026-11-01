import { expect, test } from 'vitest';
import { createRequestLog } from '../src/request-log.ts';

const setup = (debugOn: boolean) => {
  const lines: string[] = [];
  const records: unknown[] = [];
  const log = createRequestLog({
    service: (line) => lines.push(line),
    debug: { enabled: () => debugOn, log: (event, fields) => records.push({ event, ...fields }) },
    now: () => 0,
  });
  return { lines, records, log };
};

test('a build refusal is logged with its reason, other errors without their message', () => {
  const { lines, records, log } = setup(false);
  const tracker = log.track();
  tracker.identify({ id: 'dev1', runId: 'run-1' });
  tracker.begin(1, 'build.start');
  tracker.reply({
    id: 1,
    error: { code: 'build-busy', message: 'This machine declines the build: load at or above 2/core.' },
  });
  tracker.begin(2, 'build.offer');
  tracker.reply({ id: 2, error: { code: 'bad-request', message: 'secret-looking text' } });
  expect(lines).toEqual([
    '1970-01-01T00:00:00.000Z stim-server: request failed method=build.start client=dev1 run=run-1 ms=0 error=build-busy reason="This machine declines the build: load at or above 2/core."',
    '1970-01-01T00:00:00.000Z stim-server: request failed method=build.offer client=dev1 run=run-1 ms=0 error=bad-request',
  ]);
  expect(records).toEqual([]);
});

test('a refusal reason cannot add a line or end its quoted token', () => {
  const { lines, records, log } = setup(true);
  const tracker = log.track();
  tracker.begin(1, 'build.start');
  tracker.reply({
    id: 1,
    error: { code: 'build-refused', message: `x" error=none\nstim-server: forged ${'y'.repeat(400)}` },
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('\n');
  expect(lines[0]).toContain('reason="x\\" error=none\\nstim-server: forged ');
  expect(records).toEqual([
    expect.objectContaining({
      event: 'request',
      error: 'build-refused',
      reason: expect.toSatisfy((r: string) => r.length === 300),
    }),
  ]);
});

test('a different refusal reason within the minute is logged again', () => {
  const { lines, log } = setup(false);
  const tracker = log.track();
  for (const [id, message] of [
    [1, 'The connection closed.'],
    [2, 'The connection closed.'],
    [3, 'This machine runs Stim build b2.'],
  ] as const) {
    tracker.begin(id, 'build.start');
    tracker.reply({ id, error: { code: 'build-refused', message } });
  }
  expect(lines.map((line) => line.split('reason=')[1])).toEqual([
    '"The connection closed."',
    '"This machine runs Stim build b2."',
  ]);
});

test('a refusal that differs only in its numbers is logged once a minute', () => {
  const { lines, log } = setup(false);
  const tracker = log.track();
  for (const [id, load] of [
    [1, '2.3'],
    [2, '2.4'],
  ] as const) {
    tracker.begin(id, 'build.start');
    tracker.reply({ id, error: { code: 'build-busy', message: `load at or above 2/core (load ${load}/core)` } });
  }
  expect(lines).toHaveLength(1);
});
