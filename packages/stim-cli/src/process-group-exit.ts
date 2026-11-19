import { availableParallelism, loadavg } from 'node:os';
import { cancellableSleep } from './cancellation.ts';
import { processGroupAlive } from './ownership-claim.ts';
import { inspectProcessIdentity, waitForProcessExit, type ProcessRecord } from './process-identity.ts';

const BASE_MS = 5_000;

export function loadScaledBudgetMs(baseMs: number, capMs: number): number {
  const loadPerCpu = (loadavg()[0] ?? 0) / availableParallelism();
  return Math.min(capMs, baseMs * Math.max(1, loadPerCpu));
}

export function groupExitBudgetMs(capMs = 60_000): number {
  return loadScaledBudgetMs(BASE_MS, capMs);
}

export async function waitForGroupExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (processGroupAlive(pid)) {
    if (performance.now() >= deadline) return false;
    await cancellableSleep(25);
  }
  return true;
}

/** Waits for `record` to exit and for the process group it led, if any, to empty: a leader can exit before its group. */
export async function waitForTreeExit(record: ProcessRecord, ms: number, signal?: AbortSignal): Promise<boolean> {
  return (await waitForProcessExit(record, ms, signal)) && (await waitForGroupExit(Number(record.pid), ms));
}

/**
 * Stops what is left in the process group that `record`'s process led: SIGTERM, then SIGKILL after `graceMs`. Each
 * signal goes out only while the leader's pid is gone or still names that process, since POSIX does not reuse a pid
 * while a process group with that id exists. Resolves to whether the group emptied.
 */
export async function stopGroupLeftovers(
  record: { pid: number; processToken: string | null },
  graceMs: number,
): Promise<boolean> {
  for (const [signal, waitMs] of [
    ['SIGTERM', graceMs],
    ['SIGKILL', groupExitBudgetMs()],
  ] as const) {
    const identity = inspectProcessIdentity(record);
    if (identity !== 'gone' && identity !== 'same') return false;
    try {
      process.kill(-record.pid, signal);
    } catch {}
    if (await waitForGroupExit(record.pid, waitMs)) return true;
  }
  return false;
}
