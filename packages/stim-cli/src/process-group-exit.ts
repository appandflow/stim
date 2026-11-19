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

export interface GroupLeader {
  pid: number;
  /** The leader's identity captured at spawn, or null when the capture failed. */
  processToken: string | null;
}

function pidInUse(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * Sends `signal` to the process group `leader` led, only while that group id provably still belongs to it, since POSIX
 * does not reuse a pid while a process group with that id exists: the leader is still the recorded process, or no
 * process has its pid. Without a recorded identity, `running` (the leader is the caller's child and not reaped yet)
 * also keeps the pid reserved. Returns whether the signal went out.
 */
export function signalLedGroup(leader: GroupLeader, signal: NodeJS.Signals, running = false): boolean {
  const identity = leader.processToken === null ? 'unknown' : inspectProcessIdentity(leader);
  if (identity === 'different') return false;
  if (identity === 'unknown' && !running && pidInUse(leader.pid)) return false;
  try {
    process.kill(-leader.pid, signal);
  } catch {}
  return true;
}

/**
 * Stops what is left in the process group `leader` led once the leader exited: SIGTERM, then SIGKILL after `graceMs`,
 * each through {@link signalLedGroup}. Resolves to whether the group emptied.
 */
export async function stopGroupLeftovers(leader: GroupLeader, graceMs: number): Promise<boolean> {
  for (const [signal, waitMs] of [
    ['SIGTERM', graceMs],
    ['SIGKILL', groupExitBudgetMs()],
  ] as const) {
    if (!signalLedGroup(leader, signal)) return false;
    if (await waitForGroupExit(leader.pid, waitMs)) return true;
  }
  return false;
}
