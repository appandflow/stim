import { type HostedAndroidDevice } from './device-host.ts';
import {
  type HostedNativePlacement,
  hostedNativeRecords,
  parseHostedNativePlacement,
  unreadableHostedNative,
} from './hosted-native.ts';
import type { WorkspaceState } from './workspace-state.ts';

/** A workspace slot's placement; null device means its reservation has not reached ready yet. */
export interface HostedAndroidPlacement extends HostedNativePlacement<HostedAndroidDevice> {}

/** Public hosting facts; the host's serial, AVD name and private Metro gateway are excluded. */
export type HostedAndroidStatus = Pick<HostedAndroidPlacement, 'machine' | 'session' | 'selected' | 'agent'> & {
  device: { name: string; systemImage: string; api: number } | null;
  /** The latest session probe in status, independent of a conflicting local emulator's state. */
  state?: string;
};

export function parseHostedAndroidPlacement(value: unknown): HostedAndroidPlacement | null {
  return parseHostedNativePlacement(value, 'android');
}

export function hostedAndroidStatus(placement: HostedAndroidPlacement): HostedAndroidStatus {
  return {
    machine: placement.machine,
    session: placement.session,
    selected: placement.selected,
    agent: placement.agent,
    device: placement.device
      ? {
          name: hostedAndroidDeviceName(placement.device),
          systemImage: placement.device.systemImage,
          api: Number(/^system-images;android-(\d+);/.exec(placement.device.systemImage)?.[1]),
        }
      : null,
  };
}

export function hostedAndroidRecords(state: WorkspaceState | null): Record<string, unknown> {
  return hostedNativeRecords(state, 'android');
}

export function unreadableHostedAndroid(slot: string): string {
  return unreadableHostedNative(slot, 'android');
}

export function hostedAndroidPlacements(state: WorkspaceState | null): Record<string, HostedAndroidPlacement> {
  return Object.assign(
    Object.create(null) as Record<string, HostedAndroidPlacement>,
    Object.fromEntries(
      Object.entries(hostedAndroidRecords(state)).flatMap(([slot, record]) => {
        const placement = parseHostedAndroidPlacement(record);
        return placement ? [[slot, placement]] : [];
      }),
    ),
  );
}

export function hostedAndroidDeviceName(device: HostedAndroidDevice): string {
  return `${device.deviceProfile} (API ${/^system-images;android-(\d+);/.exec(device.systemImage)?.[1]})`;
}
