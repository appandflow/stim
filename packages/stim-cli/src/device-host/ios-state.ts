import { hostedIosPlacements, isJsonObject, type HostedIosPlacement } from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

export function readHostedIos(root: string): Record<string, HostedIosPlacement> {
  return hostedIosPlacements(readWorkspaceState(root));
}

export function writeHostedIos(root: string, slot: string, host: HostedIosPlacement | null): void {
  updateWorkspaceState(root, (state) => {
    const slots = isJsonObject(state.deviceSlots) ? state.deviceSlots : {};
    const current = slot === 'default' ? state.ios : isJsonObject(slots[slot]) ? slots[slot].ios : undefined;
    const record = isJsonObject(current) ? { ...current } : {};
    if (host) record.host = host;
    else delete record.host;
    return slot === 'default'
      ? { ...state, ios: record }
      : {
          ...state,
          deviceSlots: { ...slots, [slot]: { ...(isJsonObject(slots[slot]) ? slots[slot] : {}), ios: record } },
        };
  });
}
