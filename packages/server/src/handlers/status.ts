import {
  type ArchivedWorkspace,
  KeyedEntities,
  type WorkspaceSummary,
  type WorktreeRow,
  isJsonObject,
  type StatusPayload,
  archivedUsage,
} from '@stim-cli/core/state';
import { send, type ConnectionContext } from './context.ts';
import { type RequestId, type Methods, type ErrorCode, ARCHIVED_PAGE_LIMIT } from '../protocol.ts';

const archiveCursor = (archive: ArchivedWorkspace) => `${archive.removedAt}|${archive.id}`;

function lastCursor(page: readonly ArchivedWorkspace[]): string | null {
  const last = page.at(-1);
  return last ? archiveCursor(last) : null;
}

export function subscribeWorkspaces(ctx: ConnectionContext, id: RequestId): void {
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  const workspaces = new KeyedEntities<WorkspaceSummary>((workspace) => workspace.path);
  const worktrees = new KeyedEntities<WorktreeRow>((worktree) => worktree.path);
  let archived: string | null = null;
  let seq = 0;
  const unsubscribe = ctx.statusFeed.subscribe({
    item: (payload) => {
      const views = ctx.viewsOf(payload);
      const archivedText = JSON.stringify(views.archived);
      if (archived === null) {
        workspaces.reset(views.workspaces);
        worktrees.reset(views.worktrees);
        archived = archivedText;
        const { workspaces: summaries, worktrees: rows, archived: summary } = views;
        return send(ctx.socket, {
          event: 'workspaces',
          subscription,
          seq: seq++,
          snapshot: { workspaces: summaries, worktrees: rows, archived: summary },
        });
      }
      const changedWorkspaces = workspaces.next(views.workspaces);
      const changedWorktrees = worktrees.next(views.worktrees);
      const archivedChanged = archivedText !== archived;
      archived = archivedText;
      if (!changedWorkspaces && !changedWorktrees && !archivedChanged) return;
      send(ctx.socket, {
        event: 'workspaces',
        subscription,
        seq: seq++,
        ...(changedWorkspaces ? { workspaces: changedWorkspaces } : {}),
        ...(changedWorktrees ? { worktrees: changedWorktrees } : {}),
        ...(archivedChanged ? { archived: views.archived } : {}),
      });
    },
    failed: (message) => {
      ctx.subscriptions.delete(subscription);
      send(ctx.socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
    },
  });
  ctx.subscriptions.set(subscription, unsubscribe);
}

export function subscribeWorkspace(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  const workspace = isJsonObject(params) ? params.workspace : undefined;
  if (typeof workspace !== 'string' || !workspace)
    return ctx.error(id, 'bad-request', 'params.workspace must be a workspace path from the workspace list.');
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  let last: string | null = null;
  let seq = 0;
  const unsubscribe = ctx.statusFeed.subscribe({
    item: (payload) => {
      const environment = ctx.viewsOf(payload).details.get(workspace) ?? null;
      const text = JSON.stringify(environment);
      if (text === last) return;
      last = text;
      send(ctx.socket, { event: 'workspace', subscription, seq: seq++, environment });
    },
    failed: (message) => {
      ctx.subscriptions.delete(subscription);
      send(ctx.socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
    },
  });
  ctx.subscriptions.set(subscription, unsubscribe);
}

export function subscribeMachine(ctx: ConnectionContext, id: RequestId): void {
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  const stopUsage = ctx.recordUsage();
  let last: string | null = null;
  let seq = 0;
  const unsubscribe = ctx.statusFeed.subscribe({
    item: (payload) => {
      const history = ctx.usage.history();
      const leases = ctx.control.ownLeaseTimes();
      const event = {
        machine: ctx.viewsOf(payload).machine,
        ...(history ? { usage: history } : {}),
        ...(leases.length ? { ownLeases: leases } : {}),
      };
      const text = JSON.stringify(event);
      if (text === last) return;
      last = text;
      send(ctx.socket, { event: 'machine', subscription, seq: seq++, ...event });
    },
    failed: (message) => {
      stopUsage();
      ctx.subscriptions.delete(subscription);
      send(ctx.socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
    },
  });
  ctx.subscriptions.set(subscription, () => {
    stopUsage();
    unsubscribe();
  });
}

export async function statusRead<M extends 'builds.history' | 'archived.list' | 'worktrees.list' | 'maintenance.get'>(
  ctx: ConnectionContext,
  id: RequestId,
  read: (payload: StatusPayload) => { result: Methods[M]['result'] } | { code: ErrorCode; message: string },
): Promise<void> {
  const status = await ctx.currentStatus();
  if (ctx.socket.readyState !== ctx.socket.OPEN) return;
  if ('failed' in status) return ctx.error(id, 'status-failed', status.failed);
  const answer = read(status.payload);
  if ('code' in answer) return ctx.error(id, answer.code, answer.message);
  send(ctx.socket, { id, result: answer.result });
}

export function readBuildsHistory(ctx: ConnectionContext, id: RequestId, params: unknown): Promise<void> {
  const workspace = isJsonObject(params) ? params.workspace : undefined;
  return statusRead<'builds.history'>(ctx, id, (payload) => {
    const environment = payload.environments.find((each) => each.path === workspace);
    if (!environment) return { code: 'unknown-workspace', message: 'No workspace has that path.' };
    return { result: { builds: environment.builds ?? {} } };
  });
}

export function listArchived(ctx: ConnectionContext, id: RequestId, params: unknown): Promise<void> {
  const before = isJsonObject(params) && typeof params.before === 'string' ? params.before : null;
  const requested = isJsonObject(params) && typeof params.limit === 'number' ? params.limit : ARCHIVED_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(ARCHIVED_PAGE_LIMIT, Math.floor(requested)));
  return statusRead<'archived.list'>(ctx, id, (payload) => {
    const archives = payload.archived ?? [];
    const newest = archives.toSorted((a, b) => archiveCursor(b).localeCompare(archiveCursor(a)));
    const from = before === null ? 0 : newest.findIndex((archive) => archiveCursor(archive) < before);
    const page = from === -1 ? [] : newest.slice(from, from + limit);
    const more = from !== -1 && from + limit < newest.length;
    return {
      result: {
        archived: page,
        usage: payload.archivedUsage ?? archivedUsage(archives),
        next: more ? lastCursor(page) : null,
      },
    };
  });
}
