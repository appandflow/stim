import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.ts';
import { formatElapsed } from '../command-output.ts';
import {
  isClaimRefusal,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
  type ClaimHolder,
  type ClaimRefusedError,
} from '../ownership-claim.ts';

const SLOT_PREFIX = 'slot-';
const SLOT_LABEL = 'build slot';

export interface BuildSlotRecord {
  pid: number | null;
  index: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
}

interface TryAcquireBuildSlotOptions {
  max: number;
  root?: string | null;
  logFile?: string | null;
}

interface AcquireBuildSlotOptions extends TryAcquireBuildSlotOptions {
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  progressMs?: number;
  ceilingMs?: number;
}

export interface BuildSlotHandle {
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
  alive: boolean;
  unresolved: boolean;
}

export const SLOT_POLL_MS = 1000;
export const SLOT_PROGRESS_MS = 30000;
export const SLOT_CEILING_MS: number = 90 * 60 * 1000;

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildSlotsDir(): string {
  return join(getConfigDir(), 'build-slots');
}

export function buildSlotPath(index: number): string {
  return join(buildSlotsDir(), `${SLOT_PREFIX}${index}`);
}

function toRecord(holder: ClaimHolder): BuildSlotRecord {
  const details = holder.details as { index?: unknown; projectRoot?: unknown; logFile?: unknown };
  return {
    pid: holder.owner.pid,
    index: typeof details.index === 'number' ? details.index : null,
    projectRoot: typeof details.projectRoot === 'string' ? details.projectRoot : null,
    startedAt: holder.startedAt || null,
    logFile: typeof details.logFile === 'string' ? details.logFile : null,
  };
}

export function readBuildSlot(path: string): BuildSlotRecord | null {
  const survey = readClaimSet(path);
  const holder = survey.live[0] ?? survey.dead[0];
  return holder ? toRecord(holder) : null;
}

export function tryAcquireBuildSlot({
  max,
  root = null,
  logFile = null,
}: TryAcquireBuildSlotOptions): BuildSlotHandle | null {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  let refusal: ClaimRefusedError | null = null;

  for (let index = 0; index < max; index++) {
    const path = buildSlotPath(index);
    let attempt;
    try {
      attempt = tryAcquireClaim({
        root: path,
        mode: 'exclusive',
        label: SLOT_LABEL,
        details: { index, projectRoot: root, logFile },
      });
    } catch (err) {
      if (!isClaimRefusal(err)) throw err;
      refusal ??= err;
      continue;
    }
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired) continue;
    return {
      acquired: true,
      path,
      index,
      slot: {
        pid: attempt.acquired.owner.pid,
        index,
        projectRoot: root,
        startedAt: attempt.acquired.startedAt,
        logFile,
      },
      claim: attempt.acquired,
    };
  }

  if (refusal) throw refusal;
  return null;
}

export function slotWaitingLine({ max, elapsedMs }: { max: number; elapsedMs: number }): string {
  return `${'build'.padEnd(11)} waiting for a build slot (all ${max} in use, ${formatElapsed(elapsedMs)} elapsed)`;
}

export async function acquireBuildSlot({
  max,
  root = null,
  logFile = null,
  now = Date.now,
  out = () => {},
  sleep = sleepAsync,
  intervalMs = SLOT_POLL_MS,
  progressMs = SLOT_PROGRESS_MS,
  ceilingMs = SLOT_CEILING_MS,
}: AcquireBuildSlotOptions): Promise<BuildSlotHandle> {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  const started = now();
  let lastProgress = started;
  for (;;) {
    const got = tryAcquireBuildSlot({ max, root, logFile });
    if (got) return got;

    const elapsed = now() - started;
    if (elapsed >= ceilingMs) {
      const err = new Error(
        `Waited ${formatElapsed(elapsed)} for one of ${max} build slots, and every slot is held by a ` +
          'process that is still running. Slots live under ' +
          buildSlotsDir() +
          '; ' +
          'remove a slot directory whose builder is not really building, or raise concurrency.maxBuilds.',
      ) as Error & { code?: string };
      err.code = 'STIM_BUILD_SLOT_TIMEOUT';
      throw err;
    }
    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      out(slotWaitingLine({ max, elapsedMs: elapsed }));
    }
    await sleep(intervalMs);
  }
}

export function releaseBuildSlot(handle?: BuildSlotHandle | null): boolean {
  if (!handle || handle.unlimited) return false;
  return releaseClaim(handle.claim);
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
      alive: survey.live.length > 0,
      unresolved: survey.unresolved.length > 0,
    });
  }
  return slots;
}
