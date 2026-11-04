import type { StimContext } from '@stim-cli/core';
import { getBootedGraceMinutes, type HostedLocalPlatformCounts } from '@stim-cli/core/state';
import { countLiveOwnedDevicesByPlatformAsync } from '../engine/device-capacity.ts';
import { daemonMode, platformHasDaemon } from '../daemon/mode.ts';
import { readHostMemoryPressureAsync, type HostMemoryPressure } from '../host-memory.ts';
import { admissionLimits, getPlatformDeviceLimits } from '../workspace/config.ts';

const MINUTE_MS = 60_000;

export interface BootedParkFacts {
  graceMinutes: number;
  /** Whether a stim-daemon acts in this home (`daemon.mode` on, a platform with a daemon), since only it ends the grace period. */
  daemonActs: boolean;
  memory: HostMemoryPressure | null;
  /** Booted owned devices counted as admission counts them, this one included. */
  counts: HostedLocalPlatformCounts | { unknown: string };
  maxDevices: number;
  platformMax: number;
  now: number;
}

/**
 * When a device that is booted now, one `worktree remove` parks or one `stop` leaves, may stay booted until: the grace period from `now`, only while memory
 * pressure reads normal and a device slot besides this one is free under both caps. Null shuts it down: a grace of 0,
 * no acting daemon, memory pressure that is not normal or unreadable, or devices that cannot be counted.
 */
export function bootedParkDeadline(
  platform: 'ios' | 'android',
  { graceMinutes, daemonActs, memory, counts, maxDevices, platformMax, now }: BootedParkFacts,
): string | null {
  if (graceMinutes <= 0 || !daemonActs || memory !== 'normal' || 'unknown' in counts) return null;
  if (maxDevices > 0 && counts.ios + counts.android >= maxDevices) return null;
  if (platformMax > 0 && counts[platform] >= platformMax) return null;
  return new Date(now + graceMinutes * MINUTE_MS).toISOString();
}

/** {@link bootedParkDeadline} from this machine's settings, memory and booted devices. */
export async function readBootedParkDeadline(
  platform: 'ios' | 'android',
  operation?: StimContext,
): Promise<string | null> {
  const { max: graceMinutes } = getBootedGraceMinutes();
  if (!graceMinutes) return null;
  const memory = await readHostMemoryPressureAsync(undefined, undefined, operation?.signal, operation);
  if (memory !== 'normal') return null;
  return bootedParkDeadline(platform, {
    graceMinutes,
    daemonActs: platformHasDaemon() && daemonMode(operation?.env) === 'on',
    memory,
    counts: await countLiveOwnedDevicesByPlatformAsync({}),
    maxDevices: admissionLimits().maxDevices,
    platformMax: getPlatformDeviceLimits()[platform],
    now: Date.now(),
  });
}
