import type { GcReportCache } from '@stim-cli/core/state';

/** A gc report sweep's budget: a large machine needs over four minutes (#6606). */
export const GC_REPORT_BUDGET_MS: number = 15 * 60_000;

interface Sweep {
  startedAt: number;
  result: Promise<GcReportCache>;
  leave(): void;
}

export interface GcReportSweeps {
  /** A sweep's report: with `after`, of one that started no earlier; otherwise of the one under way or a new one. */
  sweep(after?: number): Promise<GcReportCache>;
  /** Stops the sweep under way; later asks are refused. */
  close(): void;
}

/**
 * stimd's gc report sweeps, the only writer of the cached report: at most one runs at a time, and an ask that needs a
 * newer one than the sweep under way gets the one sweep that follows it. Every failure of a sweep's thread job reaches
 * `onFailure`, also one that lands after the sweep's budget already failed it.
 */
export function createGcReportSweeps(
  run: () => { result: Promise<GcReportCache>; leave(): void },
  write: (cache: GcReportCache) => void,
  onFailure: (error: unknown) => void = () => {},
  now: () => number = Date.now,
): GcReportSweeps {
  // @ref LLP 0012#the-gc-report-answers-from-its-cache -- stimd's sweep is the one writer of the cached report
  let current: Sweep | null = null;
  let next: Promise<GcReportCache> | null = null;
  let closed = false;
  const start = (): Sweep => {
    const asked = run();
    asked.result.catch(onFailure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        asked.leave();
        reject(new Error(`the gc report did not finish within ${GC_REPORT_BUDGET_MS / 60_000} minutes`));
      }, GC_REPORT_BUDGET_MS);
      timer.unref();
    });
    const sweep: Sweep = {
      startedAt: now(),
      leave: asked.leave,
      result: Promise.race([
        asked.result.then((cache) => {
          if (current === sweep) write(cache);
          return cache;
        }),
        budget,
      ]).finally(() => {
        clearTimeout(timer);
        if (current === sweep) current = null;
      }),
    };
    current = sweep;
    return sweep;
  };
  return {
    sweep(after) {
      if (closed) return Promise.reject(new Error('stimd is ending'));
      if (!current) return start().result;
      if (after === undefined || current.startedAt >= after) return current.result;
      next ??= current.result
        .catch(() => undefined)
        .then(() => {
          next = null;
          if (closed) throw new Error('stimd is ending');
          return (current ?? start()).result;
        });
      return next;
    },
    close() {
      closed = true;
      current?.leave();
    },
  };
}
