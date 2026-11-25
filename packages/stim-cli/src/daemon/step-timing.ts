export type DaemonLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

type StepOutcome = 'finished' | 'threw' | 'aborted';

/** A count and extra record fields a step fills in while it runs, for a loop whose visited items its result does not show. */
export interface StepTally {
  items?: number;
  fields?: Record<string, number | string>;
}

const ERROR_MAX = 200;
const RUNNING_REPORT_MS = 10 * 60_000;
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
 * Writes one `daemon_step_running` record for each 10 minutes `step` runs without ending, so a step that never ends
 * is named in the daemon log. Returns the function that stops the records.
 */
function watchStep(
  log: DaemonLog,
  step: string,
  startedAt: number,
  started: number,
  fields?: Record<string, unknown>,
): () => void {
  const timer = setInterval(() => {
    try {
      const runningMs = Math.round(performance.now() - started);
      log('warn', 'daemon_step_running', `${step} still running after ${runningMs}ms`, {
        step,
        ...Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) => !WRITER_FIELDS.has(key))),
        startedAt: new Date(startedAt).toISOString(),
        runningMs,
      });
    } catch {}
  }, RUNNING_REPORT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Runs `run` and writes a `daemon_step_running` record for each 10 minutes it runs, without a record when it ends. */
export async function watchedStep<T>(log: DaemonLog, step: string, run: () => Promise<T>): Promise<T> {
  const stop = watchStep(log, step, Date.now(), performance.now());
  try {
    return await run();
  } finally {
    stop();
  }
}

/**
 * Runs `run` and writes one `daemon_step` record to the daemon log: when it started, how long it took, how many items
 * it visited and how it ended. It returns `run`'s value, rethrows its error unchanged and changes nothing else; with
 * no `log` it only calls `run`. `items` is read after the step ends, with the result when it finished. While it runs it
 * writes a `daemon_step_running` record every 10 minutes; tally fields are read when it ends.
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
  const stop = watchStep(log, step, startedAt, started, fields);
  try {
    result = await run(tally);
    return result;
  } catch (error) {
    ({ outcome, failure } = classify(error, signal));
    throw error;
  } finally {
    stop();
    try {
      const durationMs = Math.round(performance.now() - started);
      const count = tally.items ?? items?.(result);
      log(
        'debug',
        'daemon_step',
        `${step}${fields?.rung === undefined ? '' : ` ${String(fields.rung)}`} ${outcome} in ${durationMs}ms${count === undefined ? '' : `; ${count} items`}`,
        {
          ...Object.fromEntries(Object.entries(tally.fields ?? {}).filter(([key]) => !WRITER_FIELDS.has(key))),
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
