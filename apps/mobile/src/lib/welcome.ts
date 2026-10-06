export function welcomeState(
  macs: readonly unknown[] | null | undefined,
  seen: boolean,
): { show: boolean; markSeen: boolean } {
  if (macs == null) return { show: false, markSeen: false };
  if (macs.length > 0) return { show: false, markSeen: true };
  return { show: !seen, markSeen: false };
}
