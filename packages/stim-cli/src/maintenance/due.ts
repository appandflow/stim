import type { MaintenanceCheck, MaintenanceState } from '@stim-cli/core/state';
import type { MaintenanceSettings } from './settings.ts';

const DEFERRED_RETRY_MS = 5 * 60_000;

export function due(
  state: MaintenanceState | null,
  settings: Pick<MaintenanceSettings, 'pressureCheckMinutes' | 'sizeCheckMinutes'>,
  now: number,
): MaintenanceCheck[] {
  return (['pressure', 'size'] as const).filter((check) => {
    const deferred = state?.deferredAt?.[check];
    if (deferred !== undefined && now - deferred < DEFERRED_RETRY_MS) return false;
    const last = state?.lastAt[check];
    const interval = check === 'pressure' ? settings.pressureCheckMinutes : settings.sizeCheckMinutes;
    return last === undefined || now - last >= interval * 60_000;
  });
}
