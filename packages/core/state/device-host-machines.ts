import { deviceHostMachinesFile } from './paths.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';

/** A separately approved hosting machine, pinned before sending its device token. */
export interface DeviceHostMachineCredential {
  machine: string;
  nodeId: string;
  dnsName: string;
  deviceId: string;
  deviceToken: string;
  state: 'pending' | 'approved';
  requestedAt: string;
  ticketHash?: string;
}

/** An absent store is empty; unreadable or malformed credentials refuse access without discarding pins. */
export function readDeviceHostMachines(): DeviceHostMachineCredential[] {
  let value: unknown;
  try {
    value = readJsonFile(deviceHostMachinesFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.machines)) {
    throw new Error('Invalid device-host machine credential store');
  }
  const machines: DeviceHostMachineCredential[] = [];
  for (const entry of value.machines) {
    if (
      !isJsonObject(entry) ||
      !['machine', 'nodeId', 'dnsName', 'deviceId', 'deviceToken', 'requestedAt'].every(
        (key) => typeof entry[key] === 'string' && entry[key],
      ) ||
      (entry.state !== 'pending' && entry.state !== 'approved') ||
      machines.some((each) => each.machine === entry.machine)
    ) {
      throw new Error('Invalid device-host machine credential store');
    }
    const { ticketHash, ...credential } = entry;
    machines.push({
      ...credential,
      ...(typeof ticketHash === 'string' ? { ticketHash } : {}),
    } as unknown as DeviceHostMachineCredential);
  }
  return machines;
}
