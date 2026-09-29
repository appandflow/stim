import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import {
  isClaimRefusal,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
  type ClaimRefusedError,
} from '../ownership-claim.ts';
import { getConcurrencyLimits, loadConfig } from './config.ts';
import { settingDefinition } from './settings-registry.ts';

const NATIVE_PHASES = new Set(['prebuild', 'pods', 'compile']);
const SLOT_PREFIX = 'slot-';
const SLOT_LABEL = 'build slot';

export function buildSlotsDir(): string {
  return join(configDir(), 'build-slots');
}

export function buildSlotPath(index: number): string {
  return join(buildSlotsDir(), `${SLOT_PREFIX}${index}`);
}

/**
 * Takes the first free one of `max` `concurrency.maxBuilds` slots, recording `details` and the slot `index`. Returns
 * null while every slot is held; throws the claim refusal when no slot is busy but one cannot be resolved.
 */
export function tryAcquireBuildSlotClaim({
  max,
  details,
}: {
  max: number;
  details: Record<string, unknown>;
}): { claim: ClaimHandle; index: number; path: string } | null {
  let refusal: ClaimRefusedError | null = null;
  let busy = false;
  for (let index = 0; index < max; index++) {
    const path = buildSlotPath(index);
    let attempt;
    try {
      attempt = tryAcquireClaim({ root: path, mode: 'exclusive', label: SLOT_LABEL, details: { ...details, index } });
    } catch (err) {
      if (!isClaimRefusal(err)) throw err;
      refusal ??= err;
      continue;
    }
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired) {
      busy = true;
      continue;
    }
    return { claim: attempt.acquired, index, path };
  }
  if (refusal && !busy) throw refusal;
  return null;
}

/** Build slots held for a build machine's offloaded builds, which run under another Stim home. */
function liveOffloadedSlots(): number {
  let names: string[];
  try {
    names = readdirSync(buildSlotsDir());
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!name.startsWith(SLOT_PREFIX)) continue;
    try {
      if (readClaimSet(join(buildSlotsDir(), name)).live.some((holder) => holder.details.offloaded === true))
        count += 1;
    } catch {}
  }
  return count;
}

/**
 * How busy this Mac is for native builds. `loadPerCore` is the 5-minute load average divided by the CPU count,
 * rounded to one decimal. `builds` counts this Stim home's runs that hold a live native-run claim and are in
 * prebuild, pods or compile here, not on a build machine, plus the build slots this Mac holds for other Macs'
 * offloaded builds. `maxBuilds` is `concurrency.maxBuilds`, 0 when unlimited.
 */
export interface MachineCapacity {
  cpus: number;
  loadPerCore: number;
  builds: number;
  maxBuilds: number;
  maxLoadPerCore: number;
}

function maxLoadPerCore(): number {
  const value = loadConfig()?.offload?.maxLoadPerCore;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return settingDefinition('offload.maxLoadPerCore')!.default as number;
}

function liveNativeBuilds(): number {
  const dir = join(configDir(), 'workspaces');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    let active: unknown;
    try {
      active = (JSON.parse(readFileSync(join(dir, name, 'state.json'), 'utf8')) as { activeBuild?: unknown })
        .activeBuild;
    } catch {
      continue;
    }
    if (!active || typeof active !== 'object') continue;
    const { phase, claim, placement } = active as {
      phase?: unknown;
      claim?: { root?: unknown; claimId?: unknown };
      placement?: unknown;
    };
    if (typeof phase !== 'string' || !NATIVE_PHASES.has(phase) || placement) continue;
    if (typeof claim?.root !== 'string' || typeof claim.claimId !== 'string') continue;
    try {
      if (readClaimSet(claim.root).live.some((holder) => holder.claimId === claim.claimId)) count += 1;
    } catch {}
  }
  return count;
}

export function machineCapacity(): MachineCapacity {
  const cpus = Math.max(1, availableParallelism());
  return {
    cpus,
    loadPerCore: Math.round((loadavg()[1]! / cpus) * 10) / 10,
    builds: liveNativeBuilds() + liveOffloadedSlots(),
    maxBuilds: getConcurrencyLimits().maxBuilds,
    maxLoadPerCore: maxLoadPerCore(),
  };
}

/** Why a Mac with this capacity should not take another native build; null when it can. */
export function saturation(capacity: MachineCapacity): string | null {
  if (capacity.maxBuilds > 0 && capacity.builds >= capacity.maxBuilds) {
    return `all ${capacity.maxBuilds} build slots busy`;
  }
  if (capacity.loadPerCore >= capacity.maxLoadPerCore) {
    return `load at or above ${capacity.maxLoadPerCore}/core`;
  }
  return null;
}
