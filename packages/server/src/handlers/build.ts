import { send, type ConnectionContext } from './context.ts';
import { type RequestId, BUILD_METHODS, ENGINE_UPDATE_METHODS } from '../protocol.ts';
import { isJsonObject } from '@stim-cli/core/state';
import { SLOT_NAME } from '../control.ts';
import { type StimPlanOptions, StimError } from 'stim';
import { createLocalStim } from 'stim/internal/api-self';
import type { DesktopPlanRefusal } from '@stim-cli/core/protocol';
import type { PairedDevice } from '../registry.ts';
import { updateMethod } from './engine.ts';

const MAX_RETAINED_PLANS = 4;

const PLAN_TIMEOUT_MS = 150_000;

export function planBuild(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  if (!isJsonObject(params)) return ctx.error(id, 'bad-request', 'params must be an object.');
  const { platform, slot } = params;
  if (platform !== 'ios' && platform !== 'android') {
    return ctx.error(id, 'bad-request', 'params.platform must be ios or android.');
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return ctx.error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
  }
  const cwd = ctx.workspaceDir(id, params.workspace, true);
  if (!cwd) return;
  queuePlan(ctx, id, cwd, { platform, ...(slot === undefined ? {} : { slot }) }, 'build.plan');
}

export function queuePlan(
  ctx: ConnectionContext,
  id: RequestId,
  cwd: string,
  plan: StimPlanOptions,
  method: 'build.plan' | 'desktop.plan.get',
  request?: string,
): void {
  if (request !== undefined && ctx.planRequests.size >= MAX_RETAINED_PLANS) {
    ctx.error(id, 'limit-exceeded', 'Acknowledge retained plan refusals before requesting more previews.');
    return;
  }
  let unresolved: DesktopPlanRefusal | undefined;
  const finished = ctx.inProcessRead<'build.plan' | 'desktop.plan.get'>(
    id,
    `stim ${plan.platform}`,
    async (signal) => {
      try {
        return await createLocalStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).plan({
          ...plan,
          signal,
        });
      } catch (cause) {
        if (method !== 'desktop.plan.get' || !(cause instanceof StimError)) throw cause;
        const refusal = { code: cause.code, message: cause.message, remedy: cause.remedy };
        if (cause.code === 'STIM_CLAIM_UNAVAILABLE') unresolved = refusal;
        return refusal;
      }
    },
    ctx.options.commandLimits?.timeoutMs ?? PLAN_TIMEOUT_MS,
    ctx.planQueues.get(cwd) ?? null,
  );
  if (!finished) return;
  ctx.planQueues.set(cwd, finished.done);
  if (request !== undefined) ctx.planRequests.set(request, { cancel: finished.cancel, refusal: () => unresolved });
  void finished.done.finally(() => {
    if (ctx.planQueues.get(cwd) === finished.done) ctx.planQueues.delete(cwd);
    if (request !== undefined && ctx.planRequests.get(request)?.cancel === finished.cancel && !unresolved)
      ctx.planRequests.delete(request);
  });
}

async function jobMethod(ctx: ConnectionContext, id: RequestId, params: unknown, session: PairedDevice): Promise<void> {
  if (!ctx.buildAllowed(session)) {
    return ctx.error(id, 'forbidden', 'job.start needs build access, which this machine has not granted this device.');
  }
  ctx.builds.serve(session.id);
  const answer = await ctx.jobs.start({ id: session.id, name: session.name }, ctx.socket, params);
  send(ctx.socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
}

export function machineMethod(
  ctx: ConnectionContext,
  id: RequestId,
  method: string,
  params: unknown,
  session: PairedDevice,
): Promise<void> | null {
  if ((BUILD_METHODS as readonly string[]).includes(method)) return jobMethod(ctx, id, params, session);
  if ((ENGINE_UPDATE_METHODS as readonly string[]).includes(method))
    return updateMethod(ctx, id, method, params, session);
  return null;
}
