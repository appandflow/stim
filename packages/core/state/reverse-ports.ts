import type { WorkspaceState } from './workspace-state.ts';

export const REVERSE_PORTS_KEY = 'reversePorts';

export const MAX_REVERSE_PORTS = 16;

export function reversePorts(state: WorkspaceState | null | undefined): number[] {
  const raw = state?.[REVERSE_PORTS_KEY];
  if (!Array.isArray(raw)) return [];
  const ports = raw.filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536);
  return [...new Set(ports)].toSorted((a, b) => a - b).slice(0, MAX_REVERSE_PORTS);
}
