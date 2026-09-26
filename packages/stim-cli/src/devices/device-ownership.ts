import { loadConfig } from '@stim-cli/core/state';
import { readCreatedDevices } from './created-devices.ts';

type DevicePlatform = 'ios' | 'android';
import { projectDeviceSlots } from './device-slots.ts';
import { readParked } from './sim-pool.ts';

function recordedAsOwned(platform: DevicePlatform, id: string): boolean {
  const config = loadConfig();
  if (!config) return false;
  const parked =
    platform === 'ios'
      ? readParked('ios', { config }).some((sim) => sim.udid === id)
      : readParked('android', { config }).some((avd) => avd.name === id);
  if (parked) return true;
  for (const project of Object.values(config.projects ?? {})) {
    let slots: ReturnType<typeof projectDeviceSlots>;
    try {
      slots = projectDeviceSlots(project);
    } catch {
      continue;
    }
    for (const { platforms } of slots) {
      const record = platforms[platform];
      if (record?.owned && (platform === 'ios' ? record.deviceUdid : record.avdName) === id) return true;
    }
  }
  return false;
}

function isStimOwnedDevice(platform: DevicePlatform, id: string): boolean {
  return readCreatedDevices()[platform].has(id) || recordedAsOwned(platform, id);
}

export function isStimOwnedSim(sim: { udid: string; name?: string | null }): boolean {
  return (sim.name ?? '').startsWith('stim-') && isStimOwnedDevice('ios', sim.udid);
}

export function isStimOwnedAvd(name: string): boolean {
  return name.startsWith('stim-') && isStimOwnedDevice('android', name);
}
