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
  if (marks.length >= MARKS) marks.splice(1, 1);
  marks.push({ label, at: clock() });
}

/**
 * The marked code that held the loop longest between `from` and `to`: each mark runs until the next one, the first
 * from `from`, and `next` is the mark that followed it.
 */
function blameStall(
  recorded: readonly Mark[],
  from: number,
  to: number,
): { segment: string | null; segmentMs: number; next: string | null } {
  let blamed = { segment: null as string | null, segmentMs: 0, next: null as string | null };
  recorded.forEach((mark, index) => {
    const following = recorded[index + 1];
    const ms = Math.min(following?.at ?? to, to) - Math.max(mark.at, from);
    if (ms > blamed.segmentMs) blamed = { segment: mark.label, segmentMs: ms, next: following?.label ?? null };
  });
  return { ...blamed, segmentMs: Math.round(blamed.segmentMs) };
}

function threadCpu(): number | null {
  // Older Node.js 22 releases, which the package supports, have no process.threadCpuUsage.
  if (!('threadCpuUsage' in process)) return null;
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * Writes one `daemon_stall` record each time this thread's event loop was blocked for `thresholdMs` or longer, measured
 * by how late a short interval timer fires, with the marked code that held the loop longest since the timer last fired and
 * the CPU this thread used in that time.
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
      const blamed = blameStall(marks, firedAt, at);
      log(
        'info',
        'daemon_stall',
        `the event loop was blocked for ${stallMs}ms in ${blamed.segment ?? 'unmarked code'}`,
        {
          stallMs,
          ...(cpu === null || cpuAt === null ? {} : { cpuMs: Math.round(cpu - cpuAt) }),
          ...blamed,
        },
      );
    }
    marks.splice(0, marks.length - 1);
    firedAt = at;
    cpuAt = cpu;
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    clock = () => performance.now();
  };
}
