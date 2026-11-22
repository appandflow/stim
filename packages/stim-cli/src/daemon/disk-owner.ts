import type { CleanupQueueStatus, PressureLevel, RescuedCopy } from '@stim-cli/core/state';
import { keepReserve, releaseReserve } from '../disk-reserve.ts';
import type { LevelRun, LevelRunAction } from '../stimd/passes/level-run.ts';

/** Disk turns rank hard floor, critical, high/headroom, explicit item, trash, then normal lane/gc work. Equal ranks are FIFO. */
export const HARD_FLOOR = 0;
export const CRITICAL = 1;
export const LADDER = 2;
const ITEM = 3;
export const TRASH = 4;
export const LANE = 5;
const NORMAL_GC = 5;

/** The slots of the stim-daemon's ladder clocks (`LadderInput.clocks`), which live as long as stimd. */
export const LADDER_CLOCK_SLOTS = {
  unowned: 0,
  'cargo high': 1,
  'cargo critical': 2,
} as const;

/** One request's disk turn; only its own release or completed-unit boundary can give it up. */
export interface DiskTurn {
  boundary(): Promise<void>;
  release(): void;
}

interface Ticket extends DiskTurn {
  rank: number;
  trigger: string;
  startedAt: string;
  grant: () => void;
  granted: Promise<void>;
  pass?: Pass;
  rerank(rank: number): void;
  waiting(): boolean;
  withdraw(): void;
}

let holder: Ticket | null = null;
const waiting: Ticket[] = [];
let reportQueue: (status: CleanupQueueStatus) => void = () => {};

/** Sends the owning worker's queue changes to stimd. */
export function reportDiskQueue(listener: typeof reportQueue): void {
  reportQueue = listener;
}

function report(): void {
  reportQueue({
    running: holder ? { startedAt: holder.startedAt, trigger: holder.trigger } : null,
    queued: waiting.length,
  });
}

function enqueue(ticket: Ticket, resuming = false): void {
  const at = waiting.findIndex((entry) => entry.rank > ticket.rank || (resuming && entry.rank === ticket.rank));
  waiting.splice(at === -1 ? waiting.length : at, 0, ticket);
}

function advance(ticket: Ticket): void {
  if (holder !== ticket) return;
  holder = waiting.shift() ?? null;
  if (holder) holder.startedAt = new Date().toISOString();
  report();
  holder?.grant();
}

function queueForDisk(rank: number, trigger: string): Ticket {
  let closed = false;
  let resumed: Promise<void> | null = null;
  let refuseResume: ((error: Error) => void) | undefined;
  let grant: () => void;
  const granted = new Promise<void>((done) => {
    grant = done;
  });
  const ticket: Ticket = {
    rank,
    trigger,
    startedAt: new Date().toISOString(),
    granted,
    grant: () => grant(),
    waiting: () => waiting.includes(ticket),
    rerank(to) {
      if (closed || to === ticket.rank) return;
      const at = waiting.indexOf(ticket);
      if (at !== -1) waiting.splice(at, 1);
      ticket.rank = to;
      if (at !== -1) enqueue(ticket);
    },
    boundary() {
      if (resumed) return resumed;
      if (closed || holder !== ticket) throw new Error('a boundary ran without its disk turn');
      if (!waiting.some((entry) => entry.rank < ticket.rank)) return Promise.resolve();
      resumed = new Promise<void>((done, reject) => {
        ticket.grant = done;
        refuseResume = reject;
      }).finally(() => {
        resumed = null;
        refuseResume = undefined;
      });
      resumed.catch(() => {});
      enqueue(ticket, true);
      advance(ticket);
      return resumed;
    },
    release() {
      ticket.withdraw();
    },
    withdraw() {
      if (closed) return;
      closed = true;
      const at = waiting.indexOf(ticket);
      if (at !== -1) waiting.splice(at, 1);
      refuseResume?.(new Error('the disk turn ended before it resumed'));
      if (holder === ticket) advance(ticket);
      else report();
    },
  };
  if (holder === null) {
    holder = ticket;
    ticket.grant();
  } else enqueue(ticket);
  report();
  return ticket;
}

/** Waits for this thread's one disk turn; the caller releases only the returned turn. */
export async function acquireDisk(rank: number): Promise<DiskTurn> {
  const ticket = queueForDisk(rank, rank === LANE ? 'maintenance' : 'pressure');
  await ticket.granted;
  return ticket;
}

/** Runs one dedicated cleanup unit at `rank`, an explicit item by default; leaving cancels only this unit. */
export function requestGcItem<T>(
  work: (signal: AbortSignal, turn: DiskTurn) => Promise<T>,
  rank: number = ITEM,
): { result: Promise<T>; leave(): void } {
  const stop = new AbortController();
  const ticket = queueForDisk(rank, rank === LADDER ? 'headroom' : 'item');
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
      return await work(stop.signal, ticket);
    } finally {
      stop.signal.removeEventListener('abort', cancelWait);
      if (started) {
        if (holder === ticket) keepReserve();
        ticket.withdraw();
      }
    }
  })();
  result.catch(() => {});
  return { result, leave: () => stop.abort() };
}

const RANK: Record<PressureLevel, number> = { normal: 0, high: 1, critical: 2 };

// @ref LLP 0001#one-task-runs-every-gc-deletion -- a gc pass above normal takes the turn at the lane's next unit boundary
const turnRank = (level: PressureLevel | null) =>
  level === 'critical' ? CRITICAL : level === 'high' ? LADDER : NORMAL_GC;

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
  ticket?: Ticket;
  rerank?: (rank: number) => void;
  /** Hands a queued gc pass to a pass that started since and covers it. */
  adopt?: (cover: Pass) => void;
  /** The pass that took over this queued one, whose waiters it now counts. */
  adoptedBy?: Pass;
}

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
  const turn = holder;
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
  if (turn) turn.pass = pass;
  adoptQueued(pass);
  try {
    return await done;
  } finally {
    if (turn?.pass === pass) delete turn.pass;
    if (lane === pass) lane = null;
    if (turn && (holder === turn || holder === null)) keepReserve();
  }
}

type RunGcPass = (
  level: PressureLevel | undefined,
  signal: AbortSignal,
  onAction: (action: LevelRunAction) => void,
  onLevel: (level: PressureLevel) => void,
  turn: DiskTurn,
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
    !held.ticket?.waiting() ||
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
  const suspended = waiting.flatMap(({ pass }) => (pass?.startedAt ? [pass] : []));
  let pass = [holder?.pass ?? null, ...suspended, lane, queued].find(covers) ?? null;
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
  const ticket = queueForDisk(turnRank(level ?? null), trigger);
  let adopt: ((cover: Pass) => void) | undefined;
  const adopted = new Promise<Pass>((resolve) => {
    adopt = resolve;
  });
  let started = false;
  let cancelWait: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelWait = () => {
      if (started) return;
      ticket.withdraw();
      reject(stop.signal.reason);
    };
    stop.signal.addEventListener('abort', cancelWait, { once: true });
  });
  const turn = async (): Promise<GcPassReply> => {
    try {
      const cover = await Promise.race([ticket.granted.then(() => null), adopted, cancelled]);
      if (cover) {
        ticket.withdraw();
        const reply = await cover.result;
        return { ...reply, joined: joinedOf(cover, reply.run.level) };
      }
      if (queued === pass) queued = null;
      stop.signal.throwIfAborted();
      started = true;
      pass.startedAt = new Date().toISOString();
      return await run(
        pass.level ?? undefined,
        stop.signal,
        (action) => pass.listeners.forEach((_level, listen) => listen(action)),
        (found) => {
          pass.level = found;
          ticket.rerank(turnRank(found));
          adoptQueued(pass);
        },
        ticket,
      );
    } finally {
      stop.signal.removeEventListener('abort', cancelWait);
      if (started && holder === ticket) keepReserve();
      if (ticket.pass === pass) delete ticket.pass;
      ticket.withdraw();
    }
  };
  const pass: Pass = {
    level: level ?? null,
    trigger,
    startedAt: null,
    listeners: new Map(),
    stop,
    ticket,
    rerank: ticket.rerank,
    adopt: (cover) => adopt?.(cover),
    result: turn(),
  };
  ticket.pass = pass;
  pass.result.catch(() => {});
  queued = pass;
  return pass;
}
