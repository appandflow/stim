import chalk from 'chalk';
import type { Config } from '@stim-cli/core/state';
import type { IosSimRecord } from '../../devices/ios.ts';
import { formatBytes } from '../../fs-util.ts';
import { deleteIdleWorkspaceDevices } from '../../maintenance/act.ts';
import { finishedWorkspaces, type OwnedDeviceUsage } from '../../maintenance/devices.ts';
import { triggeringRoot } from '../../maintenance/preview.ts';
import { findStaleProjectDevices } from './devices.ts';
import { canonicalPath } from './paths.ts';
import { recordGcResult } from './results.ts';
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

export function finishedDeviceLines(devices: readonly FinishedDevice[] = []): string[] {
  if (!devices.length) return [];
  const lines = [
    `Owned devices of finished worktrees (${devices.length}) - the worktree is kept, its devices are not:`,
  ];
  for (const device of devices) {
    lines.push(`  ${device.kind} ${device.name} (${device.id})${device.bytes ? ` ${formatBytes(device.bytes)}` : ''}`);
    lines.push(`              ${device.project}: ${device.reason}`);
  }
  lines.push('              --delete keeps a workspace that is in use, leased, driven, locked or pinned.');
  return lines;
}

export async function deleteFinishedDevices({
  finishedDevices: devices,
  worktreeSweep,
}: {
  finishedDevices: readonly FinishedDevice[];
  worktreeSweep?: WorktreeSweep | null;
}): Promise<number> {
  const graceMs = worktreeSweep?.graceMs ?? 0;
  let failures = 0;
  for (const project of new Set(devices.map((device) => device.project))) {
    const outcome = await deleteIdleWorkspaceDevices(canonicalPath(project), {
      windowMs: graceMs,
      protectedRoot: triggeringRoot(),
      purpose: 'stim gc --delete',
    });
    if (outcome.status === 'kept') {
      console.log(chalk.yellow(`Kept the owned devices of ${project}: ${outcome.detail}`));
      recordGcResult('device', 'kept', project, { detail: outcome.detail });
    } else if (outcome.status === 'failed') {
      failures++;
      console.log(chalk.red(`Could not delete the owned devices of ${project}: ${outcome.detail}`));
      recordGcResult('device', 'failed', project, { detail: outcome.detail });
    }
  }
  return failures;
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

export function ownedDeviceDiskLines(disk: readonly OwnedDeviceDisk[] = []): string[] {
  if (!disk.length) return [];
  const parts = disk.map(
    ({ kind, count, bytes, unmeasured }) =>
      `${count} ${kind === 'ios' ? 'simulators' : 'emulators'} ${formatBytes(bytes)}${unmeasured ? ` (${unmeasured} not measured)` : ''}`,
  );
  return [`Owned device disk: ${parts.join(', ')}`];
}
