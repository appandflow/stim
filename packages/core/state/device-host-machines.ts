import { deviceHostMachinesFile } from './paths.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';
import { MACHINE_CREDENTIALS_VERSION, parseMachineCredential, type MachineCredential } from './build-machines.ts';

/** A remote machine this machine asked for device-host access, separate from build credentials. */
export type DeviceHostMachineCredential = MachineCredential;

/**
 * An absent store, or one from protocol 1, is empty; an unreadable or malformed one refuses access without discarding
 * pinned keys.
 */
export function readDeviceHostMachines(): DeviceHostMachineCredential[] {
  let value: unknown;
  try {
    value = readJsonFile(deviceHostMachinesFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (isJsonObject(value) && value.version === 1) return [];
  if (!isJsonObject(value) || value.version !== MACHINE_CREDENTIALS_VERSION || !Array.isArray(value.machines)) {
    throw new Error('Invalid device-host machine credential store');
  }
  const machines: DeviceHostMachineCredential[] = [];
  for (const entry of value.machines) {
    const credential = parseMachineCredential(entry);
    if (!credential || machines.some((each) => each.machine === credential.machine)) {
      throw new Error('Invalid device-host machine credential store');
    }
    machines.push(credential);
  }
  return machines;
}
