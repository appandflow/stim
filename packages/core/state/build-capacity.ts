import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { getConcurrencyLimits, loadConfig } from './config.ts';
import { settingDefinition } from './settings-registry.ts';

const NATIVE_PHASES = new Set(['prebuild', 'pods', 'compile']);

/**
 * How busy this Mac is for native builds. `loadPerCore` is the 5-minute load average divided by the CPU count,
 * rounded to one decimal. `builds` counts this Stim home's runs that hold a live native-run claim and are in
 * prebuild, pods or compile. `maxBuilds` is `concurrency.maxBuilds`, 0 when unlimited.
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
    const { phase, claim } = active as { phase?: unknown; claim?: { root?: unknown; claimId?: unknown } };
    if (typeof phase !== 'string' || !NATIVE_PHASES.has(phase)) continue;
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
    builds: liveNativeBuilds(),
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
