import type { MaintenanceCheck, MaintenanceState } from '@stim-cli/core/state';
import type { MaintenanceSettings } from './settings.ts';

const DEFERRED_RETRY_MS = 5 * 60_000;
const ATTEMPT_BACKOFF_MS = 60_000;

export function due(
  state: MaintenanceState | null,
  settings: Pick<
    MaintenanceSettings,
    'pressureCheckMinutes' | 'sizeCheckMinutes' | 'worktreeCheckMinutes' | 'sweepHours' | 'removeFinishedWorktrees'
  >,
  now: number,
  attemptedAt?: number,
): MaintenanceCheck[] {
  const elapsed = (stamp: number | undefined) => (stamp === undefined || stamp > now ? Infinity : now - stamp);
  if (elapsed(attemptedAt) < ATTEMPT_BACKOFF_MS) return [];
  const intervalMs = {
    pressure: settings.pressureCheckMinutes * 60_000,
    size: settings.sizeCheckMinutes * 60_000,
    worktree: settings.removeFinishedWorktrees ? settings.worktreeCheckMinutes * 60_000 : Infinity,
    sweep: settings.sweepHours > 0 ? settings.sweepHours * 3_600_000 : Infinity,
  } satisfies Record<MaintenanceCheck, number>;
  return (['pressure', 'size', 'worktree', 'sweep'] as const).filter((check) => {
    if (intervalMs[check] === Infinity || elapsed(state?.deferredAt?.[check]) < DEFERRED_RETRY_MS) return false;
    return elapsed(state?.lastAt[check]) >= intervalMs[check];
  });
}
