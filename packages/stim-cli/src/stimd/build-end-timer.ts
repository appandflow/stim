const BUILD_END_MEASURE_MS = 30_000;

/**
 * Every `periodMs`, starts `start` when builds ended and the measure thread is free. It never keeps the process alive
 * and starts nothing while `allowed` is false or a job is in flight, so a marker waits for the next period instead.
 */
export function startBuildEndTimer({
  periodMs = BUILD_END_MEASURE_MS,
  allowed,
  busy,
  marked,
  start,
}: {
  periodMs?: number;
  allowed: () => boolean;
  busy: () => boolean;
  marked: () => boolean;
  start: () => void;
}): () => void {
  const timer = setInterval(() => {
    if (allowed() && !busy() && marked()) start();
  }, periodMs);
  timer.unref();
  return () => clearInterval(timer);
}
