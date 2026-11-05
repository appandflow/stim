import {
  parseWorkspaceLink,
  sharedWorkspaceURL,
  WORKSPACE_LINK_ORIGIN,
  type SharedWorkspaceLink,
} from '@stim-cli/core/workspace-link';
import type { ConnectionState } from '@/lib/connection';
import type { PairedMac } from '@/lib/macs';
import type { StatusPayload } from '@/protocol/types';

export interface WorkspaceLinkMachine {
  mac: Pick<PairedMac, 'id' | 'serverId'>;
  state: ConnectionState;
  status: StatusPayload | null;
  statusSource?: Extract<ConnectionState, { kind: 'open' }>;
  cachedSeenAt: number | null;
}

export type WorkspaceLinkResolution =
  | { kind: 'pending' | 'unknown-machine' | 'unsupported' | 'stale' }
  | { kind: 'offline'; macId: string }
  | {
      kind: 'ready';
      macId: string;
      path: string;
      platform?: SharedWorkspaceLink['platform'];
      slot?: string;
    };

export function resolveWorkspaceLink(
  link: SharedWorkspaceLink,
  machines: readonly WorkspaceLinkMachine[],
): WorkspaceLinkResolution {
  const matches = machines.filter(
    ({ mac, state }) =>
      (state.kind === 'open' && state.server.id ? state.server.id : mac.serverId)?.toLowerCase() === link.machine,
  );
  const matched = matches.find(({ state }) => state.kind === 'open') ?? matches[0];
  if (!matched)
    return { kind: machines.some(({ state }) => state.kind === 'connecting') ? 'pending' : 'unknown-machine' };
  if (matched.state.kind !== 'open') return { kind: 'offline', macId: matched.mac.id };
  if (!matched.state.server.id) return { kind: 'unsupported' };
  if (!matched.status || matched.cachedSeenAt !== null || matched.statusSource !== matched.state)
    return { kind: 'pending' };
  const workspace = matched.status.environments.find((item) => item.workspaceId === link.workspace);
  if (!workspace) return { kind: 'stale' };
  return {
    kind: 'ready',
    macId: matched.mac.id,
    path: workspace.path,
    ...(link.platform ? { platform: link.platform } : {}),
    ...(link.slot ? { slot: link.slot } : {}),
  };
}

export function workspaceIntentPath(path: string): string {
  let url: URL;
  try {
    url = new URL(path, WORKSPACE_LINK_ORIGIN);
  } catch {
    return path;
  }
  const custom = (url.protocol === 'stim:' || url.protocol === 'stim-dev:') && url.hostname === 'open';
  if (!custom && !['/open', '/open/'].includes(url.pathname)) return path;
  const link = parseWorkspaceLink(custom ? `${WORKSPACE_LINK_ORIGIN}/open${url.search}` : url.href);
  return link ? `/open${new URL(sharedWorkspaceURL(link)).search}` : '/open';
}
