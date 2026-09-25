import chalk from 'chalk';
import { formatLongDuration } from '../../command-output.ts';
import { createActivityReader, idleForMs, type ActivityTarget, type DeviceActivity } from '../../devices/activity.ts';
import { ownedAvdSerialResolver } from '../../devices/android.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import type { IosSimRecord } from '../../devices/ios.ts';
import { teardownOwnedAvd, teardownOwnedIosSim } from '../../devices/teardown.ts';
import { ACTIVE_BUILD_KEY, activeBuildState, parseActiveBuild } from '../../engine/build-progress.ts';
import type { Config } from '../../workspace/config.ts';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';

export interface IdleDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  project: string;
  slot: string;
  lastActivityAt: string | null;
  idleForMs: number | null;
  buildInProgress: boolean;
}

export interface IdleDeviceInputs {
  config: Config | null;
  sims: readonly IosSimRecord[];
  androidSerial: (avdName: string) => string | null;
  readActivity: (target: ActivityTarget) => DeviceActivity;
  buildInProgress: (project: string) => boolean;
  now: number;
  deadProjects?: readonly string[];
}

export function findIdleDevices({
  config,
  sims,
  androidSerial,
  readActivity,
  buildInProgress,
  now,
  deadProjects = [],
}: IdleDeviceInputs): IdleDevice[] {
  const booted = new Map(sims.filter((sim) => sim.state === 'Booted').map((sim) => [sim.udid, sim.name]));
  const dead = new Set(deadProjects);
  const idle: IdleDevice[] = [];
  for (const [project, record] of Object.entries(config?.projects ?? {})) {
    if (dead.has(project)) continue;
    for (const { slot, platforms } of projectDeviceSlots(record)) {
      const found: { kind: IdleDevice['kind']; id: string; name: string; activity: DeviceActivity }[] = [];
      const ios = platforms.ios;
      if (ios?.owned && ios.deviceUdid && booted.has(ios.deviceUdid)) {
        found.push({
          kind: 'ios',
          id: ios.deviceUdid,
          name: booted.get(ios.deviceUdid) ?? ios.deviceUdid,
          activity: readActivity({ platform: 'ios', id: ios.deviceUdid, slot, workspace: project }),
        });
      }
      const android = platforms.android;
      const serial = android?.owned && android.avdName ? androidSerial(android.avdName) : null;
      if (android?.avdName && serial) {
        found.push({
          kind: 'android',
          id: android.avdName,
          name: android.avdName,
          activity: readActivity({ platform: 'android', id: serial, slot, workspace: project }),
        });
      }
      for (const device of found) {
        if (device.activity.state !== 'idle') continue;
        idle.push({
          kind: device.kind,
          id: device.id,
          name: device.name,
          project,
          slot,
          lastActivityAt: device.activity.lastActivityAt ?? null,
          idleForMs: idleForMs(device.activity, now),
          buildInProgress: buildInProgress(project),
        });
      }
    }
  }
  return idle;
}

export function idleShutdownCandidates(devices: readonly IdleDevice[], idleMs: number): IdleDevice[] {
  return devices.filter((d) => !d.buildInProgress && d.idleForMs !== null && d.idleForMs >= idleMs);
}

export function parseIdleDuration(value: string): number | null {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(value.trim());
  if (!match) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

function workspaceBuildInProgress(project: string): boolean {
  const record = parseActiveBuild(readWorkspaceState(project)?.[ACTIVE_BUILD_KEY]);
  if (!record) return false;
  try {
    return activeBuildState(record.claim) !== 'stale';
  } catch {
    return true;
  }
}

export function collectIdleDevices(
  config: Config | null,
  sims: readonly IosSimRecord[],
  deadProjects: readonly string[],
  now: number = Date.now(),
): IdleDevice[] {
  const resolve = ownedAvdSerialResolver({ timeoutMs: 5000 });
  return findIdleDevices({
    config,
    sims,
    deadProjects,
    now,
    readActivity: createActivityReader({ now }),
    buildInProgress: workspaceBuildInProgress,
    androidSerial: (avdName) => {
      try {
        return resolve(avdName).serial ?? null;
      } catch {
        return null;
      }
    },
  });
}

export function idleDeviceLines(devices: readonly IdleDevice[]): string[] {
  if (devices.length === 0) return [];
  return [
    `Idle owned devices (${devices.length}) - booted with no driver, claim, or recent activity:`,
    ...devices.map((d) => {
      const slot = d.slot === 'default' ? '' : ` [${d.slot}]`;
      const idle = d.idleForMs === null ? 'idle for an unknown time' : `idle ${formatLongDuration(d.idleForMs)}`;
      const build = d.buildInProgress ? ', build in progress' : '';
      return `  ${d.kind}${slot} ${d.name} (${d.project}) -- ${idle}${build}`;
    }),
  ];
}

export function shutDownIdleDevices(
  devices: readonly IdleDevice[],
  idleMs: number,
  recollect: () => IdleDevice[],
): number {
  const candidates = idleShutdownCandidates(devices, idleMs);
  if (candidates.length === 0) {
    console.log(chalk.dim(`No owned device has been idle for ${formatLongDuration(idleMs)} or more.`));
    return 0;
  }
  const fresh = idleShutdownCandidates(recollect(), idleMs);
  let failures = 0;
  for (const device of candidates) {
    const what = `${device.kind} ${device.name}`;
    const current = fresh.find(
      (d) => d.kind === device.kind && d.id === device.id && d.project === device.project && d.slot === device.slot,
    );
    if (!current) {
      console.log(chalk.dim(`Kept ${what}: it is no longer idle for ${formatLongDuration(idleMs)}.`));
      continue;
    }
    const outcome =
      device.kind === 'ios'
        ? teardownOwnedIosSim(device.id, { label: device.name })
        : teardownOwnedAvd(device.id, { owner: { projectPath: device.project, slot: device.slot } });
    if (outcome.status === 'torn-down') {
      console.log(chalk.green(`Shut down ${what}, idle ${formatLongDuration(current.idleForMs)}`));
    } else if (outcome.status === 'missing') {
      console.log(chalk.dim(`${what} is already gone; nothing to shut down.`));
    } else if (outcome.status === 'skipped') {
      console.log(chalk.yellow(`Skipped ${what}: ${outcome.reason}`));
    } else {
      failures++;
      console.log(chalk.red(`Failed to shut down ${what}: ${outcome.reason}`));
    }
  }
  return failures;
}
