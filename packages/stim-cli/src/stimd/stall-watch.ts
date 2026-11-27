import type { DaemonLog } from '../daemon/step-timing.ts';

const INTERVAL_MS = 100;
const STALL_MS = 1000;

interface Longest {
  segment: string | null;
  segmentMs: number;
  next: string | null;
}

let clock: (() => number) | null = null;
let windowStart = 0;
let current: { label: string; at: number } | null = null;
let longest: Longest = { segment: null, segmentMs: 0, next: null };

function close(at: number, next: string | null): void {
  if (!current) return;
  const ms = at - Math.max(current.at, windowStart);
  if (ms > longest.segmentMs) longest = { segment: current.label, segmentMs: ms, next };
}

/** Names the code that starts now, for the `daemon_stall` record of a stall that blocks the loop in it; a no-op until `watchStalls` runs. */
export function markSegment(label: string): void {
  if (!clock) return;
  const at = clock();
  close(at, label);
  current = { label, at };
}

function threadCpu(): number | null {
  // Older Node.js 22 releases, which the package supports, have no process.threadCpuUsage.
  if (!('threadCpuUsage' in process)) return null;
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * Writes one `daemon_stall` record each time this thread's event loop was blocked for `thresholdMs` or longer, measured
 * by how late a short interval timer fires. The record names the marked code that held the loop longest since the timer
 * last fired, each mark running until the next one, and the CPU this thread used in that time. Returns the function
 * that stops it.
 */
export function watchStalls(
  log: DaemonLog,
  {
    thresholdMs = STALL_MS,
    intervalMs = INTERVAL_MS,
    now = () => performance.now(),
    threadCpuMs = threadCpu,
  }: { thresholdMs?: number; intervalMs?: number; now?: () => number; threadCpuMs?: () => number | null } = {},
): () => void {
  clock = now;
  windowStart = now();
  current = null;
  longest = { segment: null, segmentMs: 0, next: null };
  let cpuAt = threadCpuMs();
  const timer = setInterval(() => {
    const at = now();
    let cpu = threadCpuMs();
    const stallMs = Math.round(at - windowStart - intervalMs);
    if (stallMs >= thresholdMs) {
      close(at, null);
      log(
        'info',
        'daemon_stall',
        `the event loop was blocked for ${stallMs}ms in ${longest.segment ?? 'unmarked code'}`,
        {
          stallMs,
          ...(cpu === null || cpuAt === null ? {} : { cpuMs: Math.round(cpu - cpuAt) }),
          ...longest,
          segmentMs: Math.round(longest.segmentMs),
        },
      );
      cpu = threadCpuMs();
    }
    windowStart = now();
    longest = { segment: null, segmentMs: 0, next: null };
    cpuAt = cpu;
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    clock = null;
  };
}
