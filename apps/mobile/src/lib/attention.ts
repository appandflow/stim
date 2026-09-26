import type { ConnectionState } from '@/lib/connection';
import { clockDuration, shortDuration } from '@/lib/format';
import { diskTone, formatBytes } from '@/lib/home';
import { tildeHome } from '@/lib/paths';
import { attentionGroups, devicesOf, isActive, repositoryRoots, runningBuild, workspaceTitle } from '@/lib/workspaces';
import type { EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

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
}

export type AttentionTarget =
  | { kind: 'machine'; macId: string }
  | { kind: 'workspace'; macId: string; path: string }
  | { kind: 'logs'; macId: string; path: string };

export interface HomeAttentionItem {
  key: string;
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  macName: string;
  target: AttentionTarget;
}

const OVERRUN_FACTOR = 2;
const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000;

const platformName = (platform: string) => (platform === 'ios' ? 'iOS' : 'Android');

function machineItem(mac: AttentionMachine, now: number): HomeAttentionItem | null {
  const base = { macName: mac.name, title: mac.name, target: { kind: 'machine', macId: mac.id } as const };
  if (mac.missing) return { ...base, key: `${mac.id}\noffline`, severity: 'error', detail: 'Not paired: pair again' };
  const { state } = mac;
  if (state.kind === 'refused') {
    const fix = state.code === 'protocol-unsupported' ? 'needs an update' : 'pair again';
    return { ...base, key: `${mac.id}\noffline`, severity: 'error', detail: `Refused the connection: ${fix}` };
  }
  if (state.kind === 'open' || (state.kind === 'connecting' && mac.disconnectedAt === null)) return null;
  const seen = mac.disconnectedAt === null ? '' : ` \u00B7 last seen ${shortDuration(now - mac.disconnectedAt)} ago`;
  return { ...base, key: `${mac.id}\noffline`, severity: 'warning', detail: `Offline${seen}` };
}

function diskItem(mac: AttentionMachine): HomeAttentionItem | null {
  const lowest = mac.usage?.volumes.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (lowest === null || lowest === undefined || diskTone(lowest) !== 'critical') return null;
  return {
    key: `${mac.id}\ndisk`,
    severity: 'error',
    title: mac.name,
    detail: `${formatBytes(lowest)} free, below Stim's floor`,
    macName: mac.name,
    target: { kind: 'machine', macId: mac.id },
  };
}

function workspaceItems(
  mac: AttentionMachine,
  env: EnvironmentState,
  active: boolean,
  title: string,
  issues: { message: string; severity: 'error' | 'warning' }[],
  now: number,
): HomeAttentionItem[] {
  const items: HomeAttentionItem[] = [];
  const at = { macId: mac.id, path: env.path };
  const add = (id: string, severity: HomeAttentionItem['severity'], detail: string, logs = false) =>
    items.push({
      key: `${mac.id}\n${env.path}\n${id}`,
      severity,
      title,
      detail,
      macName: mac.name,
      target: logs ? { kind: 'logs', ...at } : { kind: 'workspace', ...at },
    });

  for (const platform of ['ios', 'android'] as const) {
    const last = env.lastBuilds?.[platform];
    if (!last || last.status !== 'failed' || runningBuild(env)?.platform === platform) continue;
    const ended = Date.parse(last.finishedAt ?? last.startedAt);
    if (!active && !(now - ended < RECENT_FAILURE_MS)) continue;
    const age = Number.isNaN(ended) ? '' : ` \u00B7 ${shortDuration(now - ended)} ago`;
    const code = last.errorCode ? ` (${last.errorCode})` : '';
    add(`build-${platform}`, 'error', `${platformName(platform)} build failed${code}${age}`);
  }

  const errors = env.logs?.errorsSinceMarker ?? 0;
  if (active && errors > 0) add('logs', 'error', `${errors === 1 ? '1 error' : `${errors} errors`} in the logs`, true);

  issues.forEach((issue, i) => add(`issue-${i}`, issue.severity, tildeHome(issue.message, mac.home)));

  const build = runningBuild(env);
  const started = build ? Date.parse(build.startedAt) : NaN;
  if (build?.expectedMs && Number.isFinite(started) && now - started > OVERRUN_FACTOR * build.expectedMs) {
    add(
      'overrun',
      'warning',
      `${platformName(build.platform)} build at ${clockDuration(now - started)}, usually ~${clockDuration(build.expectedMs)}`,
    );
  }

  if (env.live) {
    for (const device of devicesOf(env)) {
      if (!device.running || device.app?.state !== 'stopped' || runningBuild(env, device)) continue;
      add(`app-${device.platform}-${device.slot}`, 'warning', `App not running on ${device.model}`);
    }
  }
  return items;
}

const SEVERITY_RANK = { error: 0, warning: 1 };

/**
 * What home's attention strip lists, most important first: errors before warnings, then machine problems, then
 * active workspaces, then idle ones, each in status order. A machine that is not connected yields only its offline
 * item, since its status is stale. An idle workspace contributes its error issues and a build that failed in the last
 * day; its warnings and log errors are left to the machine sheet and the workspace screen.
 */
export function homeAttention(machines: AttentionMachine[], now: number): HomeAttentionItem[] {
  const ranked: { item: HomeAttentionItem; scope: number }[] = [];
  for (const mac of machines) {
    const offline = machineItem(mac, now);
    if (offline) ranked.push({ item: offline, scope: 0 });
    if (mac.missing || mac.state.kind !== 'open') continue;
    const disk = diskItem(mac);
    if (disk) ranked.push({ item: disk, scope: 0 });
    if (!mac.status) continue;
    const roots = repositoryRoots(mac.status);
    const issuesByPath = new Map(attentionGroups(mac.status.environments).map((g) => [g.path, g.items]));
    for (const env of mac.status.environments) {
      const active = isActive(env);
      const issues = (issuesByPath.get(env.path) ?? []).filter((i) => active || i.severity === 'error');
      for (const item of workspaceItems(mac, env, active, workspaceTitle(env, roots), issues, now)) {
        ranked.push({ item, scope: active ? 1 : 2 });
      }
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
