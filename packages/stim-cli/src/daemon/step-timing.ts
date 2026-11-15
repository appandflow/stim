export type DaemonLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

type StepOutcome = 'finished' | 'threw' | 'aborted';

/** A count a step fills in while it runs, for a loop whose visited items its result does not show. */
export interface StepTally {
  items?: number;
}

const ERROR_MAX = 200;
const WRITER_FIELDS = new Set(['src', 'level', 'event', 'msg', 'ts']);

function classify(error: unknown, signal: AbortSignal | undefined): { outcome: StepOutcome; failure?: string } {
  try {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return { outcome: 'aborted' };
    return { outcome: 'threw', failure: (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX) };
  } catch {
    return { outcome: 'threw' };
  }
}

/**
 * Runs `run` and writes one `daemon_step` record to the daemon log: when it started, how long it took, how many items
 * it visited and how it ended. It returns `run`'s value, rethrows its error unchanged and changes nothing else; with
 * no `log` it only calls `run`. `items` is read after the step ends, with the result when it finished.
 */
export async function timedStep<T>(
  log: DaemonLog | undefined,
  step: string,
  run: (tally: StepTally) => Promise<T>,
  {
    signal,
    fields,
    items,
  }: {
    signal?: AbortSignal;
    fields?: Record<string, unknown>;
    items?: (result: T | undefined) => number | undefined;
  } = {},
): Promise<T> {
  const tally: StepTally = {};
  if (!log) return run(tally);
  const startedAt = Date.now();
  const started = performance.now();
  let outcome: StepOutcome = 'finished';
  let result: T | undefined;
  let failure: string | undefined;
  try {
    result = await run(tally);
    return result;
  } catch (error) {
    ({ outcome, failure } = classify(error, signal));
    throw error;
  } finally {
    try {
      const durationMs = Math.round(performance.now() - started);
      const count = tally.items ?? items?.(result);
      log(
        'debug',
        'daemon_step',
        `${step}${fields?.rung === undefined ? '' : ` ${String(fields.rung)}`} ${outcome} in ${durationMs}ms${count === undefined ? '' : `; ${count} items`}`,
        {
          step,
          ...Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) => !WRITER_FIELDS.has(key))),
          startedAt: new Date(startedAt).toISOString(),
          durationMs,
          ...(count === undefined ? {} : { items: count }),
          outcome,
          ...(failure ? { error: failure } : {}),
        },
      );
    } catch {}
  }
}
