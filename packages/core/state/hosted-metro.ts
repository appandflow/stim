import { isJsonObject } from './json-file.ts';
import type { WorkspaceState } from './workspace-state.ts';

export const HOSTED_METRO_REQUESTS_KEY = 'hostedMetroRequests';
export const HOSTED_METRO_LINKS_KEY = 'hostedMetroLinks';

/** Private supervisor request, keyed by hosted session; never part of a public payload. */
export interface HostedMetroRequest {
  id: string;
  machine: string;
}

/** The supervisor's answer to a request: `ready` while the host holds one of its links, `error` when it cannot link. */
export interface HostedMetroLinks {
  id: string;
  processToken: string;
  ready?: true;
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
        typeof value.machine === 'string'
      );
    }),
  );
}

export function hostedMetroLinks(state: WorkspaceState | null): Record<string, HostedMetroLinks> {
  const raw = state?.[HOSTED_METRO_LINKS_KEY];
  if (!isJsonObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, HostedMetroLinks] => {
      const value = entry[1];
      return (
        isJsonObject(value) &&
        typeof value.id === 'string' &&
        typeof value.processToken === 'string' &&
        (value.ready === undefined || value.ready === true) &&
        (value.error === undefined || typeof value.error === 'string')
      );
    }),
  );
}
