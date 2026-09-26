import { deviceShellArg } from './app-install.ts';
import { fileLeaseIo } from './device-lease.ts';
import { getProject } from '../workspace/config.ts';
import { parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

export function launchSlotScope(root: string, slot = 'default'): string | undefined {
  if (slot !== 'default') return slot;
  if (Object.keys(getProject(root)?.deviceSlots ?? {}).length) return slot;
  const state = readWorkspaceState(root);
  if (Object.keys({ ...state?.collectors, ...fileLeaseIo.readHolder(root) }).some((key) => key.includes(':')))
    return slot;
  return undefined;
}

/** The workspace's other slots that hold a device of this platform; they share its Metro. */
export function siblingPlatformSlots(root: string, platform: 'ios' | 'android', slot = 'default'): string[] {
  const slots = new Set<string>();
  for (const { slot: other, platforms } of projectDeviceSlots(getProject(root))) {
    if (platforms[platform]) slots.add(other);
  }
  const state = readWorkspaceState(root);
  for (const key of Object.keys({ ...state?.collectors, ...fileLeaseIo.readHolder(root) })) {
    const parsed = parseDeviceSlotKey(key);
    if (parsed?.platform === platform) slots.add(parsed.slot);
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
