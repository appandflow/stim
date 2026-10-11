import type { ArchivedWorkspace } from './archive.ts';
import type { MaintenanceStatus } from './maintenance.ts';
import type { BuildHistoryEntry, EnvironmentState, LastBuildReport, StatusPayload, WorktreeFacts } from './status.ts';

/** How many of the newest archives the workspace list names. */
export const SUMMARY_ARCHIVES = 10;

/** A build as a workspace summary carries it: everything but its fingerprint, miss reason and later diagnostics. */
export type SummaryBuild = Omit<LastBuildReport, 'fingerprint' | 'missReason'>;

export type SummaryHistoryEntry = SummaryBuild & Pick<BuildHistoryEntry, 'result' | 'slot' | 'phases'>;

type SummaryPlatforms<K extends 'lastBuilds' | 'builds', V> = Partial<
  Record<keyof NonNullable<EnvironmentState[K]>, V>
>;

/**
 * A workspace as the list of every workspace shows it: the environment `stim status --json` prints, without what only a
 * shown workspace reads. A build drops its fingerprint, miss reason and every diagnostic but the first one with a file
 * and a line. Each platform's history keeps its newest build and, while that one failed, every failure right before
 * it, which is what a failure streak counts. `logs` keeps only its error count, a pull request drops its review
 * decision and lookup time, a macOS app its launch arguments, and `agentDevice` stays only on a tutorial workspace.
 */
export type WorkspaceSummary = Omit<
  EnvironmentState,
  'logs' | 'builds' | 'lastBuilds' | 'macos' | 'agentDevice' | 'worktree'
> & {
  logs?: { errorsSinceMarker: number } | null;
  lastBuilds?: SummaryPlatforms<'lastBuilds', SummaryBuild>;
  builds?: SummaryPlatforms<'builds', SummaryHistoryEntry[]>;
  macos?: Omit<NonNullable<EnvironmentState['macos']>, 'arguments'> | null;
  agentDevice?: EnvironmentState['agentDevice'];
  worktree?:
    | (Omit<WorktreeFacts, 'pullRequest'> & {
        pullRequest?: Omit<NonNullable<WorktreeFacts['pullRequest']>, 'reviewDecision' | 'checkedAt'> | null;
      })
    | null;
  labelOnly?: true;
};

/** An unprovisioned worktree as the workspace list shows it. */
export type WorktreeRow = Pick<WorktreeFacts, 'path' | 'branch' | 'repository' | 'git' | 'gitChip'> & {
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

function summaryBuild({
  fingerprint: _fingerprint,
  missReason: _missReason,
  diagnostics,
  ...build
}: LastBuildReport): SummaryBuild {
  const located = diagnostics?.find((diagnostic) => diagnostic.file && diagnostic.line !== null);
  const kept: SummaryBuild = build;
  if (located) kept.diagnostics = [located];
  return kept;
}

function summaryHistory(entries: readonly BuildHistoryEntry[]): SummaryHistoryEntry[] {
  const streak = entries.findIndex((entry) => entry.result !== 'failed');
  return entries
    .slice(0, Math.max(1, streak === -1 ? entries.length : streak))
    .map(
      ({ result, slot, phases, configuration: _configuration, cacheKey: _cacheKey, compileSteps: _steps, ...build }) =>
        Object.assign(summaryBuild(build), { result, slot, phases }),
    );
}

function summaryWorktree({ pullRequest, ...worktree }: WorktreeFacts): NonNullable<WorkspaceSummary['worktree']> {
  if (!pullRequest) return pullRequest === undefined ? worktree : { ...worktree, pullRequest };
  const { reviewDecision: _reviewDecision, checkedAt: _checkedAt, ...kept } = pullRequest;
  return { ...worktree, pullRequest: kept };
}

/** The summary of one environment of a status payload. */
export function workspaceSummary(environment: StatusPayload['environments'][number]): WorkspaceSummary {
  const { logs, builds, lastBuilds, macos, agentDevice, worktree, ...rest } = environment;
  const summary: WorkspaceSummary = rest;
  if (worktree !== undefined) summary.worktree = worktree && summaryWorktree(worktree);
  if (logs !== undefined) summary.logs = logs && { errorsSinceMarker: logs.errorsSinceMarker };
  if (lastBuilds) {
    summary.lastBuilds = {};
    if (lastBuilds.ios) summary.lastBuilds.ios = summaryBuild(lastBuilds.ios);
    if (lastBuilds.android) summary.lastBuilds.android = summaryBuild(lastBuilds.android);
  }
  if (builds) {
    summary.builds = {};
    for (const platform of ['ios', 'android', 'macos'] as const) {
      const entries = builds[platform];
      if (entries) summary.builds[platform] = summaryHistory(entries);
    }
  }
  if (macos !== undefined) summary.macos = macos && (({ arguments: _arguments, ...app }) => app)(macos);
  if (environment.tutorial && agentDevice) summary.agentDevice = agentDevice;
  return summary;
}

function worktreeRow({ path, branch, repository, git, gitChip, pullRequest }: WorktreeFacts): WorktreeRow {
  const row: WorktreeRow = { path };
  if (branch !== undefined) row.branch = branch;
  if (repository !== undefined) row.repository = repository;
  if (git !== undefined) row.git = git;
  if (gitChip !== undefined) row.gitChip = gitChip;
  if (pullRequest !== undefined)
    row.pullRequest = pullRequest && { number: pullRequest.number, state: pullRequest.state };
  return row;
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
      machine: payload.machine ?? null,
      deviceLeases: payload.deviceLeases,
      simctlAvailable: payload.simctlAvailable,
      maintenance: payload.maintenance
        ? (({ recent: _recent, sizes: _sizes, ...rest }) => rest)(payload.maintenance)
        : null,
    },
    details: new Map(payload.environments.map((environment) => [environment.path, environment])),
  };
}
