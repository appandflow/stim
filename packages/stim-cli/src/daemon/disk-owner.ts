/** The turn order on the disk: a hard-floor ladder pass, then any ladder pass, then the maintenance lane's next unit. */
export const HARD_FLOOR = 0;
export const LADDER = 1;
export const LANE = 2;

/** The slots of the stim-daemon's ladder clocks (`LadderInput.clocks`), which live as long as stimd. */
export const LADDER_CLOCK_SLOTS = {
  unowned: 0,
  'cargo high': 1,
  'cargo critical': 2,
  'report 5': 3,
  'report 7': 4,
} as const;

let holder: number | null = null;
const waiting: { rank: number; grant: () => void }[] = [];

/**
 * Waits for the one turn on the disk this thread owns: every gc deletion of the stim-daemon, its ladder passes and its
 * maintenance lane's dormant step and maintenance pass, runs while holding it.
 */
export function acquireDisk(rank: number): Promise<void> {
  if (holder === null) {
    holder = rank;
    return Promise.resolve();
  }
  return new Promise((grant) => {
    const at = waiting.findIndex((entry) => entry.rank > rank);
    waiting.splice(at === -1 ? waiting.length : at, 0, { rank, grant });
  });
}

export function releaseDisk(): void {
  const next = waiting.shift();
  holder = next ? next.rank : null;
  next?.grant();
}

let regained: Promise<void> | null = null;

/**
 * A unit boundary of the lane, which holds the turn: gives the turn to a waiting ladder pass, and takes it back after.
 * Walks the lane runs side by side share one hand-over: each waits until the lane has the turn back.
 */
export function diskBoundary(): Promise<void> {
  if (!regained && holder !== LANE)
    throw new Error('a unit boundary ran while the maintenance lane did not hold the disk');
  if (!regained && waiting.some((entry) => entry.rank < LANE)) {
    releaseDisk();
    regained = acquireDisk(LANE).finally(() => {
      regained = null;
    });
  }
  return regained ?? Promise.resolve();
}
