import { plural, t } from '@lingui/core/macro';

import type { Tone } from '@/design/tone';
import { formatDuration } from '@/intl/format';
import { agentsSummary } from '@/lib/agents';
import { ACTIVE_WINDOW_MS, activityLabel, spokenDuration } from '@/lib/format';
import {
  workspaceActivityMs,
  workspaceKey,
  type HomeFilters,
  type HomeArchive,
  type HomeEntry,
  type HomeItem,
  type HomeWorktree,
} from '@/lib/home';
import { STALE_MS } from '@/lib/needs-attention';
import { buildLabel } from '@/lib/spoken-status';
import { appPresence, currentPhaseLabel, gitChip } from '@/lib/workspace-view';
import {
  devicesOf,
  isSettingUp,
  isShownLive,
  orderDevices,
  platformName,
  runningBuild,
  type DeviceRef,
} from '@/lib/workspaces';
import type { AgentSession, EnvironmentState, Platform } from '@/protocol/types';

export interface HomeWorkspace {
  key: string;
  title: string;
  apps: HomeItem[];
}

export interface HomeSection {
  project: string;
  live: number;
  idle: number;
  data: (HomeWorkspace | HomeWorktree | HomeArchive)[];
}

/**
 * The home list by repo, with live repos and rows before idle ones. Name sorts repos by name and rows by title
 * and machine. Recent sorts each group by its newest workspace activity, taking the latest across each checkout's
 * apps, with no activity last and name order breaking ties. Archives stay ordered by removal time.
 */
export function homeSections(items: HomeEntry[], sort: HomeFilters['sort'] = 'recent'): HomeSection[] {
  const checkouts = new Map<string, HomeWorkspace | HomeWorktree | HomeArchive>();
  for (const item of [...items].sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.title.localeCompare(b.title) || a.macName.localeCompare(b.macName),
  )) {
    if ('facts' in item || 'archive' in item) {
      checkouts.set(item.key, item);
      continue;
    }
    const key = workspaceKey(item);
    const workspace = checkouts.get(key) ?? { key, title: item.title, apps: [] };
    if ('apps' in workspace) workspace.apps.push(item);
    checkouts.set(key, workspace);
  }
  const groups = new Map<
    string,
    { live: HomeWorkspace[]; idle: (HomeWorkspace | HomeWorktree)[]; archived: HomeArchive[] }
  >();
  const activity = new Map<string, number>();
  const projectActivity = new Map<string, number>();
  for (const workspace of checkouts.values()) {
    if ('apps' in workspace) workspace.apps.sort((a, b) => a.env.path.localeCompare(b.env.path));
    const project = 'apps' in workspace ? workspace.apps[0].project : workspace.project;
    const latest =
      'apps' in workspace
        ? Math.max(...workspace.apps.map((app) => workspaceActivityMs(app.env) ?? -Infinity))
        : -Infinity;
    activity.set(workspace.key, latest);
    projectActivity.set(project, Math.max(projectActivity.get(project) ?? -Infinity, latest));
    const group = groups.get(project) ?? { live: [], idle: [], archived: [] };
    groups.set(project, group);
    if ('archive' in workspace) group.archived.push(workspace);
    else if ('apps' in workspace && workspace.apps.some((app) => isShownLive(app.env))) group.live.push(workspace);
    else group.idle.push(workspace);
  }
  if (sort === 'recent') {
    const byActivity = (a: HomeWorkspace | HomeWorktree, b: HomeWorkspace | HomeWorktree) =>
      activity.get(b.key)! - activity.get(a.key)! || 0;
    for (const { live, idle } of groups.values()) {
      live.sort(byActivity);
      idle.sort(byActivity);
    }
  }
  return [...groups]
    .map(([project, { live, idle, archived }]) => ({
      project,
      live: live.length,
      idle: idle.length,
      data: [
        ...live,
        ...idle,
        ...archived.sort((a, b) => Date.parse(b.archive.removedAt) - Date.parse(a.archive.removedAt)),
      ],
    }))
    .sort(
      (a, b) =>
        Number(b.live > 0) - Number(a.live > 0) ||
        (sort === 'recent' ? projectActivity.get(b.project)! - projectActivity.get(a.project)! : 0) ||
        a.project.localeCompare(b.project),
    );
}

/** Repos whose workspaces sit in different folders of their checkout, the only ones where the folder tells rows apart. */
export function checkoutProjects(items: HomeItem[]): Set<string> {
  const folders = new Map<string, Set<string>>();
  for (const item of items) {
    const set = folders.get(item.project) ?? new Set<string>();
    set.add(item.inCheckout ?? '');
    folders.set(item.project, set);
  }
  return new Set([...folders].filter(([, set]) => set.size > 1).map(([project]) => project));
}

export type RowStatusKind = 'offline' | 'building' | 'warming' | 'ready' | 'driven' | 'running' | 'idle';

export interface RowStatus {
  kind: RowStatusKind;
  text: string;
  label: string;
  tone: Extract<Tone, 'brand' | 'success' | 'tertiary'>;
}

const since = (at: string | null | undefined, now: number): number | null => {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? Math.max(0, now - ms) : null;
};

const drivenSince = (devices: DeviceRef[], now: number): number | null => {
  const starts = devices.map((d) => Date.parse(d.activity?.driver?.since ?? '')).filter(Number.isFinite);
  return starts.length ? Math.max(0, now - Math.max(...starts)) : null;
};

export function offlineRowStatus(now: number, offline: { lastSeenAt: number | null } | null): RowStatus | null {
  if (offline) {
    const { lastSeenAt } = offline;
    if (lastSeenAt === null) return { kind: 'offline', text: t`Offline`, label: t`Offline`, tone: 'tertiary' };
    const seen = formatDuration(now - lastSeenAt);
    const spoken = spokenDuration(now - lastSeenAt);
    return { kind: 'offline', text: t`Last seen ${seen} ago`, label: t`Last seen ${spoken} ago`, tone: 'tertiary' };
  }
  return null;
}

/**
 * What the workspace is doing, for the row's trailing word. It follows the list's own live and idle split, so a row
 * under Live never reads Idle. `lastSeenAt` is set for a machine that is not connected, whose status is stale.
 * This, `rowProblems` and `rowDevices` have Stim Desktop twins in `WorkspaceRow.swift`; both replay
 * apps/desktop/Tests/StimKitTests/Fixtures/workspace-row-vectors.json.
 */
export function rowStatus(
  env: EnvironmentState,
  now: number,
  offline: { lastSeenAt: number | null } | null,
): RowStatus {
  const disconnected = offlineRowStatus(now, offline);
  if (disconnected) return disconnected;
  const build = runningBuild(env);
  if (build) {
    const platform = platformName(build.platform);
    const text = t`Building ${platform}`;
    return { kind: 'building', text, label: text, tone: 'brand' };
  }
  if (isSettingUp(env)) {
    if (env.phase === 'ready') return { kind: 'ready', text: t`Ready`, label: t`Ready`, tone: 'brand' };
    const ms = since(env.phaseSince, now);
    if (ms === null) return { kind: 'warming', text: t`Warming`, label: t`Warming`, tone: 'brand' };
    const duration = formatDuration(ms);
    const spoken = spokenDuration(ms);
    return { kind: 'warming', text: t`Warming ${duration}`, label: t`Warming for ${spoken}`, tone: 'brand' };
  }
  if (!isShownLive(env)) {
    const ms = since(env.metro?.lastStop?.at, now);
    if (ms === null) return { kind: 'idle', text: t`Idle`, label: t`Idle`, tone: 'tertiary' };
    const duration = formatDuration(ms);
    const spoken = spokenDuration(ms);
    return { kind: 'idle', text: t`Idle ${duration}`, label: t`Idle for ${spoken}`, tone: 'tertiary' };
  }
  const driven = devicesOf(env).filter((d) => d.running && d.activity?.state === 'driven');
  if (driven.length) {
    const ms = drivenSince(driven, now);
    if (ms === null) return { kind: 'driven', text: t`Driven`, label: t`Driven by an agent`, tone: 'brand' };
    const duration = formatDuration(ms);
    const spoken = spokenDuration(ms);
    return { kind: 'driven', text: t`Driven ${duration}`, label: t`Driven by an agent for ${spoken}`, tone: 'brand' };
  }
  return { kind: 'running', text: t`Running`, label: t`Running`, tone: 'success' };
}

export interface RowProblem {
  kind: 'errors' | 'build-failed' | 'app-closed' | 'ci-failing' | 'issues' | 'warnings' | 'supervisor';
  text: string;
  tone: Extract<Tone, 'error' | 'warning'>;
}

const PLATFORMS: Platform[] = ['ios', 'android'];

/**
 * What is wrong with the workspace, errors before warnings. A failed build shows while the workspace is live, or for a
 * day after it failed, as in Needs attention.
 */
export function rowProblems(env: EnvironmentState, now: number): RowProblem[] {
  const problems: RowProblem[] = [];
  const errors = env.logs?.errorsSinceMarker ?? 0;
  if (errors > 0)
    problems.push({ kind: 'errors', text: plural(errors, { one: '# error', other: '# errors' }), tone: 'error' });
  const build = runningBuild(env);
  for (const platform of PLATFORMS) {
    const last = env.lastBuilds?.[platform];
    if (last?.status !== 'failed' || build?.platform === platform) continue;
    const age = since(last.finishedAt ?? last.startedAt, now);
    if (!isShownLive(env) && (age === null || age >= STALE_MS)) continue;
    const name = platformName(platform);
    problems.push({ kind: 'build-failed', text: t`${name} build failed`, tone: 'error' });
  }
  for (const device of orderDevices(devicesOf(env))) {
    if (appPresence(env, device) !== 'closed') continue;
    const name = platformName(device.platform);
    problems.push({ kind: 'app-closed', text: t`${name} app closed`, tone: 'error' });
  }
  if ((env.worktree?.pullRequest?.checks?.failing ?? 0) > 0) {
    problems.push({ kind: 'ci-failing', text: t`CI failing`, tone: 'error' });
  }
  const warnings = env.warnings.length;
  if (warnings > 0) {
    problems.push(
      env.issues?.some((issue) => issue.severity === 'error')
        ? { kind: 'issues', text: plural(warnings, { one: '# issue', other: '# issues' }), tone: 'error' }
        : { kind: 'warnings', text: plural(warnings, { one: '# warning', other: '# warnings' }), tone: 'warning' },
    );
  }
  if (env.supervisor && !env.supervisor.healthy) {
    problems.push({ kind: 'supervisor', text: t`Supervisor unhealthy`, tone: 'warning' });
  }
  return problems;
}

/** The step of a workspace `stim worktree warm` is preparing. */
export function warmStepText(env: EnvironmentState): string {
  return env.warmStep === 'copy' ? t`Copying ignored files` : t`Installing dependencies`;
}

export interface RowDevices {
  /** Running devices by kind, such as "2 iOS, Android, iOS device". */
  names: string | null;
  /** The tools driving any of them, each named once. */
  drivers: string | null;
  /** How long since any running device was used, once that is 10 minutes or more and none is driven. */
  idle: { text: string; label: string } | null;
  remote: number;
}

const kindName = (d: DeviceRef) => {
  const name = platformName(d.platform);
  return d.physical ? t`${name} device` : name;
};

export function rowDevices(env: EnvironmentState, now: number): RowDevices {
  const running = orderDevices(devicesOf(env)).filter((d) => d.running);
  const counts = new Map<string, number>();
  for (const d of running) counts.set(kindName(d), (counts.get(kindName(d)) ?? 0) + 1);
  const names = counts.size ? [...counts].map(([name, n]) => (n > 1 ? `${n} ${name}` : name)).join(', ') : null;
  const unknownTool = t`unknown tool`;
  const tools = [
    ...new Set(
      running.filter((d) => d.activity?.state === 'driven').map((d) => d.activity?.driver?.tool ?? unknownTool),
    ),
  ];
  let idle: RowDevices['idle'] = null;
  const activities = running.map((d) => d.activity).filter((a) => a !== undefined && a.state !== 'unknown');
  if (!tools.length && activities.length && activities.every((a) => a?.state === 'idle')) {
    const last = Math.max(...activities.map((a) => Date.parse(a?.lastActivityAt ?? '')).filter(Number.isFinite));
    if (Number.isFinite(last) && now - last >= ACTIVE_WINDOW_MS) {
      const duration = formatDuration(now - last);
      const spoken = spokenDuration(now - last);
      idle = { text: t`idle ${duration}`, label: t`idle for ${spoken}` };
    }
  }
  return { names, drivers: tools.length ? tools.join(', ') : null, idle, remote: env.remoteDevices?.length ?? 0 };
}

/**
 * Everything the row shows, spoken, since the row is one accessibility element: the state, the agent session, what is
 * wrong, the build step, the devices and who drives them, the git state and, when they tell rows apart, the folder
 * and the machine.
 */
export function rowLabel({
  item,
  now,
  status,
  problems,
  sessions,
  folder,
  showsMachine,
}: {
  item: HomeItem;
  now: number;
  status: RowStatus;
  problems: RowProblem[];
  sessions: AgentSession[];
  folder: boolean;
  showsMachine: boolean;
}): string {
  const { env, macName } = item;
  const build = runningBuild(env);
  const phase = build ? currentPhaseLabel(build) : null;
  const running = orderDevices(devicesOf(env)).filter((d) => d.running);
  const devices = running.map((d) => {
    const kind = kindName(d);
    const { slot } = d;
    const name = slot === 'default' ? kind : t`${kind} slot ${slot}`;
    const activity = activityLabel(d.activity, now);
    return activity ? t`${name}, ${activity}` : t`${name} running`;
  });
  const { remote } = rowDevices(env, now);
  return [
    item.title,
    build && status.kind === 'building'
      ? [buildLabel(build, now), phase?.counts].filter(Boolean).join(', ')
      : status.kind === 'driven'
        ? null
        : status.label,
    isSettingUp(env) && env.phase === 'warming' ? warmStepText(env) : null,
    agentsSummary(sessions),
    ...problems.map((p) => p.text),
    ...devices,
    remote ? plural(remote, { one: '# EAS session', other: '# EAS sessions' }) : null,
    gitChip(env.worktree)?.label,
    folder ? item.inCheckout : null,
    showsMachine ? t`on ${macName}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
