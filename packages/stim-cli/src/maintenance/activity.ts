import { DEVICE_LIST_TIMEOUT_MS } from '../commands/gc/devices.ts';
import {
  collectOwnedDeviceActivity,
  collectOwnedDeviceActivityAsync,
  workspaceBuildInProgress,
  type OwnedDeviceActivity,
} from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { workspaceActivity } from '../devices/activity.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSims, listAllIosSimsAsync, type IosSimRecord } from '../devices/ios.ts';
import { leaseIsExpired, listLeaseFiles } from '../engine/device-lease.ts';
import { loadConfig } from '../workspace/config.ts';
import { workspaceLastUsed } from '../workspace/workspace-state.ts';

/** The activity of every owned device, read with or without a simulator listing; it throws when that listing fails. */
type DeviceActivityReader = (withSims: boolean) => OwnedDeviceActivity[];

function readDeviceActivity(withSims: boolean, now: number): OwnedDeviceActivity[] {
  const sims: IosSimRecord[] = withSims ? listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }) : [];
  return collectOwnedDeviceActivity(loadConfig(), sims, now);
}

/** A reader that reads device activity at most once per kind and reuses the answer, including a failure. */
export function cachedDeviceActivity(now: number): DeviceActivityReader {
  const answers = new Map<boolean, { devices: OwnedDeviceActivity[] } | { error: unknown }>();
  return (withSims) => {
    let answer = answers.get(withSims);
    if (!answer) {
      try {
        answer = { devices: readDeviceActivity(withSims, now) };
      } catch (error) {
        answer = { error };
      }
      answers.set(withSims, answer);
    }
    if ('error' in answer) throw answer.error;
    return answer.devices;
  };
}

export function cachedDeviceActivityAsync(
  now: number,
  env: NodeJS.ProcessEnv,
): (withSims: boolean) => Promise<OwnedDeviceActivity[]> {
  const answers = new Map<boolean, Promise<OwnedDeviceActivity[]>>();
  return (withSims) => {
    let answer = answers.get(withSims);
    if (!answer) {
      answer = (async () => {
        const sims = withSims ? await listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }) : [];
        return collectOwnedDeviceActivityAsync(loadConfig(), sims, now, env);
      })();
      answers.set(withSims, answer);
    }
    return answer;
  };
}

function* workspaceActiveChecks(
  root: string,
  now: number,
  windowMs: number,
): Generator<boolean, string | null, OwnedDeviceActivity[]> {
  if (workspaceBuildInProgress(root)) return 'a build is in progress';
  const holder = canonicalPath(root);
  for (const { lease } of listLeaseFiles())
    if (lease && !leaseIsExpired(lease, now) && canonicalPath(lease.holder) === holder)
      return `it holds the ${lease.platform} device lease on ${lease.deviceName ?? lease.id}`;
  const owned = ownedPlatforms(root);
  if (owned.ios || owned.android) {
    let devices: OwnedDeviceActivity[];
    try {
      devices = yield owned.ios;
    } catch {
      return 'its owned devices cannot be listed to prove them idle';
    }
    const busy = devices.find((device) => device.project === root && device.activity.state !== 'idle');
    if (busy) return `its owned ${busy.kind} device ${busy.name} is ${busy.activity.state}`;
  }
  const activity = workspaceActivity(root, now);
  if (activity.state !== 'idle') return `its activity is ${activity.state}`;
  const known = [Date.parse(activity.lastActivityAt ?? ''), workspaceLastUsed(root)].filter(Number.isFinite);
  if (!known.length) return 'its last activity is unknown';
  const last = Math.max(...known);
  return now - last < windowMs ? usedWithin(windowMs) : null;
}

/** Why a workspace is not inactive for the pressure window, or null when maintenance may stop it. */
export function workspaceActiveReason(
  root: string,
  now: number,
  windowMs: number,
  devices: DeviceActivityReader = (withSims) => readDeviceActivity(withSims, now),
): string | null {
  const checks = workspaceActiveChecks(root, now, windowMs);
  let step = checks.next();
  while (!step.done) {
    try {
      step = checks.next(devices(step.value));
    } catch (error) {
      step = checks.throw(error);
    }
  }
  return step.value;
}

export async function workspaceActiveReasonAsync(
  root: string,
  now: number,
  windowMs: number,
  devices: (withSims: boolean) => Promise<OwnedDeviceActivity[]>,
): Promise<string | null> {
  const checks = workspaceActiveChecks(root, now, windowMs);
  let step = checks.next();
  while (!step.done) {
    try {
      step = checks.next(await devices(step.value));
    } catch (error) {
      step = checks.throw(error);
    }
  }
  return step.value;
}

function ownedPlatforms(root: string): { ios: boolean; android: boolean } {
  try {
    const slots = projectDeviceSlots(loadConfig()?.projects?.[root]);
    return {
      ios: slots.some(({ platforms }) => platforms.ios?.owned === true),
      android: slots.some(({ platforms }) => platforms.android?.owned === true),
    };
  } catch {
    return { ios: true, android: true };
  }
}

export function hasOwnedDevices(root: string): boolean {
  try {
    return projectDeviceSlots(loadConfig()?.projects?.[root]).some(
      ({ platforms }) => platforms.ios?.owned === true || platforms.android?.owned === true,
    );
  } catch {
    return false;
  }
}

export function usedWithin(windowMs: number): string {
  return `used within the last ${Math.round(windowMs / 60_000)} minutes`;
}
