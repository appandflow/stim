import type { StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import {
  createActivityReader,
  createActivityReaderAsync,
  type ActivityTarget,
  type DeviceActivity,
} from '../../devices/activity.ts';
import { ownedAvdSerialResolver, ownedAvdSerialResolverAsync } from '../../devices/android.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import type { IosSimRecord } from '../../devices/ios.ts';
import { ACTIVE_BUILD_KEY, activeBuildState, parseActiveBuild } from '../../engine/build-progress.ts';
import type { Config } from '../../workspace/config.ts';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';

interface DeviceActivityInputs {
  config: Config | null;
  sims: readonly IosSimRecord[];
  androidSerial: (avdName: string) => string | null;
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

function findOwnedDeviceActivity<T>({
  config,
  sims,
  androidSerial,
  readActivity,
  deadProjects = [],
}: DeviceActivityInputs & {
  readActivity: (target: ActivityTarget) => T;
}): (Omit<OwnedDeviceActivity, 'activity'> & { activity: T })[] {
  const booted = new Map(sims.filter((sim) => sim.state === 'Booted').map((sim) => [sim.udid, sim.name]));
  const dead = new Set(deadProjects);
  const found: (Omit<OwnedDeviceActivity, 'activity'> & { activity: T })[] = [];
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

export function workspaceBuildInProgress(project: string): boolean {
  const record = parseActiveBuild(readWorkspaceState(project)?.[ACTIVE_BUILD_KEY]);
  if (!record) return false;
  try {
    return activeBuildState(record.claim) !== 'stale';
  } catch {
    return true;
  }
}

function deviceActivityInputs(
  config: Config | null,
  sims: readonly IosSimRecord[],
  now: number,
  env?: NodeJS.ProcessEnv,
) {
  const resolve = ownedAvdSerialResolver({ timeoutMs: 5000 });
  return {
    config,
    sims,
    readActivity: createActivityReader({ now, env }),
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
  env?: NodeJS.ProcessEnv,
): OwnedDeviceActivity[] {
  return findOwnedDeviceActivity(deviceActivityInputs(config, sims, now, env));
}

async function deviceActivityInputsAsync(
  config: Config | null,
  sims: readonly IosSimRecord[],
  now: number,
  env?: NodeJS.ProcessEnv,
  deadProjects: readonly string[] = [],
  signal?: AbortSignal,
  operation?: StimContext,
) {
  const resolve = ownedAvdSerialResolverAsync({ timeoutMs: 5000, signal, operation });
  const serials = new Map<string, string | null>();
  for (const [project, record] of Object.entries(config?.projects ?? {})) {
    signal?.throwIfAborted();
    if (deadProjects.includes(project)) continue;
    for (const { platforms } of projectDeviceSlots(record)) {
      const android = platforms.android;
      if (!android?.owned || !android.avdName || serials.has(android.avdName)) continue;
      try {
        serials.set(android.avdName, (await resolve(android.avdName)).serial ?? null);
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        signal?.throwIfAborted();
        serials.set(android.avdName, null);
      }
    }
  }
  return {
    config,
    sims,
    readActivity: createActivityReaderAsync({ now, env, signal, operation }),
    androidSerial: (name: string) => serials.get(name) ?? null,
  };
}

export async function collectOwnedDeviceActivityAsync(
  config: Config | null,
  sims: readonly IosSimRecord[],
  now: number = Date.now(),
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<OwnedDeviceActivity[]> {
  const devices = findOwnedDeviceActivity(
    await deviceActivityInputsAsync(config, sims, now, env, [], signal, operation),
  );
  const results = await Promise.allSettled(
    devices.map(async (device) => Object.assign({}, device, { activity: await device.activity })),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
