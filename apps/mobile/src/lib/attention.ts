import { t } from '@lingui/core/macro';

import { formatDuration } from '@/intl/format';
import type { ConnectionState } from '@/lib/connection';
import { needsAttention } from '@/lib/needs-attention';
import { tildeHome } from '@/lib/paths';
import { repositoryRoots, workspaceTitle } from '@/lib/workspace-names';
import type { MachineUsage, StatusPayload } from '@/protocol/types';

export interface AttentionMachine {
  id: string;
  name: string;
  state: ConnectionState;
  missing: boolean;
  status: StatusPayload | null;
  usage: MachineUsage | null;
  /** The Mac's home folder, shown as `~` in issue messages. */
  home: string | null;
  /** When the connection last dropped; null while connected or before the first connection. */
  disconnectedAt: number | null;
  /** When a status cached before this launch was last known current; null once connected. */
  seenAt: number | null;
}

export type AttentionTarget = { kind: 'machine'; macId: string } | { kind: 'workspace'; macId: string; path: string };

export interface HomeAttentionItem {
  key: string;
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  macName: string;
  target: AttentionTarget;
}

const EAS_SESSION_MINUTES = 30;

function machineItem(mac: AttentionMachine, now: number): HomeAttentionItem | null {
  const base = {
    macName: mac.name,
    title: mac.name,
    target: { kind: 'machine', macId: mac.id } as const,
    key: `${mac.id}\noffline`,
  };
  if (mac.missing) return { ...base, severity: 'error', detail: t`Not paired: pair again` };
  const { state } = mac;
  if (state.kind === 'refused') {
    const detail =
      state.code === 'protocol-unsupported'
        ? t`Refused the connection: needs an update`
        : t`Refused the connection: pair again`;
    return { ...base, severity: 'error', detail };
  }
  if (state.kind === 'open' || (state.kind === 'connecting' && mac.disconnectedAt === null)) return null;
  const lastSeenAt = mac.seenAt ?? mac.disconnectedAt;
  if (lastSeenAt === null) return { ...base, severity: 'warning', detail: t`Offline` };
  const ago = formatDuration(now - lastSeenAt);
  return { ...base, severity: 'warning', detail: t`Offline \u00B7 last seen ${ago} ago` };
}

const SEVERITY_RANK = { error: 0, warning: 1 };

/**
 * What home's attention strip lists: what only a person can act on (`needsAttention`), most important first: errors
 * before warnings, then machine problems, then live workspaces, then idle ones, each in status order. A machine that
 * is not connected yields only its offline item, since its status is stale.
 */
export function homeAttention(machines: AttentionMachine[], now: number, stuckMinutes: number): HomeAttentionItem[] {
  const ranked: { item: HomeAttentionItem; scope: number }[] = [];
  for (const mac of machines) {
    const offline = machineItem(mac, now);
    if (offline) ranked.push({ item: offline, scope: 0 });
    if (mac.missing || mac.state.kind !== 'open') continue;
    const environments = mac.status?.environments ?? [];
    const roots = mac.status ? repositoryRoots(mac.status) : [];
    const byPath = new Map(environments.map((env) => [env.path, env]));
    const items = needsAttention({
      environments,
      volumes: mac.usage?.volumes ?? null,
      now,
      stuckMinutes,
      easSessionMinutes: EAS_SESSION_MINUTES,
      ownLeases: mac.status?.ownLeases,
    });
    for (const item of items) {
      const env = item.workspace === null ? undefined : byPath.get(item.workspace);
      ranked.push({
        scope: env ? (env.live ? 1 : 2) : 0,
        item: {
          key: `${mac.id}\n${item.id}`,
          severity: item.severity,
          title: env && mac.status ? workspaceTitle(env, roots) : mac.name,
          detail: tildeHome(item.body, mac.home),
          macName: mac.name,
          target: env ? { kind: 'workspace', macId: mac.id, path: env.path } : { kind: 'machine', macId: mac.id },
        },
      });
    }
  }
  return ranked
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] || a.scope - b.scope || a.index - b.index,
    )
    .map((entry) => entry.item);
}
