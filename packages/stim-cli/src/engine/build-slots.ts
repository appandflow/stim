import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildSlotsDir, tryAcquireBuildSlotClaim, requireAutomaticMachine } from '@stim-cli/core/state';
import type { BuildWaitingFor, StatusBuildSlotHolder, StatusBuildSlots } from '@stim-cli/core/state';
import { formatElapsed } from '../command-output.ts';
import { readClaimSet, releaseClaim, type ClaimHandle, type ClaimHolder } from '../ownership-claim.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from './spawn-claims.ts';
import { ambientContext } from '@stim-cli/core';
import { daemonWaiter, notifyReleased, opWaiting } from '../daemon/client.ts';
import { endForSwitch, ownStoreEngine, stagedHold, switchedEngine, type StoreEngine } from '../daemon/engine-switch.ts';
import { liveWaiters, queuePosition, takeWaitTicket, waitCeiling } from './wait-queue.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { admissionLimits } from '../workspace/config.ts';
import { busySlots, slotTurn } from '../policy/admission.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';

const SLOT_PREFIX = 'slot-';

export interface BuildSlotRecord {
  pid: number | null;
  index: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
  client: string | null;
}

interface TryAcquireBuildSlotOptions {
  max: number;
  root?: string | null;
  logFile?: string | null;
}

interface AcquireBuildSlotOptions extends Omit<TryAcquireBuildSlotOptions, 'max'> {
  /** Pins the cap for the whole wait; absent, every round reads `concurrency.maxBuilds` again. */
  max?: number;
  automatic?: boolean;
  signal?: AbortSignal;
  out?: (line: string) => void;
  waitingFor?: (info: BuildWaitingFor | null) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  progressMs?: number;
  /** A fixed wait before `STIM_AT_CAPACITY`; absent, the queue's liveness ceiling applies. */
  ceilingMs?: number;
  /** The engine store entry this build runs from; absent, the one this code runs from. */
  engine?: StoreEngine | null;
}

export interface BuildSlotHandle {
  slotWaitMs?: number;
  acquired?: true;
  unlimited?: true;
  path?: string;
  index?: number;
  slot?: BuildSlotRecord;
  claim?: ClaimHandle;
}

export interface BuildSlotInfo {
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

/** A build that waited past its ceiling for a slot. */
export class BuildSlotCapacityError extends Error {
  readonly code = 'STIM_AT_CAPACITY';
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.remedy = remedy;
  }
}

export const SLOT_POLL_MS = 1000;
export const SLOT_PROGRESS_MS = 10_000;

function toRecord(holder: ClaimHolder): BuildSlotRecord {
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

export function tryAcquireBuildSlot({
  max,
  root = null,
  logFile = null,
}: TryAcquireBuildSlotOptions): BuildSlotHandle | null {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  const got = tryAcquireBuildSlotClaim({ max, details: { projectRoot: root, logFile } });
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

export function slotWaitingLine({
  max,
  position,
  waiting,
  elapsedMs,
}: {
  max: number;
  position: number;
  waiting: number;
  elapsedMs: number;
}): string {
  return `${'build'.padEnd(11)} waiting for a build slot: queue position ${position} of ${waiting}, all ${max} in use, ${formatElapsed(elapsedMs)} elapsed -- stim guide lifecycle concurrency`;
}

function queueState(max: number, waiters: readonly ClaimHolder[]): string {
  const holders = busySlots(listBuildSlots(), max).map((slot) =>
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
      const running = listBuildSlots().filter((slot) => slot.alive || slot.unresolved).length;
      out(`switching Stim to ${staged.version}; waiting for ${running} running builds`);
    }
    await sleep(intervalMs);
  }
  checkSwitch();
  if (held) opWaiting(false);
}

/**
 * Takes one of the `max` build slots in arrival order, `max` being the option when given and else the current
 * `concurrency.maxBuilds`, read again every round so a raised cap admits a waiting build. A run that finds no free slot, or older runs waiting, joins the
 * build queue under `$STIM_HOME/build-waits`, retries each second and when the daemon wakes it, and prints a progress
 * line every 10 seconds. It refuses with `STIM_AT_CAPACITY` after `ceilingMs`; without it, once a slot's holder has
 * stayed unverifiable for the position-based ceiling, or after 90 minutes in all.
 */
export async function acquireBuildSlot({
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
}: AcquireBuildSlotOptions): Promise<BuildSlotHandle> {
  throwIfCancelled(signal, 'build slot');
  if (automatic) requireAutomaticMachine('build', 'local');
  const waiter = daemonWaiter('build');
  const sleep = sleepOverride ?? ((ms: number) => waiter.wait(ms, signal));
  try {
    await holdForSwitch(engine, { now, out, sleep, intervalMs });
  } catch (error) {
    waiter.close();
    throw error;
  }
  const readMax = () => maxOption ?? admissionLimits().maxBuilds;
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
      throwIfCancelled(signal, 'build slot');
      if (automatic) requireAutomaticMachine('build', 'local');
      const switched = switchedEngine(engine);
      if (switched) endForSwitch(switched.version);
      const max = readMax();
      const waiters = liveWaiters('build');
      const position = queuePosition(waiters, ticket);
      const turn = slotTurn(position, max, busySlots(listBuildSlots(), max));
      if (turn.claim) {
        const got = tryAcquireBuildSlot({ max, root, logFile });
        if (got) return { ...got, slotWaitMs: ticket ? Math.max(0, Math.round(now() - started)) : 0 };
      }
      if (!ticket) {
        ticket = takeWaitTicket('build', { root, displayName: root ? basename(root) : 'build', logFile }, waiters);
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
        kind: 'build-slot',
        inUse: max,
        max,
        since: new Date(started).toISOString(),
        position,
        resource: 'build slots',
      });
      const elapsed = now() - started;
      const overdue =
        ceilingMs === undefined
          ? ceiling.overdue()
          : elapsed >= ceilingMs
            ? ({ kind: 'absolute', waitedMs: elapsed } as const)
            : null;
      if (overdue) {
        throw new BuildSlotCapacityError(
          `Waited ${formatElapsed(elapsed)} for one of ${max} build slots (concurrency.maxBuilds, derived from the CPU cores when 0) at queue position ${position} of ${waiters.length}${overdue.kind === 'unverified' ? `; ${overdue.reason} for ${formatElapsed(overdue.waitedMs)}` : ''}; ${queueState(max, waiters)}.`,
          `Retry once a build finishes, stop a run that holds a slot, or raise concurrency.maxBuilds. A slot whose holder is not really building lives under ${buildSlotsDir()}.`,
        );
      }
      if (now() - lastProgress >= progressMs) {
        lastProgress = now();
        out(slotWaitingLine({ max, position, waiting: waiters.length, elapsedMs: elapsed }));
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

export function releaseBuildSlot(handle?: BuildSlotHandle | null): boolean {
  if (!handle || handle.unlimited) return false;
  stopDeclaringSpawnsOn(ambientContext(), handle.claim);
  const released = releaseClaim(handle.claim);
  if (released) notifyReleased('build');
  return released;
}

export function listBuildSlots(): BuildSlotInfo[] {
  const dir = buildSlotsDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const slots: BuildSlotInfo[] = [];
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
    slots.push({
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
  return slots;
}

/** The `concurrency.maxBuilds` slots a new build could take, `0` to `max - 1`, and who holds each busy one. */
export function buildSlotUsage(max: number, slots: BuildSlotInfo[] = listBuildSlots()): StatusBuildSlots {
  const holders = slots
    .flatMap(({ index, alive, unresolved, projectRoot, client, startedAt }): StatusBuildSlotHolder[] => {
      if (index === null || index >= max) return [];
      if (alive) return [{ slot: index, workspace: projectRoot, client, since: startedAt }];
      return unresolved ? [{ slot: index, workspace: null, client: null, since: null, unresolved: true }] : [];
    })
    .toSorted((a, b) => a.slot - b.slot);
  return { max, inUse: holders.length, holders };
}
