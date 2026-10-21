import { availableParallelism, loadavg } from 'node:os';
import { cancellableSleep } from './cancellation.ts';
import { processGroupAlive } from './ownership-claim.ts';

const BASE_MS = 5_000;

export function groupExitBudgetMs(capMs = 60_000): number {
  const loadPerCpu = (loadavg()[0] ?? 0) / availableParallelism();
  return Math.min(capMs, BASE_MS * Math.max(1, loadPerCpu));
}

export async function waitForGroupExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (processGroupAlive(pid)) {
    if (performance.now() >= deadline) return false;
    await cancellableSleep(25);
  }
  return true;
}
