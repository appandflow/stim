import { deviceShellArg } from './app-install.ts';
import { fileLeaseIo } from './device-lease.ts';
import { getProject } from '../workspace/config.ts';
import { parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { resolveOwnedAvdSerial } from '../devices/android.ts';
import { listBootedIosSims } from '../devices/ios.ts';
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

function ownedDeviceRunning(platform: 'ios' | 'android'): (device: DeviceRecord) => boolean {
  if (platform === 'android')
    return (device) => typeof device.avdName === 'string' && Boolean(resolveOwnedAvdSerial(device.avdName).serial);
  let booted: Set<string> | null = null;
  return (device) => {
    booted ??= new Set(listBootedIosSims().map((sim) => sim.udid));
    return typeof device.deviceUdid === 'string' && booted.has(device.deviceUdid);
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
