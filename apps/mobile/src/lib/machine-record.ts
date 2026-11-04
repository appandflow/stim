import { t } from '@lingui/core/macro';

import type { ConnectionState } from '@/lib/connection';

export interface MachineRecord {
  /** The machine's own name, when it differs from the label this phone gives it. */
  serverName: string | null;
  /** This phone's record on the machine: the name and id `stim-server devices` lists. */
  deviceName: string | null;
  deviceId: string | null;
}

/** What the machine says about itself and about this phone, known only while connected. */
export function machineRecord(state: ConnectionState, label: string): MachineRecord {
  if (state.kind !== 'open') return { serverName: null, deviceName: null, deviceId: null };
  return {
    serverName: state.server.name === label ? null : state.server.name,
    deviceName: state.deviceName,
    deviceId: state.deviceId,
  };
}

function revokeCommand(deviceId: string | null): string {
  return `stim-server devices revoke ${deviceId ?? '<id>'}`;
}

/**
 * What the Remove confirmation says about the machine's own record of this phone, which removing the pairing leaves
 * in place. The machine is named by its own name, known only while connected, never by this phone's label for it.
 */
export function removeNotice(state: ConnectionState): string {
  if (state.kind === 'refused' && state.code === 'unauthorized') {
    return t`The machine no longer lists this phone, so there is nothing to revoke there.`;
  }
  if (state.kind !== 'open') {
    return t`If the machine still lists this phone, revoke it there: run stim-server devices to find this phone's id, then stim-server devices revoke <id>.`;
  }
  const machine = state.server.name;
  const command = revokeCommand(state.deviceId);
  return state.deviceId
    ? t`The machine still lists this phone until you revoke it: on ${machine}, run ${command}.`
    : t`The machine still lists this phone until you revoke it: on ${machine}, find this phone's id with stim-server devices, then run ${command}.`;
}
