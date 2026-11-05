export const UPDATE_CHECK_MIN_INTERVAL_MS = 60_000;

/** Whether a foreground check is due: none has run yet, or the last one started at least a minute ago. */
export function updateCheckDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= UPDATE_CHECK_MIN_INTERVAL_MS;
}
