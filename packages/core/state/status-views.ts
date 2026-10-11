import type { ArchivedWorkspace } from './archive.ts';
import type { MaintenanceStatus } from './maintenance.ts';
import type {
  AgentSession,
  BuildDiagnostic,
  BuildHistoryEntry,
  EndedAgentSession,
  EnvironmentState,
  LastBuildReport,
  StatusPayload,
  WorktreeFacts,
} from './status.ts';

/** The most builds per platform a workspace summary keeps: enough to show a failure streak. */
export const SUMMARY_BUILDS = 3;
/** How many of the newest archives the workspace list names. */
export const SUMMARY_ARCHIVES = 10;

/** A build as a workspace summary carries it: outcome, timing, placement and where its first located error is. */
export type SummaryBuild = Pick<
  LastBuildReport,
  | 'platform'
  | 'status'
  | 'cacheHit'
  | 'cacheSkipped'
  | 'durationMs'
  | 'startedAt'
  | 'finishedAt'
  | 'errorCode'
  | 'cause'
  | 'buildMachine'
  | 'builtOn'
> & { diagnostics?: Pick<BuildDiagnostic, 'file' | 'line'>[] };

export type SummaryHistoryEntry = SummaryBuild & Pick<BuildHistoryEntry, 'result' | 'slot'>;

type SummaryPlatforms<K extends 'lastBuilds' | 'builds', V> = Partial<
  Record<keyof NonNullable<EnvironmentState[K]>, V>
>;

/**
 * A workspace as the list of every workspace shows it: the environment `stim status --json` prints, without what only a
 * shown workspace reads. Builds keep their outcome, timing and the file and line of their first located diagnostic.
 * Each platform's history keeps its newest build, and while that one failed, the failures right before it, up to
 * {@link SUMMARY_BUILDS} builds. Agent sessions keep what names and dates them, `logs` only its
 * error count, a pull request its title, review decision and lookup time, and a macOS app its launch arguments and
 * paths. `agentDevice` stays only on a tutorial workspace.
 */
export type WorkspaceSummary = Omit<
  EnvironmentState,
  'logs' | 'agents' | 'endedAgents' | 'builds' | 'lastBuilds' | 'macos' | 'agentDevice' | 'worktree'
> & {
  worktree?:
    | (Omit<WorktreeFacts, 'pullRequest'> & {
        pullRequest?: Omit<NonNullable<WorktreeFacts['pullRequest']>, 'title' | 'reviewDecision' | 'checkedAt'> | null;
      })
    | null;
  logs?: { errorsSinceMarker: number } | null;
  agents?: Pick<AgentSession, 'tool' | 'sessionId' | 'title' | 'startedAt' | 'lastActiveAt'>[];
  endedAgents?: Pick<EndedAgentSession, 'tool' | 'sessionId' | 'title' | 'endedAt'>[];
  lastBuilds?: SummaryPlatforms<'lastBuilds', SummaryBuild>;
  builds?: SummaryPlatforms<'builds', SummaryHistoryEntry[]>;
  macos?: Omit<NonNullable<EnvironmentState['macos']>, 'arguments' | 'bundle' | 'executable'> | null;
  agentDevice?: EnvironmentState['agentDevice'];
  labelOnly?: true;
};

/** An unprovisioned worktree as the workspace list shows it. */
export type WorktreeRow = Pick<WorktreeFacts, 'path' | 'branch' | 'repository' | 'gitChip'> & {
  pullRequest?: { number: number; state: string } | null;
};

/** The archives, counted, with the newest named; the rest are read a page at a time. */
export interface ArchivedSummary {
  count: number;
  bytes: number;
  newest: Pick<ArchivedWorkspace, 'id' | 'projectRoot' | 'project' | 'workspace' | 'removedAt'>[];
}

/** The machine, as the always-visible capacity, memory and maintenance indicators show it. */
export interface MachineView {
  capacity: StatusPayload['capacity'];
  machine: StatusPayload['machine'];
  deviceLeases: StatusPayload['deviceLeases'];
  simctlAvailable: boolean;
  maintenance: Omit<MaintenanceStatus, 'recent' | 'sizes'> | null;
}

export interface StatusViews {
  workspaces: WorkspaceSummary[];
  worktrees: WorktreeRow[];
  archived: ArchivedSummary;
  machine: MachineView;
  /** The full environment of each workspace by path, as `stim status --json` prints it. */
  details: Map<string, StatusPayload['environments'][number]>;
}

function summaryBuild(build: LastBuildReport): SummaryBuild {
  const located = build.diagnostics?.find((diagnostic) => diagnostic.file && diagnostic.line !== null);
  const diagnostic = located && { file: located.file, line: located.line };
  return {
    platform: build.platform,
    status: build.status,
    cacheHit: build.cacheHit,
    cacheSkipped: build.cacheSkipped,
    durationMs: build.durationMs,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt,
    ...(build.errorCode === undefined ? {} : { errorCode: build.errorCode }),
    ...(build.cause === undefined ? {} : { cause: build.cause }),
    ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    ...(build.buildMachine === undefined ? {} : { buildMachine: build.buildMachine }),
    ...(build.builtOn === undefined ? {} : { builtOn: build.builtOn }),
  };
}

function summaryHistory(entries: readonly BuildHistoryEntry[]): SummaryHistoryEntry[] {
  const streak = entries.findIndex((entry) => entry.result !== 'failed');
  const kept = entries.slice(0, Math.min(SUMMARY_BUILDS, Math.max(1, streak === -1 ? entries.length : streak)));
  return kept.map((entry) => Object.assign(summaryBuild(entry), { result: entry.result, slot: entry.slot }));
}

function summaryWorktree({ pullRequest, ...worktree }: WorktreeFacts): NonNullable<WorkspaceSummary['worktree']> {
  if (!pullRequest) return pullRequest === undefined ? worktree : { ...worktree, pullRequest };
  const { title: _title, reviewDecision: _reviewDecision, checkedAt: _checkedAt, ...kept } = pullRequest;
  return { ...worktree, pullRequest: kept };
}

function agentSummary({ tool, sessionId, title, startedAt, lastActiveAt }: AgentSession) {
  const kept: NonNullable<WorkspaceSummary['agents']>[number] = { tool, sessionId };
  if (title !== undefined) kept.title = title;
  if (startedAt !== undefined) kept.startedAt = startedAt;
  if (lastActiveAt !== undefined) kept.lastActiveAt = lastActiveAt;
  return kept;
}

function endedAgentSummary({ tool, sessionId, title, endedAt }: EndedAgentSession) {
  const kept: NonNullable<WorkspaceSummary['endedAgents']>[number] = { tool, sessionId, endedAt };
  if (title !== undefined) kept.title = title;
  return kept;
}

/** The summary of one environment of a status payload. */
export function workspaceSummary(environment: StatusPayload['environments'][number]): WorkspaceSummary {
  const { logs, agents, endedAgents, builds, lastBuilds, macos, agentDevice, worktree, ...rest } = environment;
  return {
    ...rest,
    ...(worktree === undefined ? {} : { worktree: worktree && summaryWorktree(worktree) }),
    ...(logs === undefined ? {} : { logs: logs && { errorsSinceMarker: logs.errorsSinceMarker } }),
    ...(agents ? { agents: agents.map(agentSummary) } : {}),
    ...(endedAgents ? { endedAgents: endedAgents.map(endedAgentSummary) } : {}),
    ...(lastBuilds
      ? {
          lastBuilds: {
            ...(lastBuilds.ios ? { ios: summaryBuild(lastBuilds.ios) } : {}),
            ...(lastBuilds.android ? { android: summaryBuild(lastBuilds.android) } : {}),
          },
        }
      : {}),
    ...(builds
      ? {
          builds: {
            ...(builds.ios ? { ios: summaryHistory(builds.ios) } : {}),
            ...(builds.android ? { android: summaryHistory(builds.android) } : {}),
            ...(builds.macos ? { macos: summaryHistory(builds.macos) } : {}),
          },
        }
      : {}),
    ...(macos === undefined
      ? {}
      : {
          macos: macos && (({ arguments: _arguments, bundle: _bundle, executable: _executable, ...app }) => app)(macos),
        }),
    ...(environment.tutorial && agentDevice ? { agentDevice } : {}),
  };
}

function worktreeRow({ path, branch, repository, gitChip, pullRequest }: WorktreeFacts): WorktreeRow {
  return {
    path,
    ...(branch === undefined ? {} : { branch }),
    ...(repository === undefined ? {} : { repository }),
    ...(gitChip === undefined ? {} : { gitChip }),
    ...(pullRequest === undefined
      ? {}
      : { pullRequest: pullRequest && { number: pullRequest.number, state: pullRequest.state } }),
  };
}

/** The live views of a status payload as `stim status --json` prints it. */
export function statusViews(payload: StatusPayload): StatusViews {
  const archived = payload.archived ?? [];
  return {
    workspaces: payload.environments.map(workspaceSummary),
    worktrees: payload.unprovisionedWorktrees.map(worktreeRow),
    archived: {
      count: payload.archivedUsage?.count ?? archived.length,
      bytes: payload.archivedUsage?.bytes ?? 0,
      newest: archived
        .toSorted((a, b) => b.removedAt.localeCompare(a.removedAt))
        .slice(0, SUMMARY_ARCHIVES)
        .map(({ id, projectRoot, project, workspace, removedAt }) => ({
          id,
          projectRoot,
          project,
          workspace,
          removedAt,
        })),
    },
    machine: {
      capacity: payload.capacity,
      machine: payload.machine,
      deviceLeases: payload.deviceLeases,
      simctlAvailable: payload.simctlAvailable,
      maintenance: payload.maintenance
        ? (({ recent: _recent, sizes: _sizes, ...rest }) => rest)(payload.maintenance)
        : null,
    },
    details: new Map(payload.environments.map((environment) => [environment.path, environment])),
  };
}
