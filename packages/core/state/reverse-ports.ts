import type { WorkspaceState } from './workspace-state.ts';

export const REVERSE_PORTS_KEY = 'reversePorts';

/** The most ports one workspace reverses, which bounds the listeners a hosted session opens on its host. */
export const MAX_REVERSE_PORTS = 16;

/** The loopback TCP ports whose servers on this machine the workspace's devices reach at the same `localhost` port. */
export function reversePorts(state: WorkspaceState | null | undefined): number[] {
  const raw = state?.[REVERSE_PORTS_KEY];
  if (!Array.isArray(raw)) return [];
  const ports = raw.filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536);
  return [...new Set(ports)].toSorted((a, b) => a - b).slice(0, MAX_REVERSE_PORTS);
}
