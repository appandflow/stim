import type { MaintenanceCheck, MaintenanceState } from '@stim-cli/core/state';
import type { MaintenanceSettings } from './settings.ts';

const DEFERRED_RETRY_MS = 5 * 60_000;
const PRESSURE_CHECK_MS = 60_000;
const SIZE_CHECK_MS = 60 * 60_000;
const IDLE_CHECK_MS = 5 * 60_000;

export function due(
  state: MaintenanceState | null,
  settings: Pick<MaintenanceSettings, 'worktreeCheckMinutes' | 'sweepHours' | 'removeFinishedWorktrees'>,
  now: number,
): MaintenanceCheck[] {
  const elapsed = (stamp: number | undefined) => (stamp === undefined || stamp > now ? Infinity : now - stamp);
  const intervalMs = {
    pressure: PRESSURE_CHECK_MS,
    size: SIZE_CHECK_MS,
    worktree: settings.removeFinishedWorktrees ? settings.worktreeCheckMinutes * 60_000 : Infinity,
    sweep: settings.sweepHours > 0 ? settings.sweepHours * 3_600_000 : Infinity,
    idle: IDLE_CHECK_MS,
  } satisfies Record<MaintenanceCheck, number>;
  return (['pressure', 'size', 'worktree', 'sweep', 'idle'] as const).filter((check) => {
    if (intervalMs[check] === Infinity || elapsed(state?.deferredAt?.[check]) < DEFERRED_RETRY_MS) return false;
    return elapsed(state?.lastAt[check]) >= intervalMs[check];
  });
}
