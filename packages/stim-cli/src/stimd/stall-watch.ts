import type { DaemonLog } from '../daemon/step-timing.ts';

const MARKS = 32;
const INTERVAL_MS = 100;
const STALL_MS = 1000;

interface Mark {
  label: string;
  at: number;
}

const marks: Mark[] = [];
let clock: () => number = () => performance.now();

/** Names the main-thread code that starts now, for the `daemon_stall` record of a stall that blocks the loop in it. */
export function markSegment(label: string): void {
  if (marks.length >= MARKS) marks.shift();
  marks.push({ label, at: clock() });
}

/**
 * The marks around a stall whose timer was due at `dueAt`: `after`, the last mark set at or before it, which names the
 * code that ran when the loop blocked, and `before`, the first mark set after it, which ran once the loop moved again.
 */
function blameStall(recorded: readonly Mark[], dueAt: number): { after: string | null; before: string | null } {
  let after: string | null = null;
  let before: string | null = null;
  for (const mark of recorded) {
    if (mark.at <= dueAt) after = mark.label;
    else {
      before = mark.label;
      break;
    }
  }
  return { after, before };
}

function threadCpu(): number | null {
  // Node.js 22 releases older than the one that added process.threadCpuUsage are still supported.
  if (!('threadCpuUsage' in process)) return null;
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * Writes one `daemon_stall` record each time this thread's event loop was blocked for `thresholdMs` or longer, measured
 * by how late a short interval timer fires, with the marks around the stall and the CPU this thread used during it.
 * Returns the function that stops it.
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
  marks.length = 0;
  let firedAt = now();
  let cpuAt = threadCpuMs();
  const timer = setInterval(() => {
    const at = now();
    const cpu = threadCpuMs();
    const dueAt = firedAt + intervalMs;
    const stallMs = Math.round(at - dueAt);
    if (stallMs >= thresholdMs) {
      const { after, before } = blameStall(marks, dueAt);
      log('info', 'daemon_stall', `the event loop was blocked for ${stallMs}ms after ${after ?? 'no marked code'}`, {
        stallMs,
        ...(cpu === null || cpuAt === null ? {} : { cpuMs: Math.round(cpu - cpuAt) }),
        after,
        before,
      });
    }
    firedAt = at;
    cpuAt = cpu;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
