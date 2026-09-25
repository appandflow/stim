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

export interface OwnedDeviceActivity {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  project: string;
  slot: string;
  activity: DeviceActivity;
}

function findOwnedDeviceActivity({
  config,
  sims,
  androidSerial,
  readActivity,
  deadProjects = [],
}: Omit<IdleDeviceInputs, 'buildInProgress' | 'now'>): OwnedDeviceActivity[] {
  const booted = new Map(sims.filter((sim) => sim.state === 'Booted').map((sim) => [sim.udid, sim.name]));
  const dead = new Set(deadProjects);
  const found: OwnedDeviceActivity[] = [];
  for (const [project, record] of Object.entries(config?.projects ?? {})) {
    if (dead.has(project)) continue;
    for (const { slot, platforms } of projectDeviceSlots(record)) {
      const ios = platforms.ios;
      if (ios?.owned && ios.deviceUdid && booted.has(ios.deviceUdid)) {
        found.push({
          kind: 'ios',
          id: ios.deviceUdid,
          name: booted.get(ios.deviceUdid) ?? ios.deviceUdid,
          project,
          slot,
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
          project,
          slot,
          activity: readActivity({ platform: 'android', id: serial, slot, workspace: project }),
        });
      }
    }
  }
  return found;
}

export function findIdleDevices({ buildInProgress, now, ...inputs }: IdleDeviceInputs): IdleDevice[] {
  return findOwnedDeviceActivity(inputs)
    .filter((device) => device.activity.state === 'idle')
    .map(({ kind, id, name, project, slot, activity }) => ({
      kind,
      id,
      name,
      project,
      slot,
      lastActivityAt: activity.lastActivityAt ?? null,
      idleForMs: idleForMs(activity, now),
      buildInProgress: buildInProgress(project),
    }));
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

export function workspaceBuildInProgress(project: string): boolean {
  const record = parseActiveBuild(readWorkspaceState(project)?.[ACTIVE_BUILD_KEY]);
  if (!record) return false;
  try {
    return activeBuildState(record.claim) !== 'stale';
  } catch {
    return true;
  }
}

function deviceActivityInputs(config: Config | null, sims: readonly IosSimRecord[], now: number) {
  const resolve = ownedAvdSerialResolver({ timeoutMs: 5000 });
  return {
    config,
    sims,
    readActivity: createActivityReader({ now }),
    androidSerial: (avdName: string) => {
      try {
        return resolve(avdName).serial ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function collectOwnedDeviceActivity(
  config: Config | null,
  sims: readonly IosSimRecord[],
  now: number = Date.now(),
): OwnedDeviceActivity[] {
  return findOwnedDeviceActivity(deviceActivityInputs(config, sims, now));
}

export function collectIdleDevices(
  config: Config | null,
  sims: readonly IosSimRecord[],
  deadProjects: readonly string[],
  now: number = Date.now(),
): IdleDevice[] {
  return findIdleDevices({
    ...deviceActivityInputs(config, sims, now),
    deadProjects,
    now,
    buildInProgress: workspaceBuildInProgress,
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
): { failures: number; shutDown: IdleDevice[] } {
  const candidates = idleShutdownCandidates(devices, idleMs);
  const shutDown: IdleDevice[] = [];
  if (candidates.length === 0) {
    console.log(chalk.dim(`No owned device has been idle for ${formatLongDuration(idleMs)} or more.`));
    return { failures: 0, shutDown };
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
      shutDown.push(device);
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
  return { failures, shutDown };
}
