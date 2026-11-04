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
