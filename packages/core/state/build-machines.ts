import { buildMachinesFile } from './paths.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';
import { parseMachine, parseTailnetIdentity, type TailnetIdentity } from './tailnet.ts';

/**
 * What this machine keeps about a remote machine it asked for access. `machine` is the `remote.machines` entry,
 * `transport` how it is reached, and `address` the tailnet name or local network host it resolved to. Once approved, `serverKey` is the worker's pinned stim-server key: every later
 * connection must prove it holds that key. While pending, `ticket` is the setup ticket this machine generated or was
 * given, and `expiresAt` its expiry when known. `tailnet` is the tailnet this machine was signed in to when it first
 * reached the machine, absent for a `local` machine and for a record from before it was kept. Records of protocol 1, which pinned a tailnet node, are not read.
 */
export interface MachineCredential {
  machine: string;
  transport: 'tailscale' | 'local';
  address: string;
  state: 'pending' | 'approved';
  requestedAt: string;
  serverKey?: string;
  deviceId?: string;
  ticket?: string;
  expiresAt?: string;
  tailnet?: TailnetIdentity;
}

export type BuildMachineCredential = MachineCredential;

export const MACHINE_CREDENTIALS_VERSION = 2;

const KEY = /^[A-Za-z0-9_-]{43}$/;

/** A stored credential, or null when it is malformed or from an older version. */
export function parseMachineCredential(value: unknown): MachineCredential | null {
  if (!isJsonObject(value)) return null;
  const { machine, transport, address, state, requestedAt, serverKey, deviceId, ticket, expiresAt } = value;
  const tailnetIdentity = parseTailnetIdentity(value.tailnet);
  if (![machine, address, requestedAt].every((field) => typeof field === 'string' && field)) return null;
  if ((transport !== 'tailscale' && transport !== 'local') || (state !== 'pending' && state !== 'approved'))
    return null;
  if (typeof machine !== 'string' || parseMachine(machine)?.transport !== transport) return null;
  if (serverKey !== undefined && (typeof serverKey !== 'string' || !KEY.test(serverKey))) return null;
  if (ticket !== undefined && (typeof ticket !== 'string' || !KEY.test(ticket))) return null;
  if (state === 'approved' && (serverKey === undefined || typeof deviceId !== 'string' || !deviceId)) return null;
  if (state === 'pending' && ticket === undefined) return null;
  return {
    machine: machine as string,
    transport,
    address: address as string,
    state,
    requestedAt: requestedAt as string,
    ...(serverKey ? { serverKey: serverKey as string } : {}),
    ...(typeof deviceId === 'string' && deviceId ? { deviceId } : {}),
    ...(ticket ? { ticket: ticket as string } : {}),
    ...(typeof expiresAt === 'string' && expiresAt ? { expiresAt } : {}),
    ...(tailnetIdentity && transport === 'tailscale' ? { tailnet: tailnetIdentity } : {}),
  };
}

export function readBuildMachines(): BuildMachineCredential[] {
  try {
    const store = readJsonFile(buildMachinesFile()) as {
      version?: unknown;
      machines?: unknown;
    };
    if (store.version !== MACHINE_CREDENTIALS_VERSION || !Array.isArray(store.machines)) return [];
    return store.machines.flatMap((entry) => parseMachineCredential(entry) ?? []);
  } catch {
    return [];
  }
}
