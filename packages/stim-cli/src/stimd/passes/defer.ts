import type { MaintenanceCheck, MaintenanceState, PressureLevel } from '@stim-cli/core/state';

/** The size scan deferred for host load runs anyway once it has been deferred this long. */
const DEFERRAL_CEILING_MS: number = 3 * 3_600_000;
/** The Cargo target cap measures on its own at most this often while the size scan is deferred. */
const CAP_CHECK_MS: number = 60 * 60_000;

export function deferCheck(
  state: MaintenanceState,
  check: MaintenanceCheck,
  now: number,
  loaded: boolean,
  diskLevel: PressureLevel,
): boolean {
  // @ref LLP 0001#pressure-acts-without-waiting-for-measurement-or-load -- load defers nothing above normal
  const since = state.deferredSince?.[check];
  return (
    loaded && diskLevel === 'normal' && !(check === 'size' && since !== undefined && now - since >= DEFERRAL_CEILING_MS)
  );
}

export function markDeferred(state: MaintenanceState, check: MaintenanceCheck, now: number): void {
  state.deferredAt = { ...state.deferredAt, [check]: now };
  state.deferredSince = { ...state.deferredSince, [check]: state.deferredSince?.[check] ?? now };
}

export function clearDeferred(state: MaintenanceState, check: MaintenanceCheck): void {
  delete state.deferredAt?.[check];
  delete state.deferredSince?.[check];
}

/** Whether the Cargo target cap is due to measure on its own: neither it nor the size scan ran in the last hour. */
export function capDue(state: MaintenanceState, now: number): boolean {
  const last = Math.max(state.lastAt.size ?? 0, state.capAt ?? 0);
  return last > now || now - last >= CAP_CHECK_MS;
}
