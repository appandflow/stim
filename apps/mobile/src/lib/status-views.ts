import {
  applyKeyedDelta,
  type ArchivedSummary,
  type ArchivedWorkspace,
  type EnvironmentState,
  type MachineEvent,
  type StatusPayload,
  type WorkspacesEvent,
  type WorktreeRow,
} from '@/protocol/types';

/**
 * A Mac's status as stim-server's view subscriptions describe it: the workspace list from `workspaces` events, the
 * machine from `machine` events, the archives read with `archived.list`, and the full environment of each workspace
 * a screen follows with `workspace.subscribe`. `nextSeq` is null until the first snapshot.
 */
export interface StatusViews {
  nextSeq: number | null;
  workspaces: EnvironmentState[];
  worktrees: WorktreeRow[];
  archivedSummary: ArchivedSummary | null;
  machine: MachineEvent['machine'] | null;
  ownLeases: string[] | undefined;
  archives: { archived: ArchivedWorkspace[]; usage: NonNullable<StatusPayload['archivedUsage']> } | null;
  details: Record<string, EnvironmentState>;
}

export const EMPTY_VIEWS: StatusViews = {
  nextSeq: null,
  workspaces: [],
  worktrees: [],
  archivedSummary: null,
  machine: null,
  ownLeases: undefined,
  archives: null,
  details: {},
};

const byPath = (entity: { path: string }) => entity.path;

/** The views after one `workspaces` event, or `'gap'` when an event before it is missing. */
export function applyWorkspaces(views: StatusViews, event: WorkspacesEvent): StatusViews | 'gap' {
  if (event.snapshot) {
    return {
      ...views,
      nextSeq: event.seq + 1,
      workspaces: event.snapshot.workspaces,
      worktrees: event.snapshot.worktrees,
      archivedSummary: event.snapshot.archived,
    };
  }
  if (event.seq !== views.nextSeq) return 'gap';
  return {
    ...views,
    nextSeq: event.seq + 1,
    workspaces: event.workspaces ? applyKeyedDelta(views.workspaces, event.workspaces, byPath) : views.workspaces,
    worktrees: event.worktrees ? applyKeyedDelta(views.worktrees, event.worktrees, byPath) : views.worktrees,
    archivedSummary: event.archived ?? views.archivedSummary,
  };
}

/**
 * The status payload these views describe, shaped like `stim status --json`; null before the first snapshot. Until
 * the archives are read, it keeps those of `shown`, the status shown before.
 */
export function viewsPayload(views: StatusViews, shown: StatusPayload | null = null): StatusPayload | null {
  if (views.nextSeq === null || !views.machine) return null;
  const { capacity, machine, deviceLeases, simctlAvailable, maintenance } = views.machine;
  const archives =
    views.archives ??
    (shown?.archived && shown.archivedUsage ? { archived: shown.archived, usage: shown.archivedUsage } : null);
  return {
    environments: views.workspaces.map((workspace) => views.details[workspace.path] ?? workspace),
    unprovisionedWorktrees: views.worktrees,
    capacity,
    machine,
    deviceLeases,
    simctlAvailable,
    ...(maintenance ? { maintenance } : {}),
    ...(archives ? { archived: archives.archived, archivedUsage: archives.usage } : {}),
    ...(views.ownLeases ? { ownLeases: views.ownLeases } : {}),
  };
}
