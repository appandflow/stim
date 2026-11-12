import { send, type ConnectionContext } from './context.ts';
import type { RequestId } from '../protocol.ts';
import { isJsonObject } from '@stim-cli/core/state';
import { readWorkspaceDiff } from '../workspace-diff.ts';
import { createStim } from 'stim/internal/api-self';

export function workspaceChanges(
  ctx: ConnectionContext,
  id: RequestId,
  method: 'workspace.files' | 'workspace.diff',
  params: unknown,
): void {
  const needsPath = method === 'workspace.diff';
  if (
    !isJsonObject(params) ||
    typeof params.workspace !== 'string' ||
    !params.workspace.length ||
    params.workspace.length > 4096 ||
    params.workspace.includes('\0') ||
    (!needsPath && params.group !== 'changed' && params.group !== 'untracked') ||
    (needsPath &&
      (typeof params.path !== 'string' ||
        !params.path.length ||
        params.path.length > 4096 ||
        params.path.includes('\0'))) ||
    Object.keys(params).some((key) => key !== 'workspace' && !(needsPath ? key === 'path' : key === 'group'))
  ) {
    return ctx.error(id, 'bad-request', 'Workspace diff requires workspace and, for a patch, a file path.');
  }
  const cwd = ctx.workspaceDir(id, params.workspace, true);
  if (!cwd) return;
  if (ctx.slotsFull()) {
    return ctx.error(id, 'limit-exceeded', ctx.slotsMessage());
  }
  const abort = new AbortController();
  let task: Promise<void>;
  const cancel = async () => {
    abort.abort();
    await task;
  };
  ctx.holdSlot(cancel);
  ctx.running.add(cancel);
  task = readWorkspaceDiff(
    cwd,
    needsPath ? (params.path as string) : undefined,
    ctx.options.env,
    abort.signal,
    !needsPath ? (params.group as 'changed' | 'untracked') : undefined,
  )
    .then(
      (result) => {
        if (!abort.signal.aborted) send(ctx.socket, { id, result });
        return undefined;
      },
      (cause: Error) => {
        if (!abort.signal.aborted) ctx.error(id, 'stim-failed', cause.message);
        return undefined;
      },
    )
    .finally(() => {
      ctx.releaseSlot(cancel);
      ctx.running.delete(cancel);
    });
  return;
}

export function workspaceCommand(
  ctx: ConnectionContext,
  id: RequestId,
  method: 'stats.get' | 'settings.get',
  params: unknown,
): void {
  if (params !== undefined && !isJsonObject(params)) return ctx.error(id, 'bad-request', 'params must be an object.');
  const cwd = ctx.workspaceDir(id, params?.workspace, false);
  if (!cwd) return;
  if (method === 'settings.get') {
    return void ctx.inProcessRead<'settings.get'>(id, 'stim settings', (signal) =>
      createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).settings({ signal }),
    );
  }
  return void ctx.inProcessRead<'stats.get'>(id, 'stim stats', (signal) =>
    createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).stats({ signal }),
  );
}
