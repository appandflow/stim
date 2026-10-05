import { workspaceAgentSessions } from '@/lib/agents';
import { metroHealth, usedPlatforms, workspaceStage, workspaceUsage, type Usage } from '@/lib/workspace-view';
import { devicesOf, orderDevices, platformName, type DeviceRef } from '@/lib/workspaces';
import type {
  AgentSession,
  DevicePlatform,
  EnvironmentState,
  MachineUsageState,
  StatusUsage,
  Platform,
} from '@/protocol/types';

export interface WorktreeEntry {
  path: string;
  platform: DevicePlatform;
}

const PLATFORMS: DevicePlatform[] = ['ios', 'android', 'macos', 'web'];

export function worktreeApps(path: string, environments: EnvironmentState[]): EnvironmentState[] {
  const selected = environments.find((env) => env.path === path);
  if (!selected) return [];
  const checkout = selected.worktree?.path;
  return environments
    .filter((env) => env.path === path || (checkout && env.worktree?.path === checkout))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function projectLabel(env: EnvironmentState): string {
  const checkout = env.worktree?.path;
  return checkout && env.path.startsWith(`${checkout}/`)
    ? env.path.slice(checkout.length + 1)
    : (env.path.split('/').filter(Boolean).at(-1) ?? env.path);
}

function stageRank(env: EnvironmentState, now: number): number {
  const stage = workspaceStage(env, orderDevices(devicesOf(env)), now);
  if (stage.kind === 'build-failed' || (stage.kind === 'running' && stage.tone === 'error')) return 0;
  return { building: 1, warming: 2, running: 3, ready: 4, stopped: 5, unknown: 6 }[stage.kind];
}

/**
 * Worktree grouping, lead, project subtitles and app labels mirror Stim Desktop's WorktreePage.swift.
 * Both replay apps/desktop/Tests/StimKitTests/Fixtures/worktree-page-vectors.json.
 */
export function worktreePage({
  path,
  environments,
  entries,
  now,
}: {
  path: string;
  environments: EnvironmentState[];
  entries: WorktreeEntry[];
  now: number;
}) {
  const apps = worktreeApps(path, environments);
  const projects = apps.map(projectLabel);
  const lead = apps.reduce<EnvironmentState | null>(
    (best, env) => (!best || stageRank(env, now) < stageRank(best, now) ? env : best),
    null,
  );
  const labels = apps.map((env) =>
    PLATFORMS.filter((platform) => entries.some((entry) => entry.path === env.path && entry.platform === platform))
      .map(platformName)
      .join(' \u00B7 '),
  );
  return {
    apps: apps.map((env) => env.path),
    projects,
    lead: lead?.path ?? null,
    subtitles: entries.map((entry) =>
      new Set(entries.filter((other) => other.platform === entry.platform).map((other) => other.path)).size > 1
        ? (projects[apps.findIndex((env) => env.path === entry.path)] ?? null)
        : null,
    ),
    appLabels: labels.map((label, i) =>
      !label
        ? projects[i]
        : labels.filter((other) => other === label).length > 1
          ? `${label} \u00B7 ${projects[i]}`
          : label,
    ),
  };
}

export function buildEntries(apps: EnvironmentState[], tabs = false) {
  return apps
    .flatMap((env) => {
      const used = usedPlatforms(env);
      const platforms: (Platform | 'macos')[] = env.macos
        ? ['macos']
        : tabs || !used.length
          ? ['ios', 'android']
          : used;
      return platforms.map((platform) => ({ path: env.path, platform, env }));
    })
    .sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
}

export function worktreeDevices(apps: EnvironmentState[], now: number) {
  const owners = new Map<DeviceRef, EnvironmentState>();
  for (const env of apps) {
    const devices = orderDevices(devicesOf(env));
    const stopped = workspaceStage(env, devices, now).kind === 'stopped';
    for (const device of devices) if (!stopped || device.platform === 'macos') owners.set(device, env);
  }
  return orderDevices([...owners.keys()]).map((device) => ({
    device,
    env: owners.get(device)!,
    path: owners.get(device)!.path,
    platform: device.platform,
  }));
}

export function sumMeasured(values: (number | null | undefined)[]): number | null {
  const measured = values.filter((value): value is number => value != null);
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) : null;
}

export function worktreeDisk(apps: EnvironmentState[]): EnvironmentState['disk'] {
  const disks = apps.flatMap((env) => (env.disk ? [env.disk] : []));
  if (!disks.length) return undefined;
  const max = (values: (number | null)[]) =>
    values.every((value) => value === null) ? null : Math.max(...values.map((value) => value ?? 0));
  return {
    worktreeBytes: max(disks.map((disk) => disk.worktreeBytes)),
    nodeModulesBytes: max(disks.map((disk) => disk.nodeModulesBytes)),
    buildBytes: sumMeasured(disks.map((disk) => disk.buildBytes)),
    measuredAt: disks[0].measuredAt,
  };
}

export function worktreeUsage(apps: EnvironmentState[], machine: MachineUsageState | null | undefined): Usage {
  const usages = apps.map((env) => workspaceUsage(env, machine));
  const disk = worktreeDisk(apps);
  return {
    cpuPercent: sumMeasured(usages.map((usage) => usage.cpuPercent)),
    memoryMb: sumMeasured(usages.map((usage) => usage.memoryMb)),
    diskBytes: sumMeasured([disk?.worktreeBytes, disk?.buildBytes]),
  };
}

export function worktreeSessions(apps: EnvironmentState[]): AgentSession[] {
  const seen = new Set<string>();
  const unique = <T extends AgentSession>(agents: T[]) =>
    agents.filter((agent) => !seen.has(agent.sessionId) && Boolean(seen.add(agent.sessionId)));
  const agents = unique(apps.flatMap((env) => env.agents ?? []));
  return workspaceAgentSessions({ agents, endedAgents: unique(apps.flatMap((env) => env.endedAgents ?? [])) });
}

export function worktreeMetro(apps: EnvironmentState[]): EnvironmentState | null {
  const rank = { unhealthy: 0, healthy: 1, stopped: 2 };
  return apps.filter((env) => env.metro).sort((a, b) => rank[metroHealth(a)!] - rank[metroHealth(b)!])[0] ?? null;
}

export function worktreeHistory(usage: StatusUsage | null, apps: EnvironmentState[]): StatusUsage | null {
  if (!usage) return null;
  const series = usage.environments.filter((entry) => apps.some((env) => env.path === entry.workspace));
  if (!series.length) return null;
  const merged = (key: 'cpuPercent' | 'memoryMb') =>
    Array.from({ length: Math.max(...series.map((entry) => entry[key].length)) }, (_, i) =>
      sumMeasured(series.map((entry) => entry[key][i])),
    );
  return {
    ...usage,
    environments: [
      { ...series[0], workspace: apps[0].path, cpuPercent: merged('cpuPercent'), memoryMb: merged('memoryMb') },
    ],
  };
}
