import { isIP } from 'node:net';
import { isJsonObject } from './json-file.ts';
import type { WorkspaceState } from './workspace-state.ts';

export const HOSTED_METRO_REQUESTS_KEY = 'hostedMetroRequests';
export const HOSTED_METRO_GATEWAYS_KEY = 'hostedMetroGateways';

/** Private supervisor request, keyed by hosted session; never part of a public payload. */
export interface HostedMetroRequest {
  id: string;
  machine: string;
  address: string;
  peer: string;
  secret: string;
}

export interface HostedMetroGateway {
  id: string;
  processToken: string;
  port?: number;
  error?: string;
}

export function hostedMetroRequests(state: WorkspaceState | null): Record<string, HostedMetroRequest> {
  const raw = state?.[HOSTED_METRO_REQUESTS_KEY];
  if (!isJsonObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, HostedMetroRequest] => {
      const [session, value] = entry;
      return (
        /^[a-f0-9-]{36}$/.test(session) &&
        isJsonObject(value) &&
        typeof value.id === 'string' &&
        typeof value.machine === 'string' &&
        typeof value.address === 'string' &&
        isIP(value.address) !== 0 &&
        typeof value.peer === 'string' &&
        isIP(value.peer) !== 0 &&
        typeof value.secret === 'string' &&
        /^[a-f0-9]{64}$/.test(value.secret)
      );
    }),
  );
}

export function hostedMetroGateways(state: WorkspaceState | null): Record<string, HostedMetroGateway> {
  const raw = state?.[HOSTED_METRO_GATEWAYS_KEY];
  if (!isJsonObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, HostedMetroGateway] => {
      const value = entry[1];
      return (
        isJsonObject(value) &&
        typeof value.id === 'string' &&
        typeof value.processToken === 'string' &&
        (value.port === undefined ||
          (typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535)) &&
        (value.error === undefined || typeof value.error === 'string')
      );
    }),
  );
}
