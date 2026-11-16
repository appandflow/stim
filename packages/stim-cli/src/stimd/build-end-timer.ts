const BUILD_END_MEASURE_MS = 30_000;
const BUILD_END_BACKOFF_MAX_MS = 4 * 60_000;

/**
 * Starts `start` when marker files exist, no measure job runs and `allowed` holds, then waits `periodMs` before the next
 * look. A pass that leaves any marker it listed doubles the wait up to a ceiling of four minutes; a pass that consumed
 * them resets it. Never keeps the process alive.
 */
export function startBuildEndTimer({
  periodMs = BUILD_END_MEASURE_MS,
  allowed,
  busy,
  markers,
  start,
}: {
  periodMs?: number;
  allowed: () => boolean;
  busy: () => boolean;
  markers: () => string[];
  start: () => Promise<void>;
}): () => void {
  let wait = periodMs;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    timer = setTimeout(look, wait);
    timer.unref();
  };
  const look = () => {
    const listed = allowed() && !busy() ? markers() : [];
    if (!listed.length) return arm();
    void start().finally(() => {
      const kept = markers().some((file) => listed.includes(file));
      wait = kept ? Math.min(wait * 2, BUILD_END_BACKOFF_MAX_MS) : periodMs;
      if (!stopped) arm();
    });
  };
  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
