import type { DevicePlatform } from '@/protocol/types';

export interface FrameTarget {
  workspace: string;
  platform: DevicePlatform;
  slot: string;
  physical?: boolean;
}

/** The fields a subscription adds to a target; each hook passes the ones it asks the server for. */
export interface FrameOptions {
  fps?: number;
  maxEdge?: number;
  video?: readonly string[];
  startAt?: number | null;
}

/**
 * The `frames.subscribe` params that name a device, and a key that changes when the device or any of the
 * requested options change. A hook adds its own options to `params`.
 */
export function frameTarget(target: FrameTarget, options: FrameOptions = {}) {
  const { workspace, platform, slot, physical } = target;
  return {
    key: `${workspace}\n${platform}\n${slot}\n${physical ? 'physical' : ''}\n${options.fps}\n${options.maxEdge}\n${options.video?.join(',')}\n${options.startAt ?? ''}`,
    params: { workspace, platform, slot, ...(physical ? { physical } : {}) },
  };
}
