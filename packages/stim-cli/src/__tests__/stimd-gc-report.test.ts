import { expect, test, vi } from 'vitest';
import type { GcReportCache } from '@stim-cli/core/state';
import { createGcReportSweeps, GC_REPORT_BUDGET_MS } from '../stimd/gc-report.ts';

const report = (measuredAt: string): GcReportCache => ({
  version: 2,
  measuredAt,
  parts: { plan: measuredAt, sections: measuredAt, inventory: measuredAt },
  report: { mode: 'dry-run' },
  run: {},
});

function sweeps(settlesOnLeave = true) {
  const runs: {
    resolve: (cache: GcReportCache) => void;
    reject: (error: Error) => void;
    leave: () => void;
    part: (part: unknown) => void;
  }[] = [];
  const written: GcReportCache[] = [];
  const failures: unknown[] = [];
  let clock = 0;
  const owner = createGcReportSweeps(
    (part) => {
      let resolve!: (cache: GcReportCache) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<GcReportCache>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const leave = vi.fn<() => void>(() => {
        if (settlesOnLeave) reject(new Error('aborted'));
      });
      runs.push({ resolve, reject, leave, part });
      return { result, leave };
    },
    (cache) => written.push(cache),
    (error) => failures.push(error),
    () => clock,
  );
  return { owner, runs, written, failures, tick: (ms: number) => (clock += ms) };
}

test('asks join the sweep under way, and an ask for a newer one gets one sweep after it', async () => {
  const { owner, runs, written, tick } = sweeps();
  const first = owner.sweep();
  const joined = owner.sweep();
  tick(10);
  const fresh = [owner.sweep(tick(0)), owner.sweep(tick(0))];
  expect(runs).toHaveLength(1);

  runs[0]?.resolve(report('2026-11-28T00:00:00.000Z'));
  await expect(first).resolves.toMatchObject({ measuredAt: '2026-11-28T00:00:00.000Z' });
  await expect(joined).resolves.toMatchObject({ measuredAt: '2026-11-28T00:00:00.000Z' });
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  runs[1]?.resolve(report('2026-11-28T00:05:00.000Z'));
  for (const ask of fresh) await expect(ask).resolves.toMatchObject({ measuredAt: '2026-11-28T00:05:00.000Z' });
  expect(written.map((cache) => cache.measuredAt)).toEqual(['2026-11-28T00:00:00.000Z', '2026-11-28T00:05:00.000Z']);
});

test('a failed sweep writes nothing, and one past its budget fails even when its thread never settles', async () => {
  vi.useFakeTimers();
  const { owner, runs, written } = sweeps(false);
  const failed = owner.sweep();
  runs[0]?.reject(new Error('git failed'));
  await expect(failed).rejects.toThrow('git failed');

  const slow = owner.sweep().catch((error: unknown) => error);
  expect(runs).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(GC_REPORT_BUDGET_MS);
  expect(runs[1]?.leave).toHaveBeenCalled();
  expect(await slow).toMatchObject({ message: expect.stringContaining('did not finish within 15 minutes') });
  expect(written).toEqual([]);
  runs[1]?.resolve(report('2026-11-28T00:00:00.000Z'));
  await vi.waitFor(async () => {
    void owner.sweep().catch(() => {});
    expect(runs).toHaveLength(3);
  });
  runs[2]?.resolve(report('2026-11-28T00:20:00.000Z'));
  await vi.waitFor(() => expect(written).toHaveLength(1));
  expect(written.map((cache) => cache.measuredAt)).toEqual(['2026-11-28T00:20:00.000Z']);
});

test('a cleanup failure that lands after the budget failed the sweep still reaches stimd', async () => {
  vi.useFakeTimers();
  const { owner, runs, failures } = sweeps(false);
  const slow = owner.sweep().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(GC_REPORT_BUDGET_MS);
  expect(await slow).toMatchObject({ message: expect.stringContaining('did not finish') });
  const cleanup = Object.assign(new Error('Report child 4242 did not close'), { reportCleanup: true });
  runs[0]?.reject(cleanup);
  await vi.waitFor(() => expect(failures).toContain(cleanup));
});

test('after a sweep passes its budget, no other sweep starts until its thread job settles', async () => {
  vi.useFakeTimers();
  const { owner, runs } = sweeps(false);
  const slow = owner.sweep().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(GC_REPORT_BUDGET_MS);
  await slow;
  await expect(owner.sweep()).rejects.toThrow('still stopping');
  await expect(owner.sweep(Date.now())).rejects.toThrow('still stopping');
  expect(runs).toHaveLength(1);
  runs[0]?.reject(new Error('aborted'));
  await vi.waitFor(async () => {
    void owner.sweep().catch(() => {});
    expect(runs).toHaveLength(2);
  });
});

test('each ask gets the parts of its sweep as they land, a late joiner the earlier ones first', async () => {
  const { owner, runs, tick } = sweeps();
  const part = (name: string, at: string) => ({ measuredAt: '2026-11-28T00:00:00.000Z', part: name, at, value: {} });
  const first: string[] = [];
  const late: string[] = [];
  const next: string[] = [];
  void owner.sweep(undefined, (landed) => first.push(landed.part));
  runs[0]?.part(part('plan', '2026-11-28T00:00:00.000Z'));
  runs[0]?.part({ part: 'not a part' });
  void owner.sweep(undefined, (landed) => late.push(landed.part));
  runs[0]?.part(part('sections', '2026-11-28T00:01:00.000Z'));
  tick(10);
  const fresh = owner.sweep(tick(0), (landed) => next.push(landed.part));
  runs[0]?.resolve(report('2026-11-28T00:00:00.000Z'));
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  runs[1]?.part(part('plan', '2026-11-28T00:05:00.000Z'));
  runs[1]?.resolve(report('2026-11-28T00:05:00.000Z'));
  await fresh;
  expect(first).toEqual(['plan', 'sections']);
  expect(late).toEqual(['plan', 'sections']);
  expect(next).toEqual(['plan']);
});
