import type { DaemonPressure, MaintenanceAction } from '@stim-cli/core/state';

const DAY_MS = 86_400_000;

export type Cause = 'disk' | 'memory';

export type Rung = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const LADDER: readonly { rung: Rung; relieves: readonly Cause[] }[] = [
  { rung: 0, relieves: ['memory'] },
  { rung: 1, relieves: ['disk'] },
  { rung: 2, relieves: ['disk'] },
  { rung: 3, relieves: ['disk'] },
  { rung: 4, relieves: ['disk'] },
  { rung: 5, relieves: ['disk'] },
  { rung: 6, relieves: ['disk', 'memory'] },
];

/** The ladder's rungs from `fromRung`, in the order they run, each with the causes it relieves. */
export function rungsFrom(fromRung = 0): readonly { rung: Rung; relieves: readonly Cause[] }[] {
  return LADDER.filter(({ rung }) => rung >= fromRung);
}

/** The causes a rung relieves that are above normal in this measurement. */
export function causesOf(pressure: DaemonPressure, relieves: readonly Cause[]): Cause[] {
  return relieves.filter((cause) => pressure[cause] !== 'normal');
}

/**
 * What a rung does on a fresh measurement: the ladder stops at normal, skips a rung that relieves no raised cause,
 * and otherwise runs it for its raised causes at critical when one of them is critical, else at high.
 */
export function rungDecision(
  pressure: DaemonPressure,
  relieves: readonly Cause[],
): 'stop' | 'skip' | { causes: Cause[]; level: 'high' | 'critical' } {
  if (pressure.level === 'normal') return 'stop';
  const causes = causesOf(pressure, relieves);
  if (!causes.length) return 'skip';
  return {
    causes,
    level: causes.some((cause) => pressure[cause] === 'critical') ? 'critical' : 'high',
  };
}

/** The workspaces a stage takes: those with an idle time (null when something keeps it), longest-idle first. */
export function longestIdleFirst<T extends { idleMs: number | null }>(
  readings: readonly T[],
): (T & { idleMs: number })[] {
  return readings
    .filter((reading): reading is T & { idleMs: number } => reading.idleMs !== null)
    .toSorted((a, b) => b.idleMs - a.idleMs);
}

/** The dormant stage's plan action for a workspace idle `thresholdMs`; `executeAction` carries it out. */
export function dormantAction(path: string, thresholdMs: number, why: string): MaintenanceAction {
  return {
    kind: 'would-dormant-stage',
    target: path,
    workspace: path,
    bytes: 0,
    reason: why,
    olderThanDays: thresholdMs / DAY_MS,
  };
}

/** The idle threshold in milliseconds that a dormant-stage action carries. */
export function dormantThresholdMs(action: Pick<MaintenanceAction, 'olderThanDays'>): number {
  return Math.round((action.olderThanDays ?? 0) * DAY_MS);
}
