import type { PressureLevel, RescuedCopy } from '@stim-cli/core/state';
import { keepReserve, releaseReserve } from '../disk-reserve.ts';
import type { LevelRun, LevelRunAction } from '../stimd/passes/level-run.ts';

/**
 * The turn order on the disk: a hard-floor ladder pass, then any ladder pass or gc pass above normal, then the
 * explicit item, then the maintenance lane's next unit, then a gc pass at normal, which waits for the lane to end its run.
 */
export const HARD_FLOOR = 0;
export const LADDER = 1;
const ITEM = 2;
export const LANE = 3;
const NORMAL_GC = 4;

/** The slots of the stim-daemon's ladder clocks (`LadderInput.clocks`), which live as long as stimd. */
export const LADDER_CLOCK_SLOTS = {
  unowned: 0,
  'cargo high': 1,
  'cargo critical': 2,
} as const;

interface Waiter {
  rank: number;
  grant: () => void;
}

let holder: number | null = null;
const waiting: Waiter[] = [];

function enqueue(waiter: Waiter): void {
  const at = waiting.findIndex((entry) => entry.rank > waiter.rank);
  waiting.splice(at === -1 ? waiting.length : at, 0, waiter);
}

/**
 * Waits for the turn like `acquireDisk`; `rerank` changes the priority of a request that still waits, and `withdraw` gives
 * up the request, or the turn once it was granted.
 */
function queueForDisk(rank: number): { granted: Promise<void>; rerank(rank: number): void; withdraw(): void } {
  if (holder === null) {
    holder = rank;
    return { granted: Promise.resolve(), rerank: () => {}, withdraw: releaseDisk };
  }
  const waiter: Waiter = { rank, grant: () => {} };
  const granted = new Promise<void>((grant) => {
    waiter.grant = grant;
  });
  enqueue(waiter);
  return {
    granted,
    rerank(to) {
      const at = waiting.indexOf(waiter);
      if (at === -1 || to === waiter.rank) return;
      waiting.splice(at, 1);
      waiter.rank = to;
      enqueue(waiter);
    },
    withdraw() {
      const at = waiting.indexOf(waiter);
      if (at === -1) releaseDisk();
      else waiting.splice(at, 1);
    },
  };
}

/**
 * Waits for the one turn on the disk this thread owns: every gc deletion of the stim-daemon, its ladder passes and its
 * maintenance lane's dormant step and maintenance pass, runs while holding it.
 */
export function acquireDisk(rank: number): Promise<void> {
  return queueForDisk(rank).granted;
}
export function releaseDisk(): void {
  const next = waiting.shift();
  holder = next ? next.rank : null;
  next?.grant();
}

/** Runs one dedicated cleanup unit at `rank`, an explicit item by default; leaving cancels only this unit. */
export function requestGcItem<T>(
  work: (signal: AbortSignal) => Promise<T>,
  rank: number = ITEM,
): { result: Promise<T>; leave(): void } {
  const stop = new AbortController();
  const ticket = queueForDisk(rank);
  let started = false;
  let cancelWait!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelWait = () => {
      if (started) return;
      ticket.withdraw();
      reject(stop.signal.reason);
    };
    stop.signal.addEventListener('abort', cancelWait, { once: true });
  });
  const result = (async () => {
    try {
      await Promise.race([ticket.granted, cancelled]);
      stop.signal.throwIfAborted();
      started = true;
      releaseReserve();
      return await work(stop.signal);
    } finally {
      stop.signal.removeEventListener('abort', cancelWait);
      if (started) {
        keepReserve();
        ticket.withdraw();
      }
    }
  })();
  result.catch(() => {});
  return { result, leave: () => stop.abort() };
}

let regained: Promise<void> | null = null;

/**
 * A unit boundary of the lane, which holds the turn: gives the turn to a waiting pressure pass or explicit item, and takes it back after.
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

// @ref LLP 0001#one-task-runs-every-gc-deletion -- a gc pass above normal takes the turn at the lane's next unit boundary
const turnRank = (level: PressureLevel | null) => (level === 'high' || level === 'critical' ? LADDER : NORMAL_GC);

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
  result: Promise<GcPassReply>;
  listeners: Map<(action: LevelRunAction) => void, PressureLevel | undefined>;
  /** Stops a gc pass once no request waits for it; a pass of the tick or the lane has none. */
  stop?: AbortController;
  rerank?: (rank: number) => void;
  /** Hands a queued gc pass to a pass that started since and covers it. */
  adopt?: (cover: Pass) => void;
  /** The pass that took over this queued one, whose waiters it now counts. */
  adoptedBy?: Pass;
}

let running: Pass | null = null;
let lane: Pass | null = null;
let queued: Pass | null = null;

/**
 * Runs `work`, a disk pass of the tick or the lane's acting maintenance pass, as one a gc request can join with its
 * result as `toRun`; each action `work` hands to `emit` reaches the requests that joined it.
 */
export async function joinablePass<T>(
  level: PressureLevel,
  trigger: string,
  work: (emit: (action: LevelRunAction) => void) => Promise<T>,
  toRun: (value: T) => LevelRun,
  slot: 'pass' | 'lane' = 'pass',
): Promise<T> {
  const listeners = new Map<(action: LevelRunAction) => void, PressureLevel | undefined>();
  const done = work((action) => listeners.forEach((_level, listen) => listen(action)));
  const pass: Pass = {
    level,
    trigger,
    startedAt: new Date().toISOString(),
    listeners,
    result: done.then((value) => ({ run: toRun(value) })),
  };
  pass.result.catch(() => {});
  if (slot === 'lane') lane = pass;
  else running = pass;
  adoptQueued(pass);
  try {
    return await done;
  } finally {
    if (running === pass) running = null;
    if (lane === pass) lane = null;
    keepReserve();
  }
}

type RunGcPass = (
  level: PressureLevel | undefined,
  signal: AbortSignal,
  onAction: (action: LevelRunAction) => void,
  onLevel: (level: PressureLevel) => void,
) => Promise<Omit<GcPassReply, 'joined'>>;

const joinedOf = (pass: Pass, level: PressureLevel): NonNullable<GcPassReply['joined']> => ({
  startedAt: pass.startedAt ?? new Date().toISOString(),
  trigger: pass.trigger,
  level: pass.level ?? level,
});

// @ref LLP 0001#every-gc-joins-a-pass-under-way -- a pass that starts or measures a covering level takes the queued one
function adoptQueued(cover: Pass): void {
  const held = queued;
  if (
    !held?.adopt ||
    held === cover ||
    cover.stop?.signal.aborted ||
    RANK[cover.level ?? 'normal'] < RANK[held.level ?? 'normal']
  )
    return;
  queued = null;
  held.adoptedBy = cover;
  for (const [listen, level] of held.listeners) cover.listeners.set(listen, level);
  held.listeners.clear();
  held.adopt(cover);
}

/**
 * One gc request on the disk owner: it joins the running pass, else the lane's maintenance pass, else the queued one,
 * when that pass's level is at least `level` or no level is asked for; a higher level raises the queued pass, and with
 * none queued it queues a pass of its own, which `run` runs once the pass takes the turn unless a pass that covers it
 * starts or measures its level first. `leave` stops a gc pass no other request waits for.
 */
export function requestGcPass(
  level: PressureLevel | undefined,
  trigger: string,
  run: RunGcPass,
  onAction: (action: LevelRunAction) => void,
): { result: Promise<GcPassReply>; leave(): void } {
  // @ref LLP 0001#every-gc-joins-a-pass-under-way -- no level, or a level at or below the pass's, joins it
  const covers = (pass: Pass | null): pass is Pass =>
    pass !== null && !pass.stop?.signal.aborted && (level === undefined || RANK[pass.level ?? 'normal'] >= RANK[level]);
  let pass = [running, lane, queued].find(covers) ?? null;
  const joined = pass !== null || queued !== null;
  if (!pass && queued && level) {
    queued.level = level;
    queued.rerank?.(turnRank(level));
    pass = queued;
  }
  pass ??= queuePass(level, trigger, run);
  const asked = pass;
  const listen = (action: LevelRunAction) => onAction(action);
  asked.listeners.set(listen, level);
  return {
    result: asked.result
      .then((reply) => {
        const under = reply.joined ?? (joined ? joinedOf(asked, reply.run.level) : undefined);
        return { ...reply, ...(under ? { joined: under } : {}) };
      })
      .finally(() => (asked.adoptedBy ?? asked).listeners.delete(listen)),
    leave() {
      const target = asked.adoptedBy ?? asked;
      if (!target.listeners.delete(listen)) return;
      if (target.listeners.size === 0) {
        if (queued === target) queued = null;
        target.stop?.abort();
      } else if (queued === target) {
        target.level = [...target.listeners.values()].reduce<PressureLevel | null>(
          (highest, requested) => (requested && (!highest || RANK[requested] > RANK[highest]) ? requested : highest),
          null,
        );
        target.rerank?.(turnRank(target.level));
      }
    },
  };
}

function queuePass(level: PressureLevel | undefined, trigger: string, run: RunGcPass): Pass {
  const stop = new AbortController();
  const ticket = queueForDisk(turnRank(level ?? null));
  let adopt: ((cover: Pass) => void) | undefined;
  const adopted = new Promise<Pass>((resolve) => {
    adopt = resolve;
  });
  const turn = async (): Promise<GcPassReply> => {
    const cover = await Promise.race([ticket.granted.then(() => null), adopted]);
    if (cover) {
      ticket.withdraw();
      const reply = await cover.result;
      return { ...reply, joined: joinedOf(cover, reply.run.level) };
    }
    try {
      if (queued === pass) queued = null;
      stop.signal.throwIfAborted();
      running = pass;
      pass.startedAt = new Date().toISOString();
      return await run(
        pass.level ?? undefined,
        stop.signal,
        (action) => pass.listeners.forEach((_level, listen) => listen(action)),
        (found) => {
          pass.level = found;
          adoptQueued(pass);
        },
      );
    } finally {
      if (running === pass) running = null;
      keepReserve();
      releaseDisk();
    }
  };
  const pass: Pass = {
    level: level ?? null,
    trigger,
    startedAt: null,
    listeners: new Map(),
    stop,
    rerank: ticket.rerank,
    adopt: (cover) => adopt?.(cover),
    result: turn(),
  };
  pass.result.catch(() => {});
  queued = pass;
  return pass;
}
