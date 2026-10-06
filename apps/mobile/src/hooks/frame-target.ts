import type { WorkspaceTarget } from '@/lib/archived';
import type { DevicePlatform } from '@/protocol/types';

export type FrameTarget = WorkspaceTarget & {
  platform: DevicePlatform;
  slot: string;
  physical?: boolean;
};

/** The fields a subscription adds to a target; each hook passes the ones it asks the server for. */
export interface FrameOptions {
  fps?: number;
  maxEdge?: number;
  video?: readonly string[];
  startAt?: number | null;
  deviceFrame?: boolean;
  duoFrame?: boolean;
}

/**
 * The `frames.subscribe` params that name a device, and a key that changes when the device or any of the
 * requested options change. A hook adds its own options to `params`.
 */
export function frameTarget(target: FrameTarget, options: FrameOptions = {}) {
  const { workspace, archive, platform, slot, physical } = target;
  return {
    key: `${archive ? `archive:${archive}` : workspace}\n${platform}\n${slot}\n${physical ? 'physical' : ''}\n${options.fps}\n${options.maxEdge}\n${options.video?.join(',')}\n${options.startAt ?? ''}\n${options.deviceFrame ? 'frame' : ''}\n${options.duoFrame ? 'duo' : ''}`,
    params: { ...(archive ? { archive } : { workspace }), platform, slot, ...(physical ? { physical } : {}) },
  };
}
