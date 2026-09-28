import { buildMachinesFile } from './paths.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';

/**
 * A build machine this Mac asked to build on. `machine` is the `offload.machines` entry; `nodeId` is the
 * worker's tailnet StableID pinned when the request was sent, which every later connection must match.
 */
export interface BuildMachineCredential {
  machine: string;
  nodeId: string;
  dnsName: string;
  deviceId: string;
  deviceToken: string;
  state: 'pending' | 'approved';
  requestedAt: string;
}

function parseCredential(value: unknown): BuildMachineCredential | null {
  if (!isJsonObject(value)) return null;
  const { machine, nodeId, dnsName, deviceId, deviceToken, state, requestedAt } = value;
  const strings = [machine, nodeId, dnsName, deviceId, deviceToken, requestedAt];
  if (!strings.every((field) => typeof field === 'string' && field)) return null;
  if (state !== 'pending' && state !== 'approved') return null;
  return {
    machine: machine as string,
    nodeId: nodeId as string,
    dnsName: dnsName as string,
    deviceId: deviceId as string,
    deviceToken: deviceToken as string,
    state,
    requestedAt: requestedAt as string,
  };
}

export function readBuildMachines(): BuildMachineCredential[] {
  try {
    const machines = (readJsonFile(buildMachinesFile()) as { machines?: unknown }).machines;
    return Array.isArray(machines) ? machines.flatMap((entry) => parseCredential(entry) ?? []) : [];
  } catch {
    return [];
  }
}
