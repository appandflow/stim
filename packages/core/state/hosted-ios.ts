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
  agent: { driver: 'none'; setting: 'hosting.agentDriver' };
}

/** Public hosting facts; the host's UDID and private Metro gateway are excluded. */
export type HostedIosStatus = Pick<HostedIosPlacement, 'machine' | 'session' | 'selected' | 'agent'> & {
  device: { name: string; runtime: string } | null;
};

export function parseHostedIosPlacement(value: unknown): HostedIosPlacement | null {
  if (
    !isJsonObject(value) ||
    typeof value.machine !== 'string' ||
    !parseMachine(value.machine) ||
    typeof value.session !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.session) ||
    typeof value.appAttempt !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.appAttempt) ||
    value.selected !== value.machine ||
    !isJsonObject(value.agent) ||
    value.agent.driver !== 'none' ||
    value.agent.setting !== 'hosting.agentDriver'
  )
    return null;
  const device = value.device === null ? null : parseHostedDevice(value.device);
  if (value.device !== null && !device) return null;
  return {
    machine: value.machine,
    session: value.session,
    appAttempt: value.appAttempt,
    selected: value.machine,
    device,
    agent: { driver: 'none', setting: 'hosting.agentDriver' },
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

/** Reads all recorded placements, refusing an unreadable owner instead of losing it during cleanup. */
export function hostedIosPlacements(state: WorkspaceState | null): Record<string, HostedIosPlacement> {
  const slots = isJsonObject(state?.deviceSlots) ? state.deviceSlots : {};
  const records: Record<string, unknown> = {
    default: state?.ios,
    ...Object.fromEntries(
      Object.entries(slots).map(([slot, value]) => [slot, isJsonObject(value) ? value.ios : undefined]),
    ),
  };
  const found: Record<string, HostedIosPlacement> = {};
  for (const [slot, record] of Object.entries(records)) {
    if (!isJsonObject(record) || record.host === undefined) continue;
    const placement = parseHostedIosPlacement(record.host);
    if (!placement)
      throw new Error(`The hosted iOS placement for slot ${slot} is unreadable. Run stim stop to reconcile it.`);
    found[slot] = placement;
  }
  return found;
}
