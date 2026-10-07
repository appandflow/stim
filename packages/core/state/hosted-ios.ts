import { type HostedIosDevice } from './device-host.ts';
import {
  type HostedNativePlacement,
  hostedNativeRecords,
  parseHostedNativePlacement,
  unreadableHostedNative,
} from './hosted-native.ts';
import type { WorkspaceState } from './workspace-state.ts';

/** A workspace slot's placement; null device means its reservation has not reached ready yet. */
export interface HostedIosPlacement extends HostedNativePlacement<HostedIosDevice> {}

/** Public hosting facts; the host's UDID and private Metro gateway are excluded. */
export type HostedIosStatus = Pick<HostedIosPlacement, 'machine' | 'session' | 'selected' | 'agent'> & {
  device: { name: string; runtime: string } | null;
  /** The latest session probe in status, independent of a conflicting local simulator's state. */
  state?: string;
};

export function parseHostedIosPlacement(value: unknown): HostedIosPlacement | null {
  return parseHostedNativePlacement(value, 'ios');
}

export function hostedIosStatus(placement: HostedIosPlacement): HostedIosStatus {
  return {
    machine: placement.machine,
    session: placement.session,
    selected: placement.selected,
    agent: placement.agent,
    device: placement.device ? { name: placement.device.deviceType, runtime: placement.device.runtime } : null,
  };
}

export function hostedIosRecords(state: WorkspaceState | null): Record<string, unknown> {
  return hostedNativeRecords(state, 'ios');
}

export function unreadableHostedIos(slot: string): string {
  return unreadableHostedNative(slot, 'ios');
}

export function hostedIosPlacements(state: WorkspaceState | null): Record<string, HostedIosPlacement> {
  return Object.assign(
    Object.create(null) as Record<string, HostedIosPlacement>,
    Object.fromEntries(
      Object.entries(hostedIosRecords(state)).flatMap(([slot, record]) => {
        const placement = parseHostedIosPlacement(record);
        return placement ? [[slot, placement]] : [];
      }),
    ),
  );
}
