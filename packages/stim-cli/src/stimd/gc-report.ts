import { parseGcReportPartial, type GcReportCache, type GcReportPartial } from '@stim-cli/core/state';

/** A gc report sweep's budget: a large machine needs over four minutes (#6606). */
export const GC_REPORT_BUDGET_MS: number = 15 * 60_000;

type OnPart = (part: GcReportPartial) => void;

interface Sweep {
  startedAt: number;
  result: Promise<GcReportCache>;
  parts: GcReportPartial[];
  listeners: Set<OnPart>;
  leave(): void;
}

function join(sweep: Sweep, onPart?: OnPart): Promise<GcReportCache> {
  if (onPart) {
    for (const part of sweep.parts) onPart(part);
    sweep.listeners.add(onPart);
  }
  return sweep.result;
}

export interface GcReportSweeps {
  /**
   * A sweep's report: with `after`, of one that started no earlier; otherwise of the one under way or a new one. Each
   * part of that sweep goes to `onPart`, the parts it read before this ask first.
   */
  sweep(after?: number, onPart?: OnPart): Promise<GcReportCache>;
  /** Stops the sweep under way; later asks are refused. */
  close(): void;
}

/**
 * stimd's gc report sweeps, the only writer of the cached report: at most one runs at a time, and an ask that needs a
 * newer one than the sweep under way gets the one sweep that follows it. Every failure of a sweep's thread job reaches
 * `onFailure`, also one that lands after the sweep's budget already failed it. A sweep past its budget fails its
 * askers at once, and no other starts until its thread job settles.
 */
export function createGcReportSweeps(
  run: (onPart: (part: unknown) => void) => { result: Promise<GcReportCache>; leave(): void },
  write: (cache: GcReportCache) => void,
  onFailure: (error: unknown) => void = () => {},
  now: () => number = Date.now,
): GcReportSweeps {
  // @ref LLP 0012#the-gc-report-answers-from-its-cache -- stimd's sweep is the one writer of the cached report
  let current: Sweep | null = null;
  let next: { result: Promise<GcReportCache>; listeners: Set<OnPart> } | null = null;
  let closed = false;
  let stopping: Promise<void> | null = null;
  const start = (listeners: Set<OnPart> = new Set()): Sweep => {
    if (stopping) throw new Error('the last gc report sweep passed its budget and is still stopping');
    const parts: GcReportPartial[] = [];
    const asked = run((value) => {
      const part = parseGcReportPartial(value);
      if (!part) return;
      parts.push(part);
      for (const listener of listeners) listener(part);
    });
    asked.result.catch(onFailure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        asked.leave();
        const stopped = () => {
          stopping = null;
        };
        stopping = asked.result.then(stopped, stopped);
        reject(new Error(`the gc report did not finish within ${GC_REPORT_BUDGET_MS / 60_000} minutes`));
      }, GC_REPORT_BUDGET_MS);
      timer.unref();
    });
    const sweep: Sweep = {
      startedAt: now(),
      parts,
      listeners,
      leave: asked.leave,
      result: Promise.race([
        asked.result.then((cache) => {
          if (current === sweep) write(cache);
          return cache;
        }),
        budget,
      ]).finally(() => {
        clearTimeout(timer);
        listeners.clear();
        if (current === sweep) current = null;
      }),
    };
    current = sweep;
    return sweep;
  };
  return {
    sweep(after, onPart) {
      if (closed) return Promise.reject(new Error('stimd is ending'));
      if (!current) {
        try {
          return join(start(), onPart);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (after === undefined || current.startedAt >= after) return join(current, onPart);
      if (!next) {
        const listeners = new Set<OnPart>();
        const result = current.result
          .catch(() => undefined)
          .then(() => {
            next = null;
            if (closed) throw new Error('stimd is ending');
            if (!current) return start(listeners).result;
            for (const listener of listeners) join(current, listener);
            return current.result;
          });
        next = { result, listeners };
      }
      if (onPart) next.listeners.add(onPart);
      return next.result;
    },
    close() {
      closed = true;
      current?.leave();
    },
  };
}
