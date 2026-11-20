/** The turn order on the disk: a hard-floor ladder pass, then any ladder pass, then the maintenance lane's next unit. */
export const HARD_FLOOR = 0;
export const LADDER = 1;
export const LANE = 2;

let held = false;
const waiting: { rank: number; grant: () => void }[] = [];

/**
 * Waits for the one turn on the disk this thread owns: every gc deletion of the stim-daemon, its ladder passes and its
 * maintenance lane's dormant step and maintenance pass, runs while holding it.
 */
export function acquireDisk(rank: number): Promise<void> {
  if (!held) {
    held = true;
    return Promise.resolve();
  }
  return new Promise((grant) => {
    const at = waiting.findIndex((entry) => entry.rank > rank);
    waiting.splice(at === -1 ? waiting.length : at, 0, { rank, grant });
  });
}

export function releaseDisk(): void {
  const next = waiting.shift();
  if (next) next.grant();
  else held = false;
}

/** A unit boundary of the lane: gives the turn to a waiting ladder pass, and takes it back after. */
export async function diskBoundary(): Promise<void> {
  if (!waiting.some((entry) => entry.rank < LANE)) return;
  releaseDisk();
  await acquireDisk(LANE);
}
