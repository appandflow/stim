import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSlotsDir, tryAcquireBuildSlotClaim } from '@stim-cli/core/state';
import type { BuildWaitingFor } from '@stim-cli/core/state';
import { formatElapsed } from '../command-output.ts';
import { readClaimSet, releaseClaim, type ClaimHandle, type ClaimHolder } from '../ownership-claim.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from './spawn-claims.ts';

export { buildSlotPath, buildSlotsDir } from '@stim-cli/core/state';

const SLOT_PREFIX = 'slot-';

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
  waitingFor?: (info: BuildWaitingFor | null) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  progressMs?: number;
  ceilingMs?: number;
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
  alive: boolean;
  unresolved: boolean;
}

export const SLOT_POLL_MS = 1000;
export const SLOT_PROGRESS_MS = 30000;
export const SLOT_CEILING_MS: number = 90 * 60 * 1000;

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const got = tryAcquireBuildSlotClaim({ max, details: { projectRoot: root, logFile } });
  if (!got) return null;
  declareSpawnsOn(got.claim);
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
    },
    claim: got.claim,
  };
}

export function slotWaitingLine({ max, elapsedMs }: { max: number; elapsedMs: number }): string {
  return `${'build'.padEnd(11)} waiting for a build slot (all ${max} in use, ${formatElapsed(elapsedMs)} elapsed) -- stim guide lifecycle concurrency`;
}

export async function acquireBuildSlot({
  max,
  root = null,
  logFile = null,
  now = Date.now,
  out = () => {},
  waitingFor = () => {},
  sleep = sleepAsync,
  intervalMs = SLOT_POLL_MS,
  progressMs = SLOT_PROGRESS_MS,
  ceilingMs = SLOT_CEILING_MS,
}: AcquireBuildSlotOptions): Promise<BuildSlotHandle> {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  const started = now();
  let lastProgress = started;
  let waited = false;
  try {
    for (;;) {
      const got = tryAcquireBuildSlot({ max, root, logFile });
      if (got) return { ...got, slotWaitMs: waited ? Math.max(0, Math.round(now() - started)) : 0 };

      waited = true;
      waitingFor({ kind: 'build-slot', inUse: max, max, since: new Date(started).toISOString() });
      const elapsed = now() - started;
      if (elapsed >= ceilingMs) {
        const err = new Error(
          `Waited ${formatElapsed(elapsed)} for one of ${max} build slots, and every slot is held by a ` +
            'process that is still running, or by a holder Stim cannot identify. Slots live under ' +
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
  } finally {
    waitingFor(null);
  }
}

export function releaseBuildSlot(handle?: BuildSlotHandle | null): boolean {
  if (!handle || handle.unlimited) return false;
  stopDeclaringSpawnsOn(handle.claim);
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
