import { parseHostedAgentAccess, type HostedAgentAccess } from './hosted-macos.ts';
import { isJsonObject } from './json-file.ts';
import { parseHostedPlatformDevice, type HostedAndroidDevice, type HostedIosDevice } from './device-host.ts';
import { parseMachine } from './tailnet.ts';
import type { WorkspaceState } from './workspace-state.ts';

export interface HostedNativePlacement<D> {
  machine: string;
  session: string;
  appAttempt: string;
  device: D | null;
  selected: string;
  agent: HostedAgentAccess;
}

export function parseHostedNativePlacement(
  value: unknown,
  platform: 'ios',
): HostedNativePlacement<HostedIosDevice> | null;
export function parseHostedNativePlacement(
  value: unknown,
  platform: 'android',
): HostedNativePlacement<HostedAndroidDevice> | null;
export function parseHostedNativePlacement(
  value: unknown,
  platform: 'ios' | 'android',
): HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | null;
export function parseHostedNativePlacement(
  value: unknown,
  platform: 'ios' | 'android',
): HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | null {
  if (
    !isJsonObject(value) ||
    typeof value.machine !== 'string' ||
    !parseMachine(value.machine) ||
    typeof value.session !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.session)
  )
    return null;
  return {
    machine: value.machine,
    session: value.session,
    appAttempt:
      typeof value.appAttempt === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.appAttempt) ? value.appAttempt : '',
    selected: value.machine,
    device: parseHostedPlatformDevice(value.device, platform) as HostedIosDevice | HostedAndroidDevice | null,
    agent: parseHostedAgentAccess(value.agent) ?? { driver: 'none', setting: 'hosting.agentDriver' },
  };
}

export function hostedNativeRecords(
  state: WorkspaceState | null,
  platform: 'ios' | 'android',
): Record<string, unknown> {
  const slots = isJsonObject(state?.deviceSlots) ? state.deviceSlots : {};
  const records = {
    default: state?.[platform],
    ...Object.fromEntries(
      Object.entries(slots).map(([slot, value]) => [slot, isJsonObject(value) ? value[platform] : undefined]),
    ),
  };
  return Object.fromEntries(
    Object.entries(records).flatMap(([slot, record]) =>
      isJsonObject(record) && record.host !== undefined ? [[slot, record.host]] : [],
    ),
  );
}

export function unreadableHostedNative(slot: string, platform: 'ios' | 'android'): string {
  const key = slot === 'default' ? `${platform}.host` : `deviceSlots.${slot}.${platform}.host`;
  return `The hosted ${platform === 'ios' ? 'iOS' : 'Android'} placement at workspace-state key ${key} is unreadable. Inspect ${key}.machine and ${key}.session before reconciling it.`;
}
