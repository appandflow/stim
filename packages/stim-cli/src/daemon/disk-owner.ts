import type { PressureLevel, RescuedCopy } from '@stim-cli/core/state';
import type { LevelRun, LevelRunAction } from '../stimd/passes/level-run.ts';

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

const RANK: Record<PressureLevel, number> = { normal: 0, high: 1, critical: 2 };

/** What one disk pass did, as a gc request that ran or joined it receives it. */
export interface GcPassReply {
  run: LevelRun;
  rescued?: RescuedCopy[];
  /** The pass already running or queued that the request joined instead of starting its own. */
  joined?: { startedAt: string; trigger: string; level: PressureLevel };
}

interface Pass {
  /** Null for a gc pass at the measured level until it has measured. */
  level: PressureLevel | null;
  trigger: string;
  startedAt: string | null;
  result: Promise<Omit<GcPassReply, 'joined'>>;
  listeners: Set<(action: LevelRunAction) => void>;
  /** Stops a gc pass once no request waits for it; a pass of the tick has none. */
  stop?: AbortController;
}

let running: Pass | null = null;
let queued: Pass | null = null;

/** Runs `work`, a disk pass of the tick that holds the turn, as one a gc request can join with its result as `toRun`. */
export async function joinablePass<T>(
  level: PressureLevel,
  trigger: string,
  work: Promise<T>,
  toRun: (value: T) => LevelRun,
): Promise<T> {
  const pass: Pass = {
    level,
    trigger,
    startedAt: new Date().toISOString(),
    listeners: new Set(),
    result: work.then((value) => ({ run: toRun(value) })),
  };
  pass.result.catch(() => {});
  running = pass;
  try {
    return await work;
  } finally {
    if (running === pass) running = null;
  }
}

type RunGcPass = (
  level: PressureLevel | undefined,
  signal: AbortSignal,
  onAction: (action: LevelRunAction) => void,
  onLevel: (level: PressureLevel) => void,
) => Promise<Omit<GcPassReply, 'joined'>>;

/**
 * One gc request on the disk owner: it joins the running pass, else the queued one, when that pass's level is at
 * least `level` or no level is asked for; a higher level raises the queued pass, and with none queued it queues a
 * pass of its own, which `run` runs once the pass takes the turn. `leave` stops a gc pass no other request waits for.
 */
export function requestGcPass(
  level: PressureLevel | undefined,
  trigger: string,
  run: RunGcPass,
  onAction: (action: LevelRunAction) => void,
): { result: Promise<GcPassReply>; leave(): void } {
  // @ref LLP 0001#every-gc-joins-a-pass-under-way -- no level, or a level at or below the pass's, joins it
  const covers = (pass: Pass | null): pass is Pass =>
    pass !== null && (level === undefined || RANK[pass.level ?? 'normal'] >= RANK[level]);
  let pass = covers(running) ? running : covers(queued) ? queued : null;
  const joined = pass !== null || queued !== null;
  if (!pass && queued && level) {
    queued.level = level;
    pass = queued;
  }
  pass ??= queuePass(level, trigger, run);
  const asked = pass;
  const listen = (action: LevelRunAction) => onAction(action);
  asked.listeners.add(listen);
  return {
    result: asked.result
      .then((reply) => ({
        ...reply,
        ...(joined
          ? {
              joined: {
                startedAt: asked.startedAt ?? new Date().toISOString(),
                trigger: asked.trigger,
                level: asked.level ?? reply.run.level,
              },
            }
          : {}),
      }))
      .finally(() => asked.listeners.delete(listen)),
    leave() {
      if (!asked.listeners.delete(listen) || asked.listeners.size > 0 || !asked.stop) return;
      if (queued === asked) queued = null;
      asked.stop.abort();
    },
  };
}

function queuePass(level: PressureLevel | undefined, trigger: string, run: RunGcPass): Pass {
  const stop = new AbortController();
  const turn = async (): Promise<Omit<GcPassReply, 'joined'>> => {
    // @ref LLP 0001#one-task-runs-every-gc-deletion -- a gc pass takes the turn at the lane's next unit boundary
    await acquireDisk(LADDER);
    try {
      if (queued === pass) queued = null;
      stop.signal.throwIfAborted();
      running = pass;
      pass.startedAt = new Date().toISOString();
      return await run(
        pass.level ?? undefined,
        stop.signal,
        (action) => pass.listeners.forEach((listen) => listen(action)),
        (measured) => {
          pass.level = measured;
        },
      );
    } finally {
      if (running === pass) running = null;
      releaseDisk();
    }
  };
  const pass: Pass = { level: level ?? null, trigger, startedAt: null, listeners: new Set(), stop, result: turn() };
  pass.result.catch(() => {});
  queued = pass;
  return pass;
}
