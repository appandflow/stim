import type { Config } from '@stim-cli/core/state';
import type { IosSimRecord } from '../../devices/ios.ts';
import { finishedWorkspaces, type OwnedDeviceUsage } from '../../stimd/passes/devices.ts';
import { findStaleProjectDevices } from './devices.ts';
import { canonicalPath } from './paths.ts';
import type { WorktreeSweep } from './worktrees.ts';

export interface FinishedDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  project: string;
  slot?: string;
  bytes?: number;
  reason: string;
}

/** The owned devices of workspaces whose linked worktree is finished but kept, such as a dirty one. */
export function collectFinishedDevices({
  config,
  sims,
  avds,
  sweep,
  now = Date.now(),
}: {
  config: Config | null;
  sims: IosSimRecord[];
  avds: string[];
  sweep: WorktreeSweep | null | undefined;
  now?: number;
}): FinishedDevice[] {
  const keys = Object.keys(config?.projects ?? {});
  const devices: FinishedDevice[] = [];
  const seen = new Set<string>();
  for (const { root, reason } of finishedWorkspaces(sweep, now)) {
    const key = keys.find((candidate) => canonicalPath(candidate) === root);
    const project = key ? config?.projects[key] : undefined;
    if (!config || !key || !project || seen.has(key)) continue;
    seen.add(key);
    for (const { idleDays: _idleDays, ...device } of findStaleProjectDevices({
      config: { ...config, projects: { [key]: project } },
      sims,
      avds,
      olderThanDays: 0,
      lastTouched: () => 0,
    }))
      devices.push({ ...device, reason });
  }
  return devices;
}

export interface OwnedDeviceDisk {
  kind: 'ios' | 'android';
  count: number;
  bytes: number;
  /** Owned devices whose disk could not be measured; `bytes` leaves them out. */
  unmeasured: number;
}

/** Owned simulator and emulator disk of registered workspaces, by platform. */
export function ownedDeviceDisk(
  usage: readonly OwnedDeviceUsage[],
  unmeasured: Partial<Record<'ios' | 'android', number>> = {},
): OwnedDeviceDisk[] {
  return (['ios', 'android'] as const).flatMap((kind) => {
    const owned = usage.filter((device) => device.kind === kind && device.workspace);
    const missing = unmeasured[kind] ?? 0;
    return owned.length || missing
      ? [
          {
            kind,
            count: owned.length,
            bytes: owned.reduce((sum, device) => sum + device.bytes, 0),
            unmeasured: missing,
          },
        ]
      : [];
  });
}
