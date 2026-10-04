import { t } from '@lingui/core/macro';

import type { TextTone } from '@/components/text';
import { activityBadge, buildProgress, clockDuration } from '@/lib/format';
import { runningBuild, shortUrl, type DeviceRef } from '@/lib/workspaces';
import type { EnvironmentState } from '@/protocol/types';

export interface DeviceTileState {
  text: string;
  tone: TextTone;
}

export interface DeviceTileName {
  name: string;
  detail: string | null;
}

function profileName(profile: string): string {
  return profile
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/** The model and what it runs on: `iPhone 18 Pro` and `iOS 27.0`, `Pixel 9` and `Emulator`. */
export function deviceTileName(device: DeviceRef): DeviceTileName {
  if (device.platform === 'macos') return { name: device.name, detail: 'macOS' };
  if (device.platform === 'web') return { name: t`Chrome`, detail: device.page ? shortUrl(device.page.url) : null };
  if (device.physical) return { name: device.name, detail: device.model === device.name ? null : device.model };
  if (device.platform === 'ios') {
    const match = /^(.*?)\s+(\d+(?:\.\d+)+)$/.exec(device.model);
    if (!match) return { name: device.model, detail: null };
    const version = match[2]!;
    return { name: match[1]!, detail: t`iOS ${version}` };
  }
  return device.profile
    ? { name: profileName(device.profile), detail: t`Emulator` }
    : { name: device.model, detail: null };
}

/**
 * What the tile says about the device, the most urgent first: a build running on it, a tool driving it, an app or
 * page that needs attention, idleness, use in the last 10 minutes, and otherwise that it runs.
 */
export function deviceTileState(device: DeviceRef, env: EnvironmentState, now: number): DeviceTileState {
  if (device.platform === 'macos' && env.macos) {
    if (env.macos.build.state === 'running') return { text: t`Building`, tone: 'brand' };
    if (env.macos.build.state === 'failed') return { text: t`Build failed`, tone: 'error' };
    return { text: device.state, tone: device.running ? 'success' : 'secondary' };
  }
  const build = runningBuild(env, device);
  if (build) {
    const elapsed = clockDuration(buildProgress(build, now).elapsedMs);
    return { text: t`Building \u00B7 ${elapsed}`, tone: 'brand' };
  }
  const badge = activityBadge(device.activity, now);
  if (badge?.kind === 'driven') return { text: badge.text, tone: 'brand' };
  if (device.app?.state === 'stopped') return { text: t`App not running`, tone: 'warning' };
  if (device.page?.error) return { text: t`Page failed to load`, tone: 'warning' };
  if (badge) return { text: badge.text, tone: 'tertiary' };
  if (device.activity?.state === 'active') return { text: t`In use`, tone: 'success' };
  if (device.physical) return { text: t`Leased`, tone: 'secondary' };
  return { text: t`Running`, tone: 'success' };
}
