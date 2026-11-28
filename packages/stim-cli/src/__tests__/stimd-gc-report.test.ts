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

function sweeps() {
  const runs: { resolve: (cache: GcReportCache) => void; reject: (error: Error) => void; leave: () => void }[] = [];
  const written: GcReportCache[] = [];
  let clock = 0;
  const owner = createGcReportSweeps(
    () => {
      let resolve!: (cache: GcReportCache) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<GcReportCache>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const leave = vi.fn<() => void>(() => reject(new Error('aborted')));
      runs.push({ resolve, reject, leave });
      return { result, leave };
    },
    (cache) => written.push(cache),
    () => clock,
  );
  return { owner, runs, written, tick: (ms: number) => (clock += ms) };
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

test('a failed sweep writes nothing, and one past its budget stops and says so', async () => {
  vi.useFakeTimers();
  const { owner, runs, written } = sweeps();
  const failed = owner.sweep();
  runs[0]?.reject(new Error('git failed'));
  await expect(failed).rejects.toThrow('git failed');

  const slow = owner.sweep().catch((error: unknown) => error);
  expect(runs).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(GC_REPORT_BUDGET_MS);
  expect(runs[1]?.leave).toHaveBeenCalled();
  expect(await slow).toMatchObject({ message: expect.stringContaining('did not finish within 15 minutes') });
  expect(written).toEqual([]);
});
