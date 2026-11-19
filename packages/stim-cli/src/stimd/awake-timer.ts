const STEP_MS = 5_000;
const GAP_CAP_MS = 60_000;

/**
 * Calls `fire` once `ms` of awake time have passed, and returns the function that cancels it. libuv's timers on macOS
 * read `mach_continuous_time`, which advances while the machine sleeps, so a plain timer armed before a sleep fires on
 * wake. This counts the time between 5 s steps instead, and a gap over 60 s counts as nothing, so counting resumes
 * from the wake. A main thread stalled for over 60 s between steps is not counted either (#5995).
 */
export function awakeTimeout(ms: number, fire: () => void): () => void {
  let awake = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    if (gap <= GAP_CAP_MS) awake += gap;
    last = now;
    if (awake < ms) return;
    clearInterval(timer);
    fire();
  }, STEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
