import { type CommandOutcome, type CommandLimits, STDERR_TAIL } from '../stim-command.ts';
import {
  type StimStopOptions,
  type StimProgress,
  StimError,
  type StimReloadOptions,
  type StimClient,
  type StimStartOptions,
  type StimGcItem,
  type StimWorktreeWarmOptions,
  type StimWorktreeRemoveOptions,
} from 'stim';
import { createStim } from 'stim/api-self';
import { realpathSync, lstatSync } from 'node:fs';
import {
  readFailure,
  AUDIT_FIELD_CHARS,
  registeredWorkspace,
  send,
  auditSafely,
  type ConnectionContext,
} from './context.ts';
import { isJsonObject } from '@stim-cli/core/state';
import { ClaimUnavailableError, readClaimSet } from '@stim-cli/core/ownership-claim';
import { isAbsolute } from 'node:path';
import {
  type PlatformRunOptions,
  type PlatformBuildOptions,
  type DeviceToolRequest,
  type Methods,
  type RequestId,
  type ErrorCode,
  RELOAD_PLATFORMS,
  type ProtocolError,
} from '../protocol.ts';
import type { PairedDevice } from '../registry.ts';
import { type AuditRecord, appendAudit, parseAction, actionOutcome } from '../actions.ts';
import { SLOT_NAME } from '../control.ts';
import { parsePlatformRun } from '../platform-run.ts';
import { parsePlatformBuild } from '../platform-build.ts';
import { decodeSecret } from '@stim-cli/core/noise-session';

type StopOutcome =
  | { ok: true; stdout: string; summary: string }
  | (Extract<CommandOutcome, { ok: false }> & { code?: string });

function stopAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Pick<StimStopOptions, 'slot' | 'beforeStop'> & { onProgress?: (progress: StimProgress) => void } = {},
) {
  let root = realpathSync(cwd);
  if (!lstatSync(root).isDirectory()) throw new Error('The workspace is not a directory.');
  let stderr = '';
  const client = createStim({
    admission: 'none',
    projectRoot: root,
    env,
    onProgress: ({ stream, message }) => {
      if (stream === 'stderr') stderr = (stderr + message).slice(-STDERR_TAIL);
      options.onProgress?.({ stream, message });
    },
  });
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<StopOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, message: `stim stop did not finish within ${limits.timeoutMs / 1000} s.` });
      abort.abort();
    }, limits.timeoutMs);
  });
  const drained: Promise<StopOutcome> = Promise.resolve()
    .then(() =>
      client.stop({
        slot: options.slot,
        signal: abort.signal,
        beforeStop: (workspace) => {
          options.beforeStop?.(workspace);
          root = workspace;
        },
      }),
    )
    .then(
      (result): StopOutcome => {
        const stdout = JSON.stringify({ root, ok: result.ok, ...result.outcomes });
        if (Buffer.byteLength(stdout) > limits.maxOutputBytes)
          return { ok: false, message: `stim stop printed more than ${limits.maxOutputBytes} bytes.` };
        return result.ok
          ? { ok: true, stdout, summary: result.summary }
          : { ok: false, stdout, message: `${result.summary}${stderr.trim() ? `\n${stderr.trim()}` : ''}` };
      },
      (cause: unknown): StopOutcome => ({
        ok: false,
        message: readFailure(cause),
        ...(cause instanceof StimError ? { code: cause.code } : {}),
      }),
    )
    .finally(() => clearTimeout(timer));
  return {
    outcome: Promise.race([drained, deadline]),
    drained,
    cancel: async () => {
      abort.abort();
      await drained;
    },
  };
}

type ReloadOutcome = StopOutcome & { code?: string; unresolved?: boolean };

function reloadAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Pick<StimReloadOptions, 'platform' | 'beforeReload'> & {
    onProgress?: (progress: StimProgress) => void;
  } = {},
) {
  const abort = new AbortController();
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReloadOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        code: 'STIM_RELOAD_TIMEOUT',
        message: `stim reload did not finish within ${limits.timeoutMs / 1000} s.`,
      });
      abort.abort();
    }, limits.timeoutMs);
  });
  const drained: Promise<ReloadOutcome> = Promise.resolve()
    .then(() =>
      createStim({
        admission: 'none',
        projectRoot: cwd,
        env,
        onProgress: (progress) => {
          bytes += Buffer.byteLength(progress.message);
          if (bytes > limits.maxOutputBytes)
            throw new StimError({
              code: 'STIM_OUTPUT_LIMIT',
              message: `stim reload printed more than ${limits.maxOutputBytes} bytes.`,
            });
          options.onProgress?.(progress);
        },
      }).reload({ platform: options.platform, signal: abort.signal, beforeReload: options.beforeReload }),
    )
    .then(
      (result): ReloadOutcome => {
        const shared =
          result.strategy === 'metro-broadcast'
            ? ' The request was broadcast to all connected Metro clients.'
            : result.targets && result.targets > 1
              ? ` The request addressed ${result.targets} matching devices.`
              : '';
        return {
          ok: true,
          stdout: JSON.stringify(result),
          summary: `Reload requested for ${result.appId} via ${result.strategy}.${shared} Completion is not observed; verify the expected UI and run stim logs --errors.`,
        };
      },
      (cause: unknown): ReloadOutcome => ({
        ok: false,
        message: readFailure(cause),
        ...(cause instanceof StimError
          ? {
              code: cause.code,
              stdout: JSON.stringify({ code: cause.code, message: cause.message, remedy: cause.remedy }),
              unresolved: cause.code === 'STIM_CLAIM_UNAVAILABLE',
            }
          : {}),
      }),
    )
    .then((outcome): ReloadOutcome =>
      bytes + Buffer.byteLength(outcome.stdout ?? '') > limits.maxOutputBytes
        ? {
            ok: false,
            code: 'STIM_OUTPUT_LIMIT',
            unresolved: outcome.unresolved,
            message: `stim reload printed more than ${limits.maxOutputBytes} bytes.`,
          }
        : outcome,
    )
    .finally(() => clearTimeout(timer));
  return {
    outcome: Promise.race([drained, deadline]),
    drained,
    cancel: async () => {
      abort.abort();
      await drained;
    },
  };
}

type StartOutcome = StopOutcome & {
  code?: string;
  unresolved?: boolean;
  retainedClaimRoots?: string[];
  cleanupComplete?: Promise<void>;
  cleanupSettled?: () => boolean;
};

function lifecycleAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  label: string,
  timeoutCode: string,
  execute: (client: StimClient, signal: AbortSignal) => Promise<StopOutcome>,
  onProgress?: (progress: StimProgress) => void,
) {
  const abort = new AbortController();
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);
  const drained: Promise<StartOutcome> = Promise.resolve()
    .then(() =>
      execute(
        createStim({
          admission: 'none',
          projectRoot: cwd,
          env,
          onProgress: (progress) => {
            bytes += Buffer.byteLength(progress.message);
            if (bytes > limits.maxOutputBytes)
              throw new StimError({
                code: 'STIM_OUTPUT_LIMIT',
                message: `${label} printed more than ${limits.maxOutputBytes} bytes.`,
              });
            onProgress?.(progress);
          },
        }),
        abort.signal,
      ),
    )
    .then(
      (result): StartOutcome => result,
      (cause: unknown): StartOutcome => {
        const details = cause instanceof StimError && isJsonObject(cause.details) ? cause.details.cause : undefined;
        const cleanup = cause instanceof StimError ? cause.cause : undefined;
        const settled = cleanup instanceof Error && 'cleanupSettled' in cleanup ? cleanup.cleanupSettled : undefined;
        return {
          ok: false,
          message: readFailure(cause),
          ...(cause instanceof StimError
            ? {
                code: cause.code,
                stdout: JSON.stringify({ code: cause.code, message: cause.message, remedy: cause.remedy }),
                unresolved:
                  cause.code === 'STIM_CLAIM_UNAVAILABLE' &&
                  !(cleanup instanceof ClaimUnavailableError && !('reportCleanup' in cleanup)),
                ...(typeof settled === 'function' ? { cleanupSettled: () => settled() === true } : {}),
                ...(cleanup instanceof Error &&
                'cleanupComplete' in cleanup &&
                cleanup.cleanupComplete instanceof Promise
                  ? { cleanupComplete: cleanup.cleanupComplete }
                  : {}),
                ...(isJsonObject(details) &&
                Array.isArray(details.retainedClaimRoots) &&
                details.retainedClaimRoots.every((root) => typeof root === 'string' && isAbsolute(root))
                  ? { retainedClaimRoots: details.retainedClaimRoots }
                  : {}),
              }
            : {}),
        };
      },
    )
    .then((outcome): StartOutcome =>
      !outcome.unresolved && bytes + Buffer.byteLength(outcome.stdout ?? '') > limits.maxOutputBytes
        ? {
            ok: false,
            code: 'STIM_OUTPUT_LIMIT',
            unresolved: outcome.unresolved,
            retainedClaimRoots: outcome.retainedClaimRoots,
            message: `${label} printed more than ${limits.maxOutputBytes} bytes.`,
          }
        : outcome,
    )
    .then((outcome): StartOutcome =>
      timedOut && !outcome.unresolved
        ? {
            ok: false,
            code: timeoutCode,
            message: `${label} did not finish within ${limits.timeoutMs / 1000} s.`,
          }
        : outcome,
    )
    .finally(() => clearTimeout(timer));
  return {
    outcome: drained,
    drained,
    cancel: async () => {
      abort.abort();
      return await drained;
    },
  };
}

function startAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Pick<StimStartOptions, 'remote' | 'resetCache' | 'waitSeconds' | 'beforeStart'> & {
    onProgress?: (progress: StimProgress) => void;
  } = {},
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim start',
    'STIM_METRO_TIMEOUT',
    async (client, signal) => {
      const result = await client.start({
        remote: options.remote,
        resetCache: options.resetCache,
        waitSeconds: options.waitSeconds,
        beforeStart: options.beforeStart,
        signal,
      });
      return {
        ok: true,
        stdout: JSON.stringify(result),
        summary: `Dev server ${result.alreadyRunning ? 'already running' : 'ready'} on port ${result.port}.`,
      };
    },
    options.onProgress,
  );
}

function platformRunAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: PlatformRunOptions,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    `stim ${options.platform}`,
    'STIM_RUN_FAILED',
    async (client, signal) => {
      const result = await client.run({ ...options, signal });
      const summary =
        result.platform === 'web'
          ? `${result.facts.url} ${result.facts.launched === true ? 'loaded' : result.facts.launched}. ${
              result.facts.running
                ? 'Logs: stim logs --errors.'
                : 'The owned Chrome is no longer running. Run stim logs --errors, then stim web again.'
            }`
          : `${options.platform} run completed.`;
      return { ok: true, stdout: JSON.stringify(result), summary };
    },
    onProgress,
  );
}

function platformBuildAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: PlatformBuildOptions,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    `${options.platform} build`,
    'STIM_BUILD_FAILED',
    async (client, signal) => {
      const result = await client.build({ ...options, signal });
      return { ok: true, stdout: JSON.stringify(result), summary: `${options.platform} build completed.` };
    },
    onProgress,
  );
}

function gcAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: { dryRun: boolean; pressure?: 'normal' | 'high' | 'critical' },
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim gc',
    'STIM_GC_TIMEOUT',
    async (client, signal) => {
      if (options.dryRun) {
        const report = await client.gc({ pressure: options.pressure, signal });
        return { ok: true, stdout: JSON.stringify(report), summary: 'Garbage collection dry run completed.' };
      }
      const { report, exitCode } = await client.collectGarbage({ pressure: options.pressure, signal });
      const stdout = JSON.stringify(report);
      return exitCode === 0
        ? { ok: true, stdout, summary: 'Garbage collection completed.' }
        : { ok: false, stdout, code: 'STIM_GC_FAILED', message: 'Garbage collection reported failures.' };
    },
    onProgress,
  );
}

function gcItemAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  item: StimGcItem,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim gc',
    'STIM_GC_TIMEOUT',
    async (client, signal) => {
      const { results, exitCode } = await client.deleteGarbageItem({ item, signal });
      const stdout = JSON.stringify({
        mode: 'delete',
        item,
        failures: results.filter((r) => r.status === 'failed').length,
        results,
      });
      return exitCode === 0
        ? { ok: true, stdout, summary: 'Cleanup completed.' }
        : {
            ok: false,
            stdout,
            code: 'STIM_GC_FAILED',
            message: 'Cleanup reported failures.',
            remedy: 'Read each failed result, fix its cause and delete the item again.',
          };
    },
    onProgress,
  );
}

function machineAccessAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  ticket: string | undefined,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'Machine access request',
    'STIM_REPORT_TIMEOUT',
    async (client, signal) => ({
      ok: true,
      stdout: JSON.stringify(await client.requestMachineAccess({ ticket, signal })),
      summary: 'Machine access report completed.',
    }),
    onProgress,
  );
}

function deviceToolRequest(value: unknown): DeviceToolRequest | null {
  if (!isJsonObject(value) || (value.platform !== 'ios' && value.platform !== 'android')) return null;
  const { platform } = value;
  const only = (...fields: string[]) =>
    Object.keys(value).every((key) => ['tool', 'platform', ...fields].includes(key));
  if (value.tool === 'location') {
    if (only('clear') && value.clear === true) return { tool: 'location', platform, clear: true };
    if (only('set') && typeof value.set === 'string' && value.set.length <= 256)
      return { tool: 'location', platform, set: value.set };
  } else if (
    value.tool === 'permission' &&
    only('action', 'service') &&
    (value.action === 'grant' || value.action === 'revoke' || value.action === 'reset') &&
    typeof value.service === 'string' &&
    value.service.length <= 1024
  ) {
    return { tool: 'permission', platform, action: value.action, service: value.service };
  } else if (
    value.tool === 'push' &&
    platform === 'ios' &&
    only('payload') &&
    typeof value.payload === 'string' &&
    value.payload.length <= 65_536
  ) {
    return { tool: 'push', platform, payload: value.payload };
  } else if (
    value.tool === 'network' &&
    platform === 'android' &&
    only('state') &&
    (value.state === 'on' || value.state === 'off')
  ) {
    return { tool: 'network', platform, state: value.state };
  }
  return null;
}

function remedyAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  request: Methods['desktop.remedy.subscribe']['params'],
  admit: (workspace: string) => void,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'Desktop remedy',
    'STIM_REPORT_TIMEOUT',
    async (client, signal) => {
      if (request.action === 'doctor-fix') {
        const { report, exitCode } = await client.repairDoctor({
          platform: request.platform,
          signal,
          beforeRepair: admit,
        });
        const stdout = JSON.stringify(report);
        return exitCode === 0
          ? { ok: true, stdout, summary: 'Doctor repair completed.' }
          : { ok: false, stdout, code: 'STIM_DOCTOR_REPAIR_FAILED', message: 'Doctor reported repair refusals.' };
      }
      if (request.action === 'device-tool') {
        const result = await client.deviceTool({
          request: request.request,
          slot: request.slot,
          signal,
          beforeTool: admit,
        });
        return { ok: true, stdout: JSON.stringify(result), summary: 'Device change completed.' };
      }
      const released = await client.unlockDevice({
        platform: request.platform,
        slot: request.slot,
        signal,
        beforeUnlock: admit,
      });
      return { ok: true, stdout: JSON.stringify(released), summary: `Released ${released.length} device lease(s).` };
    },
    onProgress,
  );
}

function worktreeWarmAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Omit<StimWorktreeWarmOptions, 'signal'>,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim worktree warm',
    'STIM_WORKTREE_WARM_TIMEOUT',
    async (client, signal) => {
      const result = await client.warmWorktree({ ...options, signal });
      const stdout = JSON.stringify(result);
      return result.exitCode === 0
        ? { ok: true, stdout, summary: 'Worktree warming completed.' }
        : { ok: false, stdout, code: 'STIM_WORKTREE_WARM_FAILED', message: 'Worktree warming reported failures.' };
    },
    onProgress,
  );
}

function worktreeRemoveAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Omit<StimWorktreeRemoveOptions, 'signal'>,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim worktree remove',
    'STIM_WORKTREE_REMOVE_TIMEOUT',
    async (client, signal) => {
      const result = await client.removeWorktree({ ...options, signal });
      const stdout = JSON.stringify(result);
      return result.exitCode === 0
        ? { ok: true, stdout, summary: 'Worktree cleanup completed.' }
        : { ok: false, stdout, code: 'STIM_WORKTREE_REMOVE_FAILED', message: 'Worktree cleanup reported failures.' };
    },
    onProgress,
  );
}

const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, AUDIT_FIELD_CHARS) : null);

export function runAction(ctx: ConnectionContext, id: RequestId, params: unknown, session: PairedDevice): void {
  const startedAt = Date.now();
  const raw = isJsonObject(params) ? params : {};
  const record: AuditRecord = {
    at: new Date(startedAt).toISOString(),
    device: { id: session.id, name: session.name },
    action: clip(raw.action),
    workspace: clip(raw.workspace),
    ...(typeof raw.platform === 'string' ? { platform: clip(raw.platform)! } : {}),
    ok: false,
  };
  const audit = (outcome: Pick<AuditRecord, 'ok' | 'error' | 'durationMs'>) => {
    const logged = outcome.error ? { ...outcome.error, message: clip(outcome.error.message)! } : undefined;
    try {
      appendAudit({ ...record, ...outcome, ...(logged ? { error: logged } : {}) });
    } catch (cause) {
      console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
    }
  };
  const refuseAction = (code: ErrorCode, message: string) => {
    audit({ ok: false, error: { code, message } });
    ctx.error(id, code, message);
  };
  if (!ctx.canControl(session)) {
    return refuseAction(
      'forbidden',
      `This device can only read. On the machine, run \`stim pairings grant ${session.id} --control\` to let it run actions.`,
    );
  }
  const parsed = parseAction(params);
  if ('code' in parsed) return refuseAction(parsed.code, parsed.message);
  const { action } = parsed;
  const resolved = registeredWorkspace(action.workspace);
  if ('code' in resolved) return refuseAction(resolved.code, resolved.message);
  if (ctx.slotsFull()) return refuseAction('limit-exceeded', ctx.slotsMessage());
  if (ctx.busyWorkspaces.has(resolved.dir)) {
    return refuseAction('action-busy', `An action is already running in ${resolved.dir}. Try again when it finishes.`);
  }
  let admittedCwd = resolved.dir;
  let run: ReturnType<typeof stopAction> | ReturnType<typeof reloadAction>;
  try {
    run =
      action.action === 'stop'
        ? stopAction(resolved.dir, ctx.options.env, ctx.actionLimits, {
            beforeStop: (workspace) => {
              if (workspace === resolved.dir) return;
              if (ctx.busyWorkspaces.has(workspace))
                throw new StimError({
                  code: 'STIM_ACTION_BUSY',
                  message: `An action is already running in ${workspace}.`,
                });
              ctx.busyWorkspaces.add(workspace);
              admittedCwd = workspace;
              record.workspace = clip(workspace);
            },
          })
        : reloadAction(resolved.dir, ctx.options.env, ctx.actionLimits, {
            platform: action.platform,
            beforeReload: (workspace) => {
              if (workspace === resolved.dir) return;
              if (ctx.busyWorkspaces.has(workspace))
                throw new StimError({
                  code: 'STIM_ACTION_BUSY',
                  message: `An action is already running in ${workspace}.`,
                });
              ctx.busyWorkspaces.add(workspace);
              admittedCwd = workspace;
              record.workspace = clip(workspace);
            },
          });
  } catch (cause) {
    return refuseAction('action-failed', `stim ${action.action} could not start (${(cause as Error).message}).`);
  }
  ctx.busyWorkspaces.add(resolved.dir);
  let finished = false;
  const release = (outcome: CommandOutcome & { unresolved?: boolean }) => {
    if (outcome.unresolved) return;
    ctx.releaseSlot(cancel);
    ctx.persistentActions.delete(cancel);
    ctx.running.delete(cancel);
    ctx.busyWorkspaces.delete(resolved.dir);
    ctx.busyWorkspaces.delete(admittedCwd);
  };
  const finish = (outcome: ReturnType<typeof actionOutcome>) => {
    if (finished) return;
    finished = true;
    audit({ ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), durationMs: Date.now() - startedAt });
    if (outcome.ok)
      send(ctx.socket, { id, result: { action: action.action, workspace: admittedCwd, output: outcome.output } });
    else send(ctx.socket, { id, error: outcome.error });
  };
  const cancel = async () => {
    finish({
      ok: false,
      error: { code: 'action-failed', message: 'stim-server stopped before the action finished.' },
    });
    await run.cancel();
    release(await run.drained);
  };
  ctx.holdSlot(cancel);
  ctx.persistentActions.add(cancel);
  ctx.running.add(cancel);
  void run.outcome.then((outcome) =>
    finish(
      !outcome.ok && 'code' in outcome && outcome.code === 'STIM_ACTION_BUSY'
        ? { ok: false, error: { code: 'action-busy', message: outcome.message } }
        : actionOutcome(outcome),
    ),
  );
  void run.drained.then(release);
}

export function subscribeStop(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd' && key !== 'slot') ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd) ||
    (params.slot !== undefined &&
      (typeof params.slot !== 'string' ||
        !SLOT_NAME.test(params.slot) ||
        ['constructor', 'prototype', '__proto__'].includes(params.slot)))
  ) {
    return ctx.error(id, 'bad-request', 'Stop requires an absolute cwd and an optional device slot or web.');
  }
  let cwd: string;
  try {
    cwd = realpathSync(params.cwd);
    if (!lstatSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.');
  } catch (cause) {
    return ctx.error(id, 'bad-request', `Cannot stop this workspace: ${readFailure(cause)}`);
  }
  if (ctx.busyWorkspaces.has(cwd)) return ctx.error(id, 'action-busy', `An action is already running in ${cwd}.`);
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  const startedAt = Date.now();
  let admittedCwd = cwd;
  const slot = typeof params.slot === 'string' ? params.slot : undefined;
  let observing = true;
  let terminal: StopOutcome | undefined;
  const finish = (outcome: StopOutcome) => {
    terminal ??= outcome;
    if (!observing) return;
    observing = false;
    ctx.subscriptions.delete(subscription);
    send(ctx.socket, {
      event: 'desktop-stop-ended',
      subscription,
      exitCode: outcome.ok ? 0 : 1,
      stdout: outcome.stdout ?? '',
      message: outcome.ok ? outcome.summary : outcome.message,
    });
  };
  let outputBytes = 0;
  let run: ReturnType<typeof stopAction>;
  try {
    run = stopAction(cwd, ctx.options.env, ctx.actionLimits, {
      slot,
      beforeStop: (workspace) => {
        if (workspace === cwd) return;
        if (ctx.busyWorkspaces.has(workspace))
          throw new StimError({
            code: 'STIM_ACTION_BUSY',
            message: `An action is already running in ${workspace}.`,
          });
        ctx.busyWorkspaces.add(workspace);
        admittedCwd = workspace;
      },
      onProgress: (progress) => {
        if (!observing) return;
        outputBytes += Buffer.byteLength(progress.message);
        if (outputBytes > ctx.actionLimits.maxOutputBytes) {
          finish({ ok: false, message: `stim stop printed more than ${ctx.actionLimits.maxOutputBytes} bytes.` });
          void run.cancel();
          return;
        }
        send(ctx.socket, { event: 'desktop-stop-progress', subscription, ...progress });
      },
    });
  } catch (cause) {
    finish({ ok: false, message: readFailure(cause) });
    return;
  }
  const cancel = () => run.cancel();
  ctx.busyWorkspaces.add(cwd);
  ctx.running.add(cancel);
  ctx.subscriptions.set(subscription, () => {
    observing = false;
    void cancel();
  });
  void run.outcome.then(finish);
  void run.drained.then((outcome) => {
    ctx.running.delete(cancel);
    ctx.busyWorkspaces.delete(cwd);
    ctx.busyWorkspaces.delete(admittedCwd);
    const recorded = terminal ?? outcome;
    auditSafely({
      at: new Date(startedAt).toISOString(),
      device: { id: owner.id, name: owner.name },
      action: 'stop',
      workspace: admittedCwd,
      ...(slot === undefined ? {} : { slot }),
      ok: recorded.ok,
      durationMs: Date.now() - startedAt,
      ...(recorded.ok
        ? {}
        : { error: { code: 'action-failed', message: recorded.message.slice(0, AUDIT_FIELD_CHARS) } }),
    });
    return undefined;
  });
}

export function subscribeReload(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd' && key !== 'platform') ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd)
  )
    return ctx.error(
      id,
      'bad-request',
      'Reload requires an absolute cwd and an optional ios, android or web platform.',
    );
  const platform = RELOAD_PLATFORMS.find((candidate) => candidate === params.platform);
  if (params.platform !== undefined && platform === undefined)
    return ctx.error(id, 'bad-request', 'Choose ios, android or web for reload.');
  let cwd: string;
  try {
    cwd = realpathSync(params.cwd);
    if (!lstatSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.');
  } catch (cause) {
    return ctx.error(id, 'bad-request', `Cannot reload this workspace: ${readFailure(cause)}`);
  }
  if (ctx.slotsFull()) return ctx.error(id, 'limit-exceeded', ctx.slotsMessage());
  if (ctx.busyWorkspaces.has(cwd)) return ctx.error(id, 'action-busy', `An action is already running in ${cwd}.`);
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  const startedAt = Date.now();
  let admittedCwd = cwd;
  let observing = true;
  let terminal: ReloadOutcome | undefined;
  const finish = (outcome: ReloadOutcome) => {
    terminal ??= outcome;
    if (!observing) return;
    observing = false;
    ctx.subscriptions.delete(subscription);
    send(ctx.socket, {
      event: 'desktop-reload-ended',
      subscription,
      exitCode: outcome.ok ? 0 : 1,
      stdout: outcome.stdout ?? '',
      message: outcome.ok ? outcome.summary : outcome.message,
    });
  };
  const run = reloadAction(cwd, ctx.options.env, ctx.actionLimits, {
    platform,
    beforeReload: (workspace) => {
      if (workspace === cwd) return;
      if (ctx.busyWorkspaces.has(workspace))
        throw new StimError({ code: 'STIM_ACTION_BUSY', message: `An action is already running in ${workspace}.` });
      ctx.busyWorkspaces.add(workspace);
      admittedCwd = workspace;
    },
    onProgress: (progress) => {
      if (observing) send(ctx.socket, { event: 'desktop-reload-progress', subscription, ...progress });
    },
  });
  const cancel = () => run.cancel();
  ctx.holdSlot(cancel);
  ctx.running.add(cancel);
  ctx.busyWorkspaces.add(cwd);
  ctx.subscriptions.set(subscription, () => {
    observing = false;
    void cancel();
  });
  void run.outcome.then(finish);
  void run.drained.then((outcome) => {
    if (!outcome.unresolved) {
      ctx.releaseSlot(cancel);
      ctx.running.delete(cancel);
      ctx.busyWorkspaces.delete(cwd);
      ctx.busyWorkspaces.delete(admittedCwd);
    }
    const recorded = terminal ?? outcome;
    auditSafely({
      at: new Date(startedAt).toISOString(),
      device: { id: owner.id, name: owner.name },
      action: 'reload',
      workspace: admittedCwd,
      ...(platform ? { platform } : {}),
      ok: recorded.ok,
      durationMs: Date.now() - startedAt,
      ...(recorded.ok
        ? {}
        : {
            error: {
              code: 'action-failed',
              message: outcome.unresolved ? 'STIM_CLAIM_UNAVAILABLE' : recorded.code || 'STIM_RELOAD_FAILED',
            },
          }),
    });
    return undefined;
  });
}

export function subscribeStart(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => !['cwd', 'remote', 'resetCache', 'waitSeconds'].includes(key)) ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd) ||
    (params.remote !== undefined && typeof params.remote !== 'boolean') ||
    (params.resetCache !== undefined && typeof params.resetCache !== 'boolean') ||
    (params.waitSeconds !== undefined &&
      (typeof params.waitSeconds !== 'number' || !Number.isSafeInteger(params.waitSeconds) || params.waitSeconds <= 0))
  )
    return ctx.error(
      id,
      'bad-request',
      'Start requires an absolute cwd, optional remote/resetCache booleans, and a positive whole waitSeconds.',
    );
  const remote = typeof params.remote === 'boolean' ? params.remote : undefined;
  const resetCache = typeof params.resetCache === 'boolean' ? params.resetCache : undefined;
  const waitSeconds = typeof params.waitSeconds === 'number' ? params.waitSeconds : undefined;
  subscribeLifecycle(ctx, id, params.cwd, owner, 'start', (cwd, beforeStart, onProgress) =>
    startAction(cwd, ctx.options.env, ctx.actionLimits, { remote, resetCache, waitSeconds, beforeStart, onProgress }),
  );
}

export function subscribeRun(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  const parsed = parsePlatformRun(params);
  if (!parsed) return ctx.error(id, 'bad-request', 'Run requires an absolute cwd and valid platform options.');
  const limits = { ...ctx.actionLimits, timeoutMs: ctx.options.actionLimits?.timeoutMs ?? 60 * 60_000 };
  subscribeLifecycle(
    ctx,
    id,
    parsed.cwd,
    owner,
    'run',
    (cwd, _beforeRun, onProgress) => platformRunAction(cwd, ctx.options.env, limits, parsed.options, onProgress),
    parsed.options.platform,
  );
}

export function subscribeBuild(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  const parsed = parsePlatformBuild(params);
  if (!parsed) return ctx.error(id, 'bad-request', 'Build requires an absolute cwd and valid artifact-only options.');
  const limits = { ...ctx.actionLimits, timeoutMs: ctx.options.actionLimits?.timeoutMs ?? 60 * 60_000 };
  subscribeLifecycle(
    ctx,
    id,
    parsed.cwd,
    owner,
    'build',
    (cwd, _beforeBuild, onProgress) => platformBuildAction(cwd, ctx.options.env, limits, parsed.options, onProgress),
    parsed.options.platform,
  );
}

const GC_LEVELS = ['normal', 'high', 'critical'] as const;
const GC_ARCHIVE_PARTS = ['logs', 'recordings', 'agentActions'] as const;

const gcLevel = (value: unknown): (typeof GC_LEVELS)[number] | undefined => GC_LEVELS.find((level) => level === value);
const archivePart = (value: unknown): (typeof GC_ARCHIVE_PARTS)[number] | undefined =>
  GC_ARCHIVE_PARTS.find((part) => part === value);

function validCwd(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && cwd.length <= 4096 && !cwd.includes('\0') && isAbsolute(cwd);
}

export function subscribeGc(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => !['cwd', 'dryRun', 'pressure'].includes(key)) ||
    !validCwd(params.cwd) ||
    typeof params.dryRun !== 'boolean' ||
    (params.pressure !== undefined && !gcLevel(params.pressure))
  )
    return ctx.error(
      id,
      'bad-request',
      'GC requires an absolute cwd, a dryRun boolean and an optional pressure of normal, high or critical.',
    );
  const pressure = gcLevel(params.pressure);
  const request = { dryRun: params.dryRun, ...(pressure ? { pressure } : {}) };
  subscribeLifecycle(ctx, id, params.cwd, owner, 'gc', (cwd, _admit, onProgress) =>
    gcAction(cwd, ctx.options.env, ctx.actionLimits, request, onProgress),
  );
}

function gcItemOf(value: unknown): StimGcItem | null {
  if (!isJsonObject(value)) return null;
  const keys = Object.keys(value);
  const only = (...allowed: string[]) => keys.every((key) => key === 'kind' || allowed.includes(key));
  switch (value.kind) {
    case 'cache':
      return only('dir') && validCwd(value.dir) ? { kind: 'cache', dir: value.dir } : null;
    case 'archive':
      return only('id', 'part') &&
        typeof value.id === 'string' &&
        /^[\w.-]{1,200}$/.test(value.id) &&
        (value.part === undefined || archivePart(value.part))
        ? {
            kind: 'archive',
            id: value.id,
            ...(archivePart(value.part) ? { part: archivePart(value.part) } : {}),
          }
        : null;
    case 'workspace-outputs':
    case 'watchman':
    case 'gradle-daemons':
      return only() ? { kind: value.kind } : null;
    default:
      return null;
  }
}

/** Deletes one item Stim Desktop chose; the CLI has no way to pick items. */
export function subscribeGcItem(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  const item = isJsonObject(params) ? gcItemOf(params.item) : null;
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd' && key !== 'item') ||
    !validCwd(params.cwd) ||
    !item
  )
    return ctx.error(
      id,
      'bad-request',
      'GC item requires an absolute cwd and an item: a cache dir, workspace-outputs, an archive id with an optional part, watchman or gradle-daemons.',
    );
  subscribeLifecycle(ctx, id, params.cwd, owner, 'gc', (cwd, _admit, onProgress) =>
    gcItemAction(cwd, ctx.options.env, ctx.actionLimits, item, onProgress),
  );
}

export function subscribeRemedy(ctx: ConnectionContext, id: RequestId, params: unknown, owner: PairedDevice): void {
  const tool = isJsonObject(params) && params.action === 'device-tool' ? deviceToolRequest(params.request) : null;
  if (
    !isJsonObject(params) ||
    (params.action !== 'doctor-fix' && params.action !== 'device-unlock' && params.action !== 'device-tool') ||
    (params.action === 'device-tool' && tool === null) ||
    Object.keys(params).some(
      (key) =>
        ![
          'cwd',
          'action',
          ...(params.action === 'device-tool'
            ? ['request', 'slot']
            : ['platform', ...(params.action === 'device-unlock' ? ['slot'] : [])]),
        ].includes(key),
    ) ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd) ||
    (params.platform !== undefined && params.platform !== 'ios' && params.platform !== 'android') ||
    (params.slot !== undefined &&
      (typeof params.slot !== 'string' ||
        !SLOT_NAME.test(params.slot) ||
        ['constructor', 'prototype', '__proto__'].includes(params.slot)))
  )
    return ctx.error(
      id,
      'bad-request',
      'Choose an absolute cwd and a supported typed doctor, device-unlock or device-tool request.',
    );
  const request: Methods['desktop.remedy.subscribe']['params'] =
    params.action === 'device-tool' && tool
      ? {
          cwd: params.cwd,
          action: 'device-tool',
          request: tool,
          slot: typeof params.slot === 'string' ? params.slot : undefined,
        }
      : params.action === 'doctor-fix'
        ? { cwd: params.cwd, action: params.action, platform: params.platform }
        : {
            cwd: params.cwd,
            action: 'device-unlock',
            platform: params.platform,
            slot: typeof params.slot === 'string' ? params.slot : undefined,
          };
  subscribeLifecycle(ctx, id, params.cwd, owner, 'remedy', (cwd, admit, onProgress) =>
    remedyAction(
      cwd,
      ctx.options.env,
      request.action === 'device-tool'
        ? { ...ctx.actionLimits, timeoutMs: Math.min(ctx.actionLimits.timeoutMs, 60_000) }
        : ctx.actionLimits,
      request,
      admit,
      onProgress,
    ),
  );
}

export function subscribeMachineAccess(
  ctx: ConnectionContext,
  id: RequestId,
  params: unknown,
  owner: PairedDevice,
): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd' && key !== 'ticket') ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd) ||
    (params.ticket !== undefined && (typeof params.ticket !== 'string' || !decodeSecret(params.ticket)))
  )
    return ctx.error(id, 'bad-request', 'Machine access requires an absolute cwd and an optional valid setup ticket.');
  const ticket = typeof params.ticket === 'string' ? params.ticket : undefined;
  subscribeLifecycle(ctx, id, params.cwd, owner, 'machine-access', (cwd, _admit, onProgress) =>
    machineAccessAction(cwd, ctx.options.env, ctx.actionLimits, ticket, onProgress),
  );
}

export function subscribeWorktreeWarm(
  ctx: ConnectionContext,
  id: RequestId,
  params: unknown,
  owner: PairedDevice,
): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd') ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd)
  )
    return ctx.error(id, 'bad-request', 'Worktree warming requires only an absolute cwd.');
  const limits = { ...ctx.actionLimits, timeoutMs: ctx.options.actionLimits?.timeoutMs ?? 90 * 60_000 };
  subscribeLifecycle(ctx, id, params.cwd, owner, 'worktree-warm', (cwd, beforeWarm, onProgress) =>
    worktreeWarmAction(cwd, ctx.options.env, limits, { beforeWarm }, onProgress),
  );
}

export function subscribeWorktreeRemove(
  ctx: ConnectionContext,
  id: RequestId,
  params: unknown,
  owner: PairedDevice,
): void {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => !['cwd', 'target', 'force'].includes(key)) ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd) ||
    (params.target !== undefined &&
      (typeof params.target !== 'string' ||
        params.target.length > 4096 ||
        params.target.includes('\0') ||
        !isAbsolute(params.target))) ||
    (params.force !== undefined && typeof params.force !== 'boolean')
  )
    return ctx.error(
      id,
      'bad-request',
      'Worktree removal requires an absolute cwd, optional absolute target and boolean force.',
    );
  const request = {
    target: typeof params.target === 'string' ? params.target : undefined,
    force: typeof params.force === 'boolean' ? params.force : undefined,
  };
  subscribeLifecycle(ctx, id, params.cwd, owner, 'worktree-remove', (cwd, beforeRemove, onProgress) =>
    worktreeRemoveAction(cwd, ctx.options.env, ctx.actionLimits, { ...request, beforeRemove }, onProgress),
  );
}

function subscribeLifecycle(
  ctx: ConnectionContext,
  id: RequestId,
  requestedCwd: string,
  owner: PairedDevice,
  kind: 'start' | 'run' | 'build' | 'gc' | 'worktree-remove' | 'worktree-warm' | 'machine-access' | 'remedy',
  begin: (
    cwd: string,
    admit: (workspace: string) => void,
    progress: (value: StimProgress) => void,
  ) => ReturnType<typeof startAction>,
  platform?: PlatformRunOptions['platform'],
): void {
  let cwd: string;
  try {
    cwd = realpathSync(requestedCwd);
    if (!lstatSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.');
  } catch (cause) {
    return ctx.error(id, 'bad-request', `Cannot ${kind} this workspace: ${readFailure(cause)}`);
  }
  if (ctx.slotsFull()) return ctx.error(id, 'limit-exceeded', ctx.slotsMessage());
  if (ctx.busyWorkspaces.has(cwd)) return ctx.error(id, 'action-busy', `An action is already running in ${cwd}.`);
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  const startedAt = Date.now();
  let admittedCwd = cwd;
  const admittedWorkspaces = new Set<string>();
  let observing = true;
  let terminal: StartOutcome | undefined;
  const finish = (outcome: StartOutcome) => {
    terminal ??= outcome;
    if (!observing) return;
    observing = false;
    ctx.subscriptions.delete(subscription);
    send(ctx.socket, {
      event: `desktop-${kind}-ended`,
      subscription,
      exitCode: outcome.ok ? 0 : 1,
      stdout: outcome.stdout ?? '',
      message: outcome.ok ? outcome.summary : outcome.message,
    });
  };
  const run = begin(
    cwd,
    (workspace) => {
      if (admittedWorkspaces.has(workspace)) return;
      if (workspace !== cwd && ctx.busyWorkspaces.has(workspace))
        throw new StimError({ code: 'STIM_ACTION_BUSY', message: `An action is already running in ${workspace}.` });
      if (admittedWorkspaces.size === 0) admittedCwd = workspace;
      admittedWorkspaces.add(workspace);
      ctx.busyWorkspaces.add(workspace);
    },
    (progress) => {
      if (observing) send(ctx.socket, { event: `desktop-${kind}-progress`, subscription, ...progress });
    },
  );
  const cancel = async () => {
    await run.cancel();
  };
  ctx.holdSlot(cancel);
  ctx.running.add(cancel);
  ctx.busyWorkspaces.add(cwd);
  ctx.subscriptions.set(subscription, async (): Promise<ProtocolError | void> => {
    observing = false;
    const outcome = await run.cancel();
    if (!outcome.ok && outcome.unresolved) return { code: 'action-failed', message: outcome.message };
    return undefined;
  });
  void run.outcome.then(finish);
  void run.drained.then((outcome) => {
    if (
      kind === 'gc' ||
      kind === 'worktree-remove' ||
      kind === 'worktree-warm' ||
      kind === 'machine-access' ||
      kind === 'remedy'
    )
      ctx.desktopReports.invalidate();
    const release = () => {
      ctx.releaseSlot(cancel);
      ctx.running.delete(cancel);
      ctx.busyWorkspaces.delete(cwd);
      for (const workspace of admittedWorkspaces) ctx.busyWorkspaces.delete(workspace);
    };
    const roots = outcome.retainedClaimRoots;
    if (outcome.unresolved) {
      const reconcile = () => {
        if (!roots?.length && !outcome.cleanupSettled) return;
        if (
          roots?.some((root) => {
            const claims = readClaimSet(root);
            return claims.live.length > 0 || claims.unresolved.length > 0;
          })
        )
          return;
        if (outcome.cleanupSettled && !outcome.cleanupSettled()) return;
        release();
        ctx.retainedLifecycles.delete(reconcile);
      };
      if (!roots?.length && !outcome.cleanupSettled && outcome.cleanupComplete) {
        void outcome.cleanupComplete.then(release, () => {});
      } else {
        ctx.retainedLifecycles.add(reconcile);
      }
    } else {
      release();
    }
    const recorded = terminal ?? outcome;
    auditSafely({
      at: new Date(startedAt).toISOString(),
      device: { id: owner.id, name: owner.name },
      action: kind,
      workspace: admittedCwd,
      ...(platform ? { platform } : {}),
      ok: recorded.ok,
      durationMs: Date.now() - startedAt,
      ...(recorded.ok
        ? {}
        : {
            error: {
              code: 'action-failed',
              message: outcome.unresolved
                ? 'STIM_CLAIM_UNAVAILABLE'
                : recorded.code ||
                  (kind === 'start'
                    ? 'STIM_METRO_START_FAILED'
                    : kind === 'gc'
                      ? 'STIM_GC_FAILED'
                      : kind === 'build'
                        ? 'STIM_BUILD_FAILED'
                        : 'STIM_RUN_FAILED'),
            },
          }),
    });
    return undefined;
  });
}
