import {
  hostedNativeRecords,
  parseHostedNativePlacement,
  unreadableHostedNative,
  HOSTED_METRO_REQUESTS_KEY,
  hostedMetroRequests,
  isJsonObject,
  type HostedIosPlacement,
  type HostedAndroidPlacement,
  type HostedNativePlacement,
  type HostedIosDevice,
  type HostedAndroidDevice,
} from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

export function readHostedNative(
  root: string,
  platform: 'ios' | 'android',
  slot?: string,
): Record<string, HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>> {
  const state = readWorkspaceState(root);
  if (slot !== undefined) {
    const record = hostedNativeRecords(state, platform)[slot];
    if (record !== undefined && !parseHostedNativePlacement(record, platform))
      throw Object.assign(new Error(unreadableHostedNative(slot, platform)), {
        code: 'STIM_HOSTING_REFUSED',
        remedy: `Restore that slot's recorded machine and session from the host, then run stim stop${slot === 'default' ? '' : ` --slot ${slot}`} to reconcile it.`,
      });
  }
  const placements = Object.fromEntries(
    Object.entries(hostedNativeRecords(state, platform)).flatMap(([name, record]) => {
      const placement = parseHostedNativePlacement(record, platform);
      return placement ? [[name, placement]] : [];
    }),
  );
  return slot === undefined ? placements : placements[slot] ? { [slot]: placements[slot] } : {};
}

export function writeHostedNative(
  root: string,
  slot: string,
  host: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | null,
  platform: 'ios' | 'android',
): void {
  updateWorkspaceState(root, (state) => {
    const slots = isJsonObject(state.deviceSlots) ? state.deviceSlots : {};
    const current =
      slot === 'default' ? state[platform] : isJsonObject(slots[slot]) ? slots[slot][platform] : undefined;
    const record = isJsonObject(current) ? { ...current } : {};
    const previous = parseHostedNativePlacement(record.host, platform);
    if (previous && previous.session !== host?.session) {
      const requests = { ...hostedMetroRequests(state) };
      delete requests[previous.session];
      state = { ...state, [HOSTED_METRO_REQUESTS_KEY]: requests };
    }
    if (host) record.host = host;
    else delete record.host;
    return slot === 'default'
      ? { ...state, [platform]: record }
      : {
          ...state,
          deviceSlots: { ...slots, [slot]: { ...(isJsonObject(slots[slot]) ? slots[slot] : {}), [platform]: record } },
        };
  });
}

export function readHostedIos(root: string, slot?: string): Record<string, HostedIosPlacement> {
  return readHostedNative(root, 'ios', slot) as Record<string, HostedIosPlacement>;
}
export function writeHostedIos(root: string, slot: string, host: HostedIosPlacement | null): void {
  writeHostedNative(root, slot, host, 'ios');
}
export function readHostedAndroid(root: string, slot?: string): Record<string, HostedAndroidPlacement> {
  return readHostedNative(root, 'android', slot) as Record<string, HostedAndroidPlacement>;
}
export function writeHostedAndroid(root: string, slot: string, host: HostedAndroidPlacement | null): void {
  writeHostedNative(root, slot, host, 'android');
}
