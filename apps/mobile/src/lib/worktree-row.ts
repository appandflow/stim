import { plural, t } from '@lingui/core/macro';

import { agentsSummary, workspaceAgentSessions } from '@/lib/agents';
import type { HomeItem } from '@/lib/home';
import { rowProblems, rowStatus, type RowProblem, type RowStatus } from '@/lib/home-list';
import { STALE_MS } from '@/lib/needs-attention';
import { worktreePage } from '@/lib/worktree-page';
import { gitChip } from '@/lib/workspace-view';
import { devicesOf, isActive, platformName } from '@/lib/workspaces';
import type { AgentSession, DevicePlatform, EnvironmentState } from '@/protocol/types';

export interface PlatformState {
  platform: DevicePlatform;
  kind: 'building' | 'failed' | 'running' | 'idle';
}

export const PLATFORM_ORDER: DevicePlatform[] = ['ios', 'android', 'macos', 'web'];

const KIND_RANK: Record<PlatformState['kind'], number> = {
  failed: 0,
  building: 1,
  running: 2,
  idle: 3,
};

const age = (at: string | null | undefined, now: number): number | null => {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? now - ms : null;
};

/**
 * The platforms the workspace has run, in iOS, Android, macOS, Web order, each with its own state. A failed build shows
 * while the workspace is active or for a day after it failed, and a failed web page while it is loaded.
 * Mirrors `Workspace.platformStates` in Stim Desktop's `WorkspaceRow.swift`.
 */
export function platformStates(env: EnvironmentState, now: number): PlatformState[] {
  const devices = devicesOf(env);
  return PLATFORM_ORDER.flatMap((platform): PlatformState[] => {
    const isBuildPlatform = platform === 'ios' || platform === 'android';
    const last = isBuildPlatform ? env.lastBuilds?.[platform] : undefined;
    const ran =
      devices.some((d) => d.platform === platform) ||
      (platform !== 'web' && (env.builds?.[platform]?.length ?? 0) > 0) ||
      env.build?.platform === platform ||
      (platform === 'macos' && !!env.macos) ||
      !!last;
    if (!ran) return [];
    const state = (kind: PlatformState['kind']): PlatformState[] => [{ platform, kind }];
    if (
      (env.build?.state === 'running' && env.build.platform === platform) ||
      (platform === 'macos' && env.macos?.build.state === 'running')
    )
      return state('building');
    let failed: boolean;
    let failedAt: string | null | undefined;
    if (platform === 'macos') {
      failed = env.macos?.build.state === 'failed';
      failedAt = env.macos?.build.finishedAt ?? env.macos?.build.startedAt;
    } else if (platform === 'web') {
      failed = devices.some((d) => d.page?.error);
    } else {
      failed = last?.status === 'failed';
      failedAt = last?.finishedAt ?? last?.startedAt;
    }
    if (failed) {
      const ms = age(failedAt, now);
      if (platform === 'web' || isActive(env) || (ms !== null && ms < STALE_MS)) return state('failed');
    }
    const up =
      devices.some((d) => d.platform === platform && d.running) ||
      (platform === 'macos' && env.macos?.state === 'running');
    return state(up ? 'running' : 'idle');
  });
}

export interface WorktreeRowSummary {
  /** The app whose state leads the row, and whose build and errors the row opens first. */
  lead: HomeItem;
  status: RowStatus;
  problems: RowProblem[];
  platforms: PlatformState[];
  sessions: AgentSession[];
  drivers: string[];
  remote: number;
}

/**
 * One row for every app of a worktree: the status of the app that needs attention most (as in Stim Desktop's
 * `WorktreePage`), error and warning counts summed across the apps, the platforms they have run with the most pressing
 * state of each, and the agent sessions, drivers and EAS sessions of all of them.
 */
export function worktreeRowSummary(
  apps: HomeItem[],
  now: number,
  offline: { lastSeenAt: number | null } | null,
): WorktreeRowSummary {
  const leadPath = worktreePage({
    path: apps[0].env.path,
    environments: apps.map((app) => app.env),
    entries: [],
    now,
  }).lead;
  const lead = apps.find((app) => app.env.path === leadPath) ?? apps[0];

  let errors = 0;
  let issues = 0;
  let warnings = 0;
  const others = new Map<string, RowProblem>();
  for (const { env } of apps) {
    errors += env.logs?.errorsSinceMarker ?? 0;
    const count = env.warnings.length;
    if (env.issues?.some((issue) => issue.severity === 'error')) issues += count;
    else warnings += count;
    for (const problem of rowProblems(env, now)) {
      if (problem.kind === 'errors' || problem.kind === 'issues' || problem.kind === 'warnings') continue;
      others.set(problem.text, problem);
    }
  }
  const problems: RowProblem[] = [
    ...(errors
      ? [
          {
            kind: 'errors' as const,
            text: plural(errors, { one: '# error', other: '# errors' }),
            tone: 'error' as const,
          },
        ]
      : []),
    ...others.values(),
    ...(issues
      ? [
          {
            kind: 'issues' as const,
            text: plural(issues, { one: '# issue', other: '# issues' }),
            tone: 'error' as const,
          },
        ]
      : []),
    ...(warnings
      ? [
          {
            kind: 'warnings' as const,
            text: plural(warnings, { one: '# warning', other: '# warnings' }),
            tone: 'warning' as const,
          },
        ]
      : []),
  ];

  const byPlatform = new Map<DevicePlatform, PlatformState>();
  for (const { env } of apps) {
    for (const state of platformStates(env, now)) {
      const seen = byPlatform.get(state.platform);
      if (!seen || KIND_RANK[state.kind] < KIND_RANK[seen.kind]) byPlatform.set(state.platform, state);
    }
  }

  const sessions = new Map<string, AgentSession>();
  for (const { env } of apps) {
    for (const session of workspaceAgentSessions(env)) sessions.set(`${session.tool}:${session.sessionId}`, session);
  }

  return {
    lead,
    status: rowStatus(lead.env, now, offline),
    problems,
    platforms: PLATFORM_ORDER.flatMap((platform) => byPlatform.get(platform) ?? []),
    sessions: [...sessions.values()],
    drivers: [
      ...new Set(
        apps.flatMap(({ env }) =>
          devicesOf(env)
            .filter((d) => d.running && d.activity?.state === 'driven')
            .map((d) => d.activity?.driver?.tool ?? ''),
        ),
      ),
    ],
    remote: apps.reduce((sum, { env }) => sum + (env.remoteDevices?.length ?? 0), 0),
  };
}

export const platformSpoken = (state: PlatformState): string => {
  const name = platformName(state.platform);
  switch (state.kind) {
    case 'building':
      return t`${name} building`;
    case 'failed':
      return t`${name} failed`;
    case 'running':
      return t`${name} running`;
    default:
      return t`${name} idle`;
  }
};

/** What the one-row worktree shows, spoken, since the row is one accessibility element. */
export function worktreeRowLabel(title: string, summary: WorktreeRowSummary, machine: string | null): string {
  const { lead, status, platforms, problems, sessions, drivers, remote } = summary;
  const driven = drivers.map((tool) => tool || t`unknown tool`).join(', ');
  return [
    title,
    status.label,
    ...platforms.map(platformSpoken),
    agentsSummary(sessions),
    ...problems.map((p) => p.text),
    driven ? t`driven by ${driven}` : null,
    remote ? plural(remote, { one: '# EAS session', other: '# EAS sessions' }) : null,
    gitChip(lead.env.worktree)?.label,
    machine ? t`on ${machine}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
