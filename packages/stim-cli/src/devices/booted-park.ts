import type { StimContext } from '@stim-cli/core';
import type { HostedLocalPlatformCounts } from '@stim-cli/core/state';
import { countLiveOwnedDevicesByPlatformAsync } from '../engine/device-capacity.ts';
import { readHostMemoryPressureAsync, type HostMemoryPressure } from '../host-memory.ts';
import { machineNumber } from '../machine-number.ts';
import { admissionLimits, getPlatformDeviceLimits, loadConfig } from '../workspace/config.ts';

const GRACE_SETTING = 'pool.bootedGraceMinutes';
const MINUTE_MS = 60_000;

export interface BootedParkFacts {
  graceMinutes: number;
  memory: HostMemoryPressure | null;
  /** Booted owned devices counted as admission counts them, this one included. */
  counts: HostedLocalPlatformCounts | { unknown: string };
  maxDevices: number;
  platformMax: number;
  now: number;
}

/**
 * When a parked device that is booted now may stay booted until: the grace period from `now`, only while memory
 * pressure reads normal and a device slot besides this one is free under both caps. Null shuts it down: a grace of 0,
 * memory pressure that is not normal or unreadable, or devices that cannot be counted.
 */
export function bootedParkDeadline(
  platform: 'ios' | 'android',
  { graceMinutes, memory, counts, maxDevices, platformMax, now }: BootedParkFacts,
): string | null {
  if (graceMinutes <= 0 || memory !== 'normal' || 'unknown' in counts) return null;
  if (maxDevices > 0 && counts.ios + counts.android >= maxDevices) return null;
  if (platformMax > 0 && counts[platform] >= platformMax) return null;
  return new Date(now + graceMinutes * MINUTE_MS).toISOString();
}

/** {@link bootedParkDeadline} from this machine's settings, memory and booted devices. */
export async function readBootedParkDeadline(
  platform: 'ios' | 'android',
  operation: StimContext | undefined,
): Promise<string | null> {
  if (!operation) return null;
  const { env } = operation;
  const { value: graceMinutes } = machineNumber(GRACE_SETTING, loadConfig(), env);
  if (!graceMinutes) return null;
  const memory = await readHostMemoryPressureAsync(undefined, undefined, operation.signal, operation);
  if (memory !== 'normal') return null;
  const counts = await countLiveOwnedDevicesByPlatformAsync({});
  return bootedParkDeadline(platform, {
    graceMinutes,
    memory,
    counts,
    maxDevices: admissionLimits({ env }).maxDevices,
    platformMax: getPlatformDeviceLimits({ env })[platform],
    now: Date.now(),
  });
}
