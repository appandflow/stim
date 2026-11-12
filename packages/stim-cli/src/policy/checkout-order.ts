/** A linked worktree, or a source checkout: the one new worktrees are created and warmed from. */
export type CheckoutRole = 'linked' | 'source';

const RANK: Record<CheckoutRole, number> = { linked: 0, source: 1 };

/** Linked worktrees before source checkouts, keeping the given order within each role. */
export function linkedFirst<T extends { role: CheckoutRole }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => RANK[a.role] - RANK[b.role]);
}

/**
 * Why a source checkout's node_modules and Pods are candidates now, or null: at the critical level once it has been idle
 * `criticalIdleMs`, or at any level once it has been idle `dormantMs` (`idle.sourceDormantDays`; 0 never). Linked
 * worktrees are taken before either.
 */
export function sourceDependenciesDue({
  level,
  idleMs,
  dormantMs,
  criticalIdleMs,
}: {
  level: 'normal' | 'high' | 'critical';
  idleMs: number;
  dormantMs: number;
  criticalIdleMs: number;
}): 'critical' | 'dormant' | null {
  if (level === 'critical' && idleMs >= criticalIdleMs) return 'critical';
  if (dormantMs > 0 && idleMs >= dormantMs) return 'dormant';
  return null;
}
