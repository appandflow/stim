import { deviceShellArg } from './app-install.ts';
import { fileLeaseIo } from './device-lease.ts';
import { getProject } from '../workspace/config.ts';
import { parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { getAvdNameForSerial, listAdbDevices } from '../devices/android.ts';
import { listAllIosSims } from '../devices/ios.ts';
import type { DeviceRecord } from '@stim-cli/core/state';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

export function launchSlotScope(root: string, slot = 'default'): string | undefined {
  if (slot !== 'default') return slot;
  if (Object.keys(getProject(root)?.deviceSlots ?? {}).length) return slot;
  const state = readWorkspaceState(root);
  if (Object.keys({ ...state?.collectors, ...fileLeaseIo.readHolder(root) }).some((key) => key.includes(':')))
    return slot;
  return undefined;
}

const DEVICE_LISTING_TIMEOUT_MS = 5000;

function ownedDeviceRunning(platform: 'ios' | 'android'): (device: DeviceRecord) => boolean {
  let listing: ((device: DeviceRecord) => boolean) | null = null;
  const list = (): ((device: DeviceRecord) => boolean) => {
    if (platform === 'android') {
      const { emulators, unhealthy } = listAdbDevices({ timeoutMs: DEVICE_LISTING_TIMEOUT_MS });
      const names: string[] = [];
      for (const entry of [...emulators, ...unhealthy.filter((candidate) => candidate.kind === 'emulator')]) {
        const name = getAvdNameForSerial(entry.serial, { timeoutMs: DEVICE_LISTING_TIMEOUT_MS });
        if (name === null) return () => true;
        names.push(name);
      }
      return (device) => typeof device.avdName === 'string' && names.includes(device.avdName);
    }
    const booted = new Set(
      listAllIosSims({ timeoutMs: DEVICE_LISTING_TIMEOUT_MS })
        .filter((sim) => sim.state === 'Booted')
        .map((sim) => sim.udid),
    );
    return (device) => typeof device.deviceUdid === 'string' && booted.has(device.deviceUdid);
  };
  return (device) => {
    try {
      listing ??= list();
      return listing(device);
    } catch {
      listing = () => true;
      return true;
    }
  };
}

export function siblingPlatformSlots(
  root: string,
  platform: 'ios' | 'android',
  slot = 'default',
  { deviceRunning = ownedDeviceRunning(platform) }: { deviceRunning?: (device: DeviceRecord) => boolean } = {},
): string[] {
  const slots = new Set<string>();
  const state = readWorkspaceState(root);
  for (const key of Object.keys({ ...state?.collectors, ...fileLeaseIo.readHolder(root) })) {
    const parsed = parseDeviceSlotKey(key);
    if (parsed?.platform === platform) slots.add(parsed.slot);
  }
  for (const { slot: other, platforms } of projectDeviceSlots(getProject(root))) {
    const device = platforms[platform];
    if (other !== slot && !slots.has(other) && device && deviceRunning(device)) slots.add(other);
  }
  slots.delete(slot);
  return [...slots].toSorted();
}

export function nativeRunCommand(
  platform: 'ios' | 'android',
  slot = 'default',
  { physical, deviceId }: { physical?: boolean; deviceId?: string } = {},
): string {
  return `stim ${platform}${slot === 'default' ? '' : ` --slot ${slot}`}${physical && deviceId ? ` --device ${deviceShellArg(deviceId)}` : ''}`;
}
