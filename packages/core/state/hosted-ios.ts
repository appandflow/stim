import { parseHostedAgentAccess, type HostedAgentAccess } from './hosted-macos.ts';
import { isJsonObject } from './json-file.ts';
import { parseHostedDevice, type HostedIosDevice } from './device-host.ts';
import { parseMachine } from './tailnet.ts';
import type { WorkspaceState } from './workspace-state.ts';

/** A workspace slot's placement; null device means its reservation has not reached ready yet. */
export interface HostedIosPlacement {
  machine: string;
  session: string;
  appAttempt: string;
  device: HostedIosDevice | null;
  selected: string;
  agent: HostedAgentAccess;
}

/** Public hosting facts; the host's UDID and private Metro gateway are excluded. */
export type HostedIosStatus = Pick<HostedIosPlacement, 'machine' | 'session' | 'selected' | 'agent'> & {
  device: { name: string; runtime: string } | null;
  /** The latest session probe in status, independent of a conflicting local simulator's state. */
  state?: string;
};

export function parseHostedIosPlacement(value: unknown): HostedIosPlacement | null {
  if (
    !isJsonObject(value) ||
    typeof value.machine !== 'string' ||
    !parseMachine(value.machine) ||
    typeof value.session !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.session)
  )
    return null;
  const device = parseHostedDevice(value.device);
  return {
    machine: value.machine,
    session: value.session,
    appAttempt:
      typeof value.appAttempt === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.appAttempt) ? value.appAttempt : '',
    selected: value.machine,
    device,
    agent: parseHostedAgentAccess(value.agent) ?? { driver: 'none', setting: 'hosting.agentDriver' },
  };
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

/** Includes unreadable placements so callers retain every recorded hosting slot. */
export function hostedIosRecords(state: WorkspaceState | null): Record<string, unknown> {
  const slots = isJsonObject(state?.deviceSlots) ? state.deviceSlots : {};
  const records: Record<string, unknown> = {
    default: state?.ios,
    ...Object.fromEntries(
      Object.entries(slots).map(([slot, value]) => [slot, isJsonObject(value) ? value.ios : undefined]),
    ),
  };
  return Object.fromEntries(
    Object.entries(records).flatMap(([slot, record]) =>
      isJsonObject(record) && record.host !== undefined ? [[slot, record.host]] : [],
    ),
  );
}

export function unreadableHostedIos(slot: string): string {
  const key = slot === 'default' ? 'ios.host' : `deviceSlots.${slot}.ios.host`;
  return `The hosted iOS placement at workspace-state key ${key} is unreadable. Inspect ${key}.machine and ${key}.session before reconciling it.`;
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
