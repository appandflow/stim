import { deviceShellArg } from './app-install.ts';
import { fileLeaseIo } from './device-lease.ts';
import { getProject } from '../config.ts';
import { readWorkspaceState } from '../supervisor/state.ts';

export function launchSlotScope(root: string, slot = 'default'): string | undefined {
  if (slot !== 'default') return slot;
  if (Object.keys(getProject(root)?.deviceSlots ?? {}).length) return slot;
  const state = readWorkspaceState(root);
  if (Object.keys({ ...state?.collectors, ...fileLeaseIo.readHolder(root) }).some((key) => key.includes(':')))
    return slot;
  return undefined;
}

export function nativeRunCommand(
  platform: 'ios' | 'android',
  slot = 'default',
  { physical, deviceId }: { physical?: boolean; deviceId?: string } = {},
): string {
  return `stim ${platform}${slot === 'default' ? '' : ` --slot ${slot}`}${physical && deviceId ? ` --device ${deviceShellArg(deviceId)}` : ''}`;
}
