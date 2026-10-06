import {
  hostedIosPlacements,
  hostedIosRecords,
  parseHostedIosPlacement,
  unreadableHostedIos,
  HOSTED_METRO_REQUESTS_KEY,
  hostedMetroRequests,
  isJsonObject,
  type HostedIosPlacement,
} from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

export function readHostedIos(root: string): Record<string, HostedIosPlacement> {
  const state = readWorkspaceState(root);
  for (const [slot, record] of Object.entries(hostedIosRecords(state))) {
    if (!parseHostedIosPlacement(record))
      throw Object.assign(new Error(unreadableHostedIos(slot)), { code: 'STIM_HOSTING_REFUSED' });
  }
  return hostedIosPlacements(state);
}

export function writeHostedIos(root: string, slot: string, host: HostedIosPlacement | null): void {
  updateWorkspaceState(root, (state) => {
    const slots = isJsonObject(state.deviceSlots) ? state.deviceSlots : {};
    const current = slot === 'default' ? state.ios : isJsonObject(slots[slot]) ? slots[slot].ios : undefined;
    const record = isJsonObject(current) ? { ...current } : {};
    const previous = parseHostedIosPlacement(record.host);
    if (previous && previous.session !== host?.session) {
      const requests = { ...hostedMetroRequests(state) };
      delete requests[previous.session];
      state = { ...state, [HOSTED_METRO_REQUESTS_KEY]: requests };
    }
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
