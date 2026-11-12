import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { StatusBuildSlotHolder, StatusBuildSlots } from '@stim-cli/core/state';
import { formatElapsed } from '../command-output.ts';
import { readClaimSet, releaseClaim, type ClaimHandle, type ClaimHolder } from '../ownership-claim.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from './spawn-claims.ts';
import { ambientContext } from '@stim-cli/core';
import { daemonWaiter, notifyReleased, opWaiting } from '../daemon/client.ts';
import { endForSwitch, ownStoreEngine, stagedHold, switchedEngine, type StoreEngine } from '../daemon/engine-switch.ts';
import { liveWaiters, queuePosition, takeWaitTicket, waitCeiling, type WaitResource } from './wait-queue.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { busySlots, slotTurn } from '../policy/admission.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';

const SLOT_PREFIX = 'slot-';

/** One class of machine-wide slots: where its claims live, which cap bounds it, and how its waiters are worded. */
export interface SlotClass {
  resource: Extract<WaitResource, 'build' | 'test'>;
  /** `build` or `test`, as the progress and refusal lines name the slot. */
  noun: string;
  /** What a slot's holder does, for the remedy that points at a slot whose holder is not really doing it. */
  doing: string;
  /** The setting that caps the class, read again every round. */
  setting: string;
  dir: () => string;
  readMax: () => number;
  tryAcquire: (options: TryAcquireSlotOptions) => SlotHandle | null;
  /** Refuses when the run was placed automatically and its machine is no longer the automatic choice. */
  requireAutomatic?: () => void;
}

interface SlotClaim {
  claim: ClaimHandle;
  index: number;
  path: string;
}

interface SlotRecord {
  pid: number | null;
  index: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
  client: string | null;
}

export interface SlotInfo {
  path: string;
  name: string;
  index: number | null;
  pid: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
  client: string | null;
  alive: boolean;
  unresolved: boolean;
}

export interface SlotHandle {
  slotWaitMs?: number;
  acquired?: true;
  unlimited?: true;
  path?: string;
  index?: number;
  slot?: SlotRecord;
  claim?: ClaimHandle;
}

interface SlotWait {
  inUse: number;
  max: number;
  since: string;
  position: number;
  resource: string;
}

export interface TryAcquireSlotOptions {
  max: number;
  root?: string | null;
  logFile?: string | null;
}

export interface AcquireSlotOptions extends Omit<TryAcquireSlotOptions, 'max'> {
  /** Pins the cap for the whole wait; absent, every round reads the class's setting again. */
  max?: number;
  automatic?: boolean;
  signal?: AbortSignal;
  out?: (line: string) => void;
  waitingFor?: (info: SlotWait | null) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  progressMs?: number;
  /** A fixed wait before `STIM_AT_CAPACITY`; absent, the queue's liveness ceiling applies. */
  ceilingMs?: number;
  /** The engine store entry this run belongs to; absent, the one this code runs from. */
  engine?: StoreEngine | null;
}

/** A run that waited past its ceiling for a slot. */
export class SlotCapacityError extends Error {
  readonly code = 'STIM_AT_CAPACITY';
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.remedy = remedy;
  }
}

const SLOT_POLL_MS = 1000;
const SLOT_PROGRESS_MS = 10_000;

function toRecord(holder: ClaimHolder): SlotRecord {
  const details = holder.details as {
    index?: unknown;
    projectRoot?: unknown;
    logFile?: unknown;
    offloaded?: unknown;
    client?: unknown;
  };
  return {
    pid: holder.owner.pid,
    index: typeof details.index === 'number' ? details.index : null,
    projectRoot: typeof details.projectRoot === 'string' ? details.projectRoot : null,
    startedAt: holder.startedAt || null,
    logFile: typeof details.logFile === 'string' ? details.logFile : null,
    client: details.offloaded === true && typeof details.client === 'string' ? details.client : null,
  };
}

export function tryAcquireSlot(
  claim: (options: { max: number; details: Record<string, unknown> }) => SlotClaim | null,
  { max, root = null, logFile = null }: TryAcquireSlotOptions,
): SlotHandle | null {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  const got = claim({ max, details: { projectRoot: root, logFile } });
  if (!got) return null;
  declareSpawnsOn(ambientContext(), got.claim);
  return {
    acquired: true,
    path: got.path,
    index: got.index,
    slot: {
      pid: got.claim.owner.pid,
      index: got.index,
      projectRoot: root,
      startedAt: got.claim.startedAt,
      logFile,
      client: null,
    },
    claim: got.claim,
  };
}

function slotWaitingLine({
  noun,
  max,
  position,
  waiting,
  elapsedMs,
}: {
  noun: string;
  max: number;
  position: number;
  waiting: number;
  elapsedMs: number;
}): string {
  return `${noun.padEnd(11)} waiting for a ${noun} slot: queue position ${position} of ${waiting}, all ${max} in use, ${formatElapsed(elapsedMs)} elapsed -- stim guide lifecycle concurrency`;
}

function queueState(slots: SlotClass, max: number, waiters: readonly ClaimHolder[]): string {
  const holders = busySlots(listSlots(slots), max).map((slot) =>
    slot.unresolved
      ? `slot ${slot.index} (holder cannot be verified, ${slot.path})`
      : `slot ${slot.index} (${slot.client ? `client ${slot.client}` : (slot.projectRoot ?? `pid ${slot.pid}`)}${slot.startedAt ? ` since ${slot.startedAt}` : ''})`,
  );
  const queue = waiters.map(
    (holder, index) => `${index + 1}. ${String(holder.details.displayName ?? holder.details.root ?? holder.claimId)}`,
  );
  return `held: ${holders.join(', ') || 'none'}; queue: ${queue.join(', ') || 'empty'}`;
}

async function holdForSwitch(
  slots: SlotClass,
  engine: StoreEngine | null,
  {
    now,
    out,
    sleep,
    intervalMs,
  }: { now: () => number; out: (line: string) => void; sleep: (ms: number) => Promise<void>; intervalMs: number },
): Promise<void> {
  const retained = () =>
    engine &&
    readClaimSet(buildClaimRoot(engine.root, engine.build)).live.some((claim) => claim.details.retained === true);
  const checkSwitch = () => {
    const switched = switchedEngine(engine);
    if (switched) endForSwitch(switched.version);
  };
  if (retained()) {
    checkSwitch();
    return;
  }
  let held = false;
  for (let staged = stagedHold(engine, now()); staged; staged = stagedHold(engine, now())) {
    if (retained()) {
      if (held) opWaiting(false);
      checkSwitch();
      return;
    }
    if (!held) {
      held = true;
      opWaiting(true);
      const running = listSlots(slots).filter((slot) => slot.alive || slot.unresolved).length;
      out(`switching Stim to ${staged.version}; waiting for ${running} running ${slots.noun}s`);
    }
    await sleep(intervalMs);
  }
  checkSwitch();
  if (held) opWaiting(false);
}

/**
 * Takes one of the `max` slots of `slots` in arrival order, `max` being the option when given and else the class's
 * current cap, read again every round so a raised cap admits a waiting run. A run that finds no free slot, or older
 * runs waiting, joins the class's queue under `$STIM_HOME/<noun>-waits`, retries each second and when the daemon wakes
 * it, and prints a progress line every 10 seconds. It refuses with `STIM_AT_CAPACITY` after `ceilingMs`; without it,
 * once a slot's holder has stayed unverifiable for the position-based ceiling, or after 90 minutes in all.
 */
export async function acquireSlot(
  slots: SlotClass,
  {
    max: maxOption,
    root = null,
    logFile = null,
    now = Date.now,
    out = () => {},
    waitingFor = () => {},
    signal,
    sleep: sleepOverride,
    intervalMs = SLOT_POLL_MS,
    progressMs = SLOT_PROGRESS_MS,
    ceilingMs,
    automatic = false,
    engine = ownStoreEngine(),
  }: AcquireSlotOptions,
): Promise<SlotHandle> {
  const { noun } = slots;
  throwIfCancelled(signal, `${noun} slot`);
  if (automatic) slots.requireAutomatic?.();
  const waiter = daemonWaiter(slots.resource);
  const sleep = sleepOverride ?? ((ms: number) => waiter.wait(ms, signal));
  try {
    await holdForSwitch(slots, engine, { now, out, sleep, intervalMs });
  } catch (error) {
    waiter.close();
    throw error;
  }
  const readMax = () => maxOption ?? slots.readMax();
  const firstMax = readMax();
  if (!firstMax || firstMax <= 0) {
    waiter.close();
    return { acquired: true, unlimited: true };
  }
  const started = now();
  const ceiling = waitCeiling(now);
  let lastProgress = started;
  let ticket: ClaimHandle | undefined;
  try {
    for (;;) {
      throwIfCancelled(signal, `${noun} slot`);
      if (automatic) slots.requireAutomatic?.();
      const switched = switchedEngine(engine);
      if (switched) endForSwitch(switched.version);
      const max = readMax();
      const waiters = liveWaiters(slots.resource);
      const position = queuePosition(waiters, ticket);
      const turn = slotTurn(position, max, busySlots(listSlots(slots), max));
      if (turn.claim) {
        const got = slots.tryAcquire({ max, root, logFile });
        if (got) return { ...got, slotWaitMs: ticket ? Math.max(0, Math.round(now() - started)) : 0 };
      }
      if (!ticket) {
        ticket = takeWaitTicket(slots.resource, { root, displayName: root ? basename(root) : noun, logFile }, waiters);
        opWaiting(true);
        continue;
      }
      ceiling.update(
        position,
        turn.unverified.length
          ? `the holder of ${turn.unverified.map((slot) => slot.path).join(', ')} cannot be verified`
          : null,
      );
      waitingFor({
        inUse: max,
        max,
        since: new Date(started).toISOString(),
        position,
        resource: `${noun} slots`,
      });
      const elapsed = now() - started;
      const overdue =
        ceilingMs === undefined
          ? ceiling.overdue()
          : elapsed >= ceilingMs
            ? ({ kind: 'absolute', waitedMs: elapsed } as const)
            : null;
      if (overdue) {
        throw new SlotCapacityError(
          `Waited ${formatElapsed(elapsed)} for one of ${max} ${noun} slots (${slots.setting}, derived from the CPU cores when 0) at queue position ${position} of ${waiters.length}${overdue.kind === 'unverified' ? `; ${overdue.reason} for ${formatElapsed(overdue.waitedMs)}` : ''}; ${queueState(slots, max, waiters)}.`,
          `Retry once a ${noun} finishes, stop a run that holds a slot, or raise ${slots.setting}. A slot whose holder is not really ${slots.doing} lives under ${slots.dir()}.`,
        );
      }
      if (now() - lastProgress >= progressMs) {
        lastProgress = now();
        out(slotWaitingLine({ noun, max, position, waiting: waiters.length, elapsedMs: elapsed }));
      }
      await sleep(intervalMs);
    }
  } finally {
    if (ticket) opWaiting(false);
    releaseClaim(ticket);
    waiter.close();
    waitingFor(null);
  }
}

export function releaseSlot(slots: SlotClass, handle?: SlotHandle | null, retain = false): boolean {
  if (!handle || handle.unlimited) return false;
  stopDeclaringSpawnsOn(ambientContext(), handle.claim);
  if (retain) return false;
  const released = releaseClaim(handle.claim);
  if (released) notifyReleased(slots.resource);
  return released;
}

export function listSlots(slots: SlotClass): SlotInfo[] {
  const dir = slots.dir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: SlotInfo[] = [];
  for (const name of names) {
    if (!name.startsWith(SLOT_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const survey = readClaimSet(path);
    const holder = survey.live[0] ?? survey.dead[0];
    const info = holder ? toRecord(holder) : null;
    const index = Number(name.slice(SLOT_PREFIX.length));
    found.push({
      path,
      name,
      index: Number.isFinite(index) ? index : null,
      pid: info?.pid ?? null,
      projectRoot: info?.projectRoot ?? null,
      startedAt: info?.startedAt ?? null,
      logFile: info?.logFile ?? null,
      client: info?.client ?? null,
      alive: survey.live.length > 0,
      unresolved: survey.unresolved.length > 0,
    });
  }
  return found;
}

/** The slots below `max` a new run could take, `0` to `max - 1`, and who holds each busy one. */
export function slotUsage(max: number, slots: SlotInfo[]): StatusBuildSlots {
  const holders = slots
    .flatMap(({ index, alive, unresolved, projectRoot, client, startedAt }): StatusBuildSlotHolder[] => {
      if (index === null || index >= max) return [];
      if (alive) return [{ slot: index, workspace: projectRoot, client, since: startedAt }];
      return unresolved ? [{ slot: index, workspace: null, client: null, since: null, unresolved: true }] : [];
    })
    .toSorted((a, b) => a.slot - b.slot);
  return { max, inUse: holders.length, holders };
}
