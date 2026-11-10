import { readFailure, send, auditSafely, type ConnectionContext } from './context.ts';
import type { RequestId, Methods, ErrorCode, DesktopReportTarget } from '../protocol.ts';
import type { ServeRoute } from '@stim-cli/core/protocol';
import type { PairedDevice } from '../registry.ts';
import {
  isJsonObject,
  SETTING_SCOPES,
  settingDefinition,
  type SetupCapability,
  settingsJsonSchema,
} from '@stim-cli/core/state';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { createStim, StimError, type StimPlanOptions } from 'stim';
import { SLOT_NAME } from '../control.ts';
import { decodeSecret, secretValues } from '@stim-cli/core/noise-session';
import { type DesktopSetup, startDesktopSetup, type DesktopSetupAnswer } from '../desktop-setup.ts';
import { defaultSetupDeps } from '../setup.ts';
import {
  subscribeReload,
  subscribeGc,
  subscribeMachineAccess,
  subscribeRemedy,
  subscribeWorktreeRemove,
  subscribeWorktreeWarm,
  subscribeBuild,
  subscribeRun,
  subscribeStart,
  subscribeStop,
} from './lifecycle.ts';
import { markTailnet } from '../tailnet-marker.ts';
import { queuePlan } from './build.ts';
import { subscribeLogs } from './logs.ts';

export const DETAILS_TIMEOUT_MS = 150_000;

function validPlanRequest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function writeDesktopSetting(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  if (
    !isJsonObject(params) ||
    typeof params.cwd !== 'string' ||
    !isAbsolute(params.cwd) ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    typeof params.key !== 'string' ||
    params.key.length === 0 ||
    params.key.length > 256 ||
    (params.action !== 'set' && params.action !== 'unset') ||
    (params.action === 'set' ? typeof params.value !== 'string' : 'value' in params) ||
    Object.keys(params).some((key) => !['cwd', 'key', 'scope', 'action', 'value'].includes(key))
  )
    return ctx.error(
      id,
      'bad-request',
      'Choose an absolute cwd, setting key, set/unset action and optional scope; set requires text value.',
    );
  const scope = SETTING_SCOPES.find((candidate) => candidate === params.scope);
  if (params.scope !== undefined && scope === undefined)
    return ctx.error(id, 'bad-request', 'Choose a settings scope.');
  let cwd: string;
  try {
    cwd = realpathSync(params.cwd);
    if (!lstatSync(cwd).isDirectory()) throw new Error('The settings folder is not a directory.');
  } catch (cause) {
    return ctx.error(id, 'bad-request', `Cannot change settings here: ${readFailure(cause)}`);
  }
  if (ctx.slotsFull()) return ctx.error(id, 'limit-exceeded', ctx.slotsMessage());
  if (ctx.busyWorkspaces.has(cwd)) return ctx.error(id, 'action-busy', `An action is already running in ${cwd}.`);
  const { key, action } = params;
  const value = typeof params.value === 'string' ? params.value : undefined;
  const startedAt = Date.now();
  const abort = new AbortController();
  let finished = false;
  let ok = false;
  let failureCode = 'STIM_CANCELLED';
  let writtenScope = scope;
  let admittedCwd = cwd;
  let outputBytes = 0;
  const finish = (
    reply: { result: Methods['desktop.settings.write']['result'] } | { error: { code: ErrorCode; message: string } },
  ) => {
    if (finished) return;
    if ('result' in reply && Buffer.byteLength(JSON.stringify(reply.result)) > ctx.actionLimits.maxOutputBytes)
      reply = { error: { code: 'action-failed', message: 'Settings write exceeded its output limit.' } };
    finished = true;
    if ('error' in reply) failureCode = reply.error.code;
    else if ('code' in reply.result) failureCode = reply.result.code;
    else {
      ok = true;
      writtenScope = reply.result.scope;
    }
    send(ctx.socket, { id, ...reply });
  };
  const deadline = setTimeout(() => {
    finish({
      error: {
        code: 'action-failed',
        message: `Settings write did not finish within ${ctx.actionLimits.timeoutMs / 1000} s.`,
      },
    });
    abort.abort();
  }, ctx.actionLimits.timeoutMs);
  const task = Promise.resolve()
    .then(async () => {
      const client = createStim({
        admission: 'none',
        projectRoot: cwd,
        env: ctx.options.env,
        onProgress: ({ message }) => {
          outputBytes += Buffer.byteLength(message);
          if (outputBytes > ctx.actionLimits.maxOutputBytes) {
            finish({ error: { code: 'action-failed', message: 'Settings write exceeded its output limit.' } });
            abort.abort();
          }
        },
      });
      const beforeWrite = (project: string | null) => {
        if (project && project !== cwd) {
          if (ctx.busyWorkspaces.has(project)) {
            finish({ error: { code: 'action-busy', message: `An action is already running in ${project}.` } });
            abort.abort();
            abort.signal.throwIfAborted();
          }
          ctx.busyWorkspaces.add(project);
          admittedCwd = project;
        }
      };
      const result =
        value === undefined
          ? await client.unsetSetting(key, { scope, signal: abort.signal, beforeWrite })
          : await client.setSetting(key, value, { scope, signal: abort.signal, beforeWrite });
      finish({ result });
      return undefined;
    })
    .catch((cause: unknown) => {
      if (cause instanceof StimError)
        finish({ result: { code: cause.code, message: cause.message, remedy: cause.remedy } });
      else finish({ error: { code: 'action-failed', message: readFailure(cause) } });
    })
    .finally(() => {
      clearTimeout(deadline);
      ctx.releaseSlot(cancel);
      ctx.running.delete(cancel);
      ctx.busyWorkspaces.delete(cwd);
      ctx.busyWorkspaces.delete(admittedCwd);
      auditSafely({
        at: new Date(startedAt).toISOString(),
        device: { id: owner.id, name: owner.name },
        action: `settings.${action}`,
        workspace: admittedCwd,
        setting: settingDefinition(key)?.key,
        ...(writtenScope ? { scope: writtenScope } : {}),
        ok,
        durationMs: Date.now() - startedAt,
        ...(ok ? {} : { error: { code: 'action-failed', message: failureCode } }),
      });
    });
  const cancel = async () => {
    abort.abort();
    await task;
  };
  ctx.holdSlot(cancel);
  ctx.running.add(cancel);
  ctx.busyWorkspaces.add(cwd);
}

export function desktopMethod(
  ctx: ConnectionContext,
  id: RequestId,
  method: string,
  params: unknown,
  owner: PairedDevice,
): Promise<void> | null {
  if (
    ![
      'route.setup',
      'machines.update.start',
      'machines.update.status',
      'device-host.sessions',
      'device-host.sessions.stop',
      'desktop.reports.get',
      'desktop.reports.subscribe',
      'desktop.reports.invalidate',
      'desktop.settings.get',
      'desktop.settings.schema',
      'desktop.settings.write',
      'desktop.logs.subscribe',
      'desktop.doctor.run',
      'desktop.machine-access.subscribe',
      'desktop.remedy.subscribe',
      'desktop.stop.subscribe',
      'desktop.reload.subscribe',
      'desktop.start.subscribe',
      'desktop.run.subscribe',
      'desktop.build.subscribe',
      'desktop.gc.subscribe',
      'desktop.worktree.remove.subscribe',
      'desktop.worktree.warm.subscribe',
      'desktop.plan.get',
      'desktop.plan.cancel',
      'desktop.setup.subscribe',
      'desktop.setup.answer',
    ].includes(method)
  )
    return null;
  if (!ctx.keyless && !ctx.desktopSessions.has(ctx.socket)) {
    return Promise.resolve(
      ctx.error(
        id,
        'forbidden',
        ctx.local
          ? 'This stim-server holds the private key of the Stim Desktop that started it, which this connection did not prove.'
          : `${method} works only on this machine's local Unix socket.`,
      ),
    );
  }
  if (
    ctx.options.attached &&
    [
      'desktop.start.subscribe',
      'desktop.run.subscribe',
      'desktop.build.subscribe',
      'desktop.gc.subscribe',
      'desktop.worktree.warm.subscribe',
      'desktop.worktree.remove.subscribe',
      'desktop.machine-access.subscribe',
      'desktop.remedy.subscribe',
      'desktop.setup.subscribe',
    ].includes(method)
  ) {
    ctx.error(
      id,
      'action-failed',
      'This machine is serving from an attached Stim command. After that command ends, run `stim serve` outside the agent command, then retry.',
    );
    return Promise.resolve();
  }
  if (method === 'desktop.setup.subscribe' || method === 'desktop.setup.answer') {
    if (!ctx.desktopSessions.has(ctx.socket)) {
      ctx.error(
        id,
        'forbidden',
        'Approving another machine requires the connection of the Stim Desktop that started this server.',
      );
      return Promise.resolve();
    }
    if (method === 'desktop.setup.subscribe') subscribeDesktopSetup(ctx, id, params);
    else answerDesktopSetup(ctx, id, params);
    return Promise.resolve();
  }
  if (method === 'desktop.settings.write') {
    writeDesktopSetting(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.reload.subscribe') {
    subscribeReload(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.plan.cancel') {
    if (!isJsonObject(params) || Object.keys(params).length !== 1 || !validPlanRequest(params.request)) {
      ctx.error(id, 'bad-request', 'Choose the request of this connection to cancel.');
      return Promise.resolve();
    }
    const request = params.request;
    const pending = ctx.planRequests.get(request);
    void (async () => {
      await pending?.cancel();
      const refusal = pending?.refusal();
      if (ctx.planRequests.get(request) === pending) ctx.planRequests.delete(request);
      send(ctx.socket, { id, result: { cancelled: pending !== undefined, ...(refusal ? { refusal } : {}) } });
    })();
    return Promise.resolve();
  }
  if (method === 'desktop.plan.get') {
    if (
      !isJsonObject(params) ||
      Object.keys(params).some((key) => key !== 'cwd' && key !== 'platform' && key !== 'slot' && key !== 'request') ||
      typeof params.cwd !== 'string' ||
      params.cwd.length > 4096 ||
      !isAbsolute(params.cwd) ||
      (params.request !== undefined && !validPlanRequest(params.request)) ||
      (params.platform !== 'ios' && params.platform !== 'android' && params.platform !== 'macos') ||
      (params.slot !== undefined &&
        (params.platform === 'macos' || typeof params.slot !== 'string' || !SLOT_NAME.test(params.slot)))
    ) {
      ctx.error(
        id,
        'bad-request',
        'Choose an absolute cwd and ios/android/macos platform; slot applies only to ios/android.',
      );
      return Promise.resolve();
    }
    if (typeof params.request === 'string' && ctx.planRequests.has(params.request)) {
      ctx.error(id, 'bad-request', 'This connection already has a plan with that request.');
      return Promise.resolve();
    }
    let cwd: string;
    try {
      cwd = realpathSync(params.cwd);
      if (!lstatSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      ctx.error(id, 'bad-request', 'Choose an existing project directory.');
      return Promise.resolve();
    }
    const plan: StimPlanOptions =
      params.platform === 'macos'
        ? { platform: 'macos' }
        : { platform: params.platform, ...(params.slot === undefined ? {} : { slot: params.slot }) };
    queuePlan(ctx, id, cwd, plan, 'desktop.plan.get', typeof params.request === 'string' ? params.request : undefined);
    return Promise.resolve();
  }
  const cleanupSubscriptions: Record<string, typeof subscribeGc> = {
    'desktop.machine-access.subscribe': subscribeMachineAccess,
    'desktop.remedy.subscribe': subscribeRemedy,
    'desktop.gc.subscribe': subscribeGc,
    'desktop.worktree.remove.subscribe': subscribeWorktreeRemove,
    'desktop.worktree.warm.subscribe': subscribeWorktreeWarm,
  };
  const subscribeCleanup = cleanupSubscriptions[method];
  if (subscribeCleanup) {
    subscribeCleanup(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.build.subscribe') {
    subscribeBuild(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.run.subscribe') {
    subscribeRun(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.start.subscribe') {
    subscribeStart(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.stop.subscribe') {
    subscribeStop(ctx, id, params, owner);
    return Promise.resolve();
  }
  if (method === 'desktop.doctor.run') {
    if (
      !isJsonObject(params) ||
      Object.keys(params).some((key) => key !== 'cwd' && key !== 'platform') ||
      typeof params.cwd !== 'string' ||
      params.cwd.length > 4096 ||
      !isAbsolute(params.cwd) ||
      (params.platform !== undefined && params.platform !== 'ios' && params.platform !== 'android')
    ) {
      ctx.error(id, 'bad-request', 'Run project doctor with an absolute cwd and optional ios/android platform.');
      return Promise.resolve();
    }
    const cwd = resolvePath(params.cwd);
    const platform = params.platform === 'ios' || params.platform === 'android' ? params.platform : undefined;
    ctx.inProcessRead<'desktop.doctor.run'>(
      id,
      'stim doctor',
      async (signal) => ({
        ...(await createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).doctor({
          signal,
          platform,
          record: true,
        })),
      }),
      ctx.options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS,
    );
    return Promise.resolve();
  }
  if (method === 'desktop.settings.schema' || method === 'desktop.settings.get') {
    readDesktopSettings(ctx, id, method, params);
    return Promise.resolve();
  }
  if (method === 'desktop.logs.subscribe') {
    if (
      !isJsonObject(params) ||
      Object.keys(params).some((key) => !['workspace', 'sources', 'level', 'grep', 'errors'].includes(key))
    ) {
      ctx.error(id, 'bad-request', 'Choose a workspace and optional sources, level, grep or errors filter.');
      return Promise.resolve();
    }
    return Promise.resolve(subscribeLogs(ctx, id, params, true));
  }
  if (method.startsWith('desktop.reports.')) {
    desktopReport(ctx, id, method, params);
    return Promise.resolve();
  }
  if (method.startsWith('device-host.sessions')) return hostedSessions(ctx, id, method, params);
  return method === 'route.setup' ? setupRoute(ctx, id, params) : updateMachine(ctx, id, method, params);
}

function subscribeDesktopSetup(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'ticket' && key !== 'expires' && key !== 'capabilities') ||
    typeof params.ticket !== 'string' ||
    typeof params.expires !== 'string' ||
    !Array.isArray(params.capabilities) ||
    !params.capabilities.length ||
    new Set(params.capabilities).size !== params.capabilities.length
  )
    return ctx.error(id, 'bad-request', 'Choose a setup ticket, its expiry and build or device-host.');
  const capabilities = params.capabilities.filter(
    (capability): capability is SetupCapability => capability === 'build' || capability === 'device-host',
  );
  if (capabilities.length !== params.capabilities.length)
    return ctx.error(id, 'bad-request', 'Choose a setup ticket, its expiry and build or device-host.');
  const port = ctx.addresses[0]?.port;
  if (port === undefined) return ctx.error(id, 'bad-request', 'This server has no port for setup to use.');
  const ticket = decodeSecret(params.ticket);
  if (ticket && ctx.setupRuns.has(secretValues(ticket).journal))
    return ctx.error(id, 'bad-request', 'This connection already has that setup request open.');
  let subscription: string | null = null;
  let run: DesktopSetup;
  try {
    run = startDesktopSetup(
      { ticket: params.ticket, expires: params.expires, capabilities },
      port,
      ctx.options.serverVersion,
      (ctx.options.setupDeps ?? defaultSetupDeps)(),
      {
        progress: (journal, asking) => {
          if (subscription) send(ctx.socket, { event: 'desktop-setup-progress', subscription, journal, asking });
        },
        ended: (exitCode, output) => {
          ctx.setupRuns.delete(run.journal);
          if (subscription) send(ctx.socket, { event: 'desktop-setup-ended', subscription, exitCode, output });
        },
      },
    );
  } catch (cause) {
    return ctx.error(id, 'bad-request', cause instanceof Error ? cause.message : String(cause));
  }
  void ctx.cancelling.track(run.done);
  subscription = ctx.openSubscription(id);
  if (!subscription) return run.stop();
  ctx.setupRuns.set(run.journal, run);
  ctx.subscriptions.set(subscription, () => {
    run.stop();
    return run.done;
  });
}

function answerDesktopSetup(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  const given: DesktopSetupAnswer | null = !isJsonObject(params)
    ? null
    : (params.answer === 'approve' || params.answer === 'refuse') &&
        (params.capability === 'build' || params.capability === 'device-host') &&
        Object.keys(params).every((key) => key === 'journal' || key === 'answer' || key === 'capability')
      ? { answer: params.answer, capability: params.capability }
      : params.answer === 'skip' &&
          (params.permission === 'screenRecording' || params.permission === 'deviceControl') &&
          Object.keys(params).every((key) => key === 'journal' || key === 'answer' || key === 'permission')
        ? { answer: 'skip', permission: params.permission }
        : null;
  if (!given || !isJsonObject(params) || typeof params.journal !== 'string')
    return ctx.error(
      id,
      'bad-request',
      'Answer a setup request of this connection: approve or refuse with its capability, or skip with its permission.',
    );
  if (!ctx.setupRuns.get(params.journal)?.answer(given))
    return ctx.error(id, 'bad-request', 'No setup request of this connection is waiting for that answer.');
  send(ctx.socket, { id, result: {} });
}

function readDesktopSettings(ctx: ConnectionContext, id: RequestId, method: string, params: unknown): void {
  if (method === 'desktop.settings.schema') {
    if (params !== undefined && (!isJsonObject(params) || Object.keys(params).length)) {
      return ctx.error(id, 'bad-request', 'desktop.settings.schema takes no parameters.');
    }
    return send(ctx.socket, { id, result: settingsJsonSchema() });
  }
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd') ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    !isAbsolute(params.cwd)
  ) {
    return ctx.error(id, 'bad-request', 'Choose settings with an absolute cwd.');
  }
  const cwd = resolvePath(params.cwd);
  ctx.inProcessRead<'desktop.settings.get'>(id, 'stim settings', (signal) =>
    createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).settings({ signal }),
  );
}

function desktopReport(ctx: ConnectionContext, id: RequestId, method: string, params: unknown): void {
  if (
    method === 'desktop.reports.invalidate' &&
    (params === undefined || (isJsonObject(params) && !Object.keys(params).length))
  ) {
    ctx.desktopReports.invalidate();
    return send(ctx.socket, { id, result: {} });
  }
  if (
    !isJsonObject(params) ||
    !['doctor', 'gc', 'gc-history', 'builds', 'remote'].includes(String(params.report)) ||
    Object.keys(params).some(
      (key) => key !== 'report' && (params.report !== 'doctor' || (key !== 'cwd' && key !== 'platform')),
    ) ||
    (params.report === 'doctor' &&
      (typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        !isAbsolute(params.cwd) ||
        (params.platform !== undefined && params.platform !== 'ios' && params.platform !== 'android')))
  )
    return ctx.error(
      id,
      'bad-request',
      'Choose report gc, gc-history, builds or remote, or report doctor with an absolute cwd and optional ios/android platform.',
    );
  const target: DesktopReportTarget =
    params.report === 'gc' || params.report === 'gc-history' || params.report === 'builds' || params.report === 'remote'
      ? { report: params.report }
      : {
          report: 'doctor',
          cwd: resolvePath(String(params.cwd)),
          ...(params.platform === 'ios' || params.platform === 'android' ? { platform: params.platform } : {}),
        };
  if (method === 'desktop.reports.invalidate') {
    ctx.desktopReports.invalidate(target);
    return send(ctx.socket, { id, result: {} });
  }
  if (method === 'desktop.reports.get') {
    return void ctx.inProcessRead<'desktop.reports.get'>(
      id,
      `stim ${target.report}`,
      async (signal) => {
        const snapshot = await ctx.desktopReports.get(target, signal);
        if (snapshot.error) throw new Error(snapshot.error);
        return snapshot;
      },
      ctx.options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS,
      null,
      true,
    );
  }
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  ctx.subscriptions.set(
    subscription,
    ctx.desktopReports.subscribe(target, (snapshot) =>
      send(ctx.socket, { event: 'desktop-report', subscription, target, snapshot }),
    ),
  );
}

async function hostedSessions(ctx: ConnectionContext, id: RequestId, method: string, params: unknown): Promise<void> {
  if (
    method === 'device-host.sessions' &&
    params !== undefined &&
    (!isJsonObject(params) || Object.keys(params).length)
  )
    return ctx.error(id, 'bad-request', 'device-host.sessions takes no parameters.');
  if (
    method === 'device-host.sessions.stop' &&
    (!isJsonObject(params) ||
      typeof params.session !== 'string' ||
      Object.keys(params).some((key) => key !== 'session'))
  )
    return ctx.error(id, 'bad-request', 'device-host.sessions.stop needs params.session.');
  const answer =
    method === 'device-host.sessions'
      ? ctx.hostedDevices.sessions()
      : ctx.hostedDevices.stopForPerson((params as { session: string }).session);
  return send(ctx.socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
}

async function setupRoute(ctx: ConnectionContext, id: RequestId, params: unknown): Promise<void> {
  if (params !== undefined && (!isJsonObject(params) || Object.keys(params).length)) {
    return ctx.error(id, 'bad-request', 'route.setup takes no parameters.');
  }
  ctx.settingUpRoute ??= exposeServer(ctx).finally(() => {
    ctx.settingUpRoute = null;
  });
  try {
    return send(ctx.socket, { id, result: await ctx.settingUpRoute });
  } catch (cause) {
    return ctx.error(id, 'action-failed', (cause as Error).message);
  }
}

async function exposeServer(ctx: ConnectionContext): Promise<ServeRoute> {
  markTailnet('route.setup');
  const transport = await ctx.tailnet.load('route.setup');
  if (!transport) throw new Error('The Tailscale transport could not load; see the stim-server log.');
  return transport.expose({ port: ctx.addresses[0]!.port });
}

async function updateMachine(ctx: ConnectionContext, id: RequestId, method: string, params: unknown): Promise<void> {
  const machine = isJsonObject(params) ? params.machine : undefined;
  if (typeof machine !== 'string' || !machine) return ctx.error(id, 'bad-request', 'params.machine names the machine.');
  const answer =
    method === 'machines.update.start'
      ? await ctx.machineUpdates.start(machine)
      : await ctx.machineUpdates.status(machine);
  return send(ctx.socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
}

/**
 * Admits this local-socket connection to the Desktop-only methods when it proves the bundled Desktop's private key
 * against this connection's challenge. The challenge answers one attempt, so a replayed or late proof cannot win.
 */
export function authenticateDesktop(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  const challenge = ctx.desktopChallenge;
  ctx.desktopChallenge = null;
  if (
    !ctx.local ||
    !challenge ||
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'proof') ||
    !ctx.options.desktopBootstrap?.verify(challenge.nonce, params.proof)
  ) {
    return ctx.error(id, 'forbidden', 'The private Desktop bootstrap proof of this connection is required.');
  }
  ctx.desktopSessions.add(ctx.socket);
  send(ctx.socket, { id, result: { authorized: true } });
}
