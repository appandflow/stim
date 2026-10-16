import { claimFailure } from './ownership-claim.ts';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type StimContext, withAmbientContext } from '@stim-cli/core';
import { findProjectRoot, openLogDir, RUN_ID_ENV, validRunId } from '@stim-cli/core/state';
import { stopWorkspaceNow } from './commands/stop.ts';
import { runReload } from './commands/reload.ts';
import { startDevServer } from './commands/start.ts';
import {
  findCommandWorkspaceAsync,
  findProjectRoot as findStartRoot,
  projectProblem,
  NO_PROJECT_REFUSAL,
} from './workspace/project.ts';
import { repoRootAsync } from './workspace/worktree.ts';
import { recordWorkspaceUseAsync } from './workspace/workspace-state.ts';
import { readDoctorReport } from './commands/doctor.ts';
import { recordDoctorCheck } from './guide-status.ts';
import { executeGc, readGcReport, withGcMaintenanceClaim } from './commands/gc.ts';
import { runReport, trackReportResource } from './report-runtime.ts';
import { readWorkspaceLogs, followWorkspaceLogs } from './engine/logs.ts';
import { readProjectStats } from './engine/stats-report.ts';
import { buildAndroidOperation } from './commands/android/build.ts';
import { runAndroidOperation } from './commands/android.ts';
import { buildIosOperation } from './commands/ios/build.ts';
import { runIosOperation } from './commands/ios.ts';
import { buildMacosOperation } from './commands/macos-build.ts';
import { runMacos } from './commands/macos.ts';
import { runWeb } from './commands/web.ts';
import { readIosBuildPlan } from './commands/ios/next-build.ts';
import { readAndroidBuildPlan } from './commands/android/next-build.ts';
import { planMacos } from './macos/plan.ts';
import { validateDeviceSlot } from './devices/device-slots.ts';
import type { FailArgs } from './commands/ios/types.ts';
import { operationState } from './engine/operation-state.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import { refuseRelativeStimPaths } from './workspace/config.ts';
import { ensureWorkspaceStorageAsync, workspaceLogsDir } from './workspace/paths.ts';
import { ensureHomeIdentity } from './workspace/home-identity.ts';
import { mutateSetting } from './workspace/settings-write.ts';
import { readSettingsContext, readSettingsPayload, SettingsRefusal } from './workspace/settings-payload.ts';
import {
  cacheProviderSettingError,
  resolveProjectSettingsAsync,
  settingShapeErrors,
  SETTING_SHAPE_REMEDY,
  unknownSettingKeys,
} from './workspace/settings.ts';
import type {
  StimBuildOptions,
  StimBuildResult,
  StimClient,
  StimFailure,
  StimLogsOptions,
  StimOptions,
  StimReadOptions,
  StimPlanOptions,
  StimDoctorOptions,
  StimGcOptions,
  StimGcMutationOptions,
  StimSettingWriteOptions,
  StimRunOptions,
  StimRunResult,
  StimReloadOptions,
  StimReloadResult,
  StimStartOptions,
  StimStartResult,
} from './api/types.ts';

export type {
  StimBuildOptions,
  StimBuildResult,
  StimClient,
  StimDiagnostics,
  StimDiagnosticsOptions,
  StimDoctorOptions,
  StimDoctorReport,
  StimGcOptions,
  StimGcMutationOptions,
  StimGcMutationResult,
  StimGcReport,
  StimOptions,
  StimPlatform,
  StimLogsOptions,
  StimProgress,
  StimReadOptions,
  StimPlanOptions,
  StimPlan,
  StimRunOptions,
  StimRunResult,
  StimSettings,
  StimSettingWriteOptions,
  StimSettingWriteResult,
  StimStats,
  StimStopOptions,
  StimStopResult,
  StimReloadOptions,
  StimReloadResult,
  StimStartOptions,
  StimStartResult,
} from './api/types.ts';

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class StimError extends Error {
  readonly code: string;
  readonly remedy: string | null;
  readonly details: unknown;

  constructor(
    { code, message, remedy = null, details }: Omit<StimFailure, 'remedy'> & { remedy?: string | null },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StimError';
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

/**
 * Creates a client without starting processes or changing the caller's cwd, environment, or signal handlers.
 * The Stim home is fixed when the client is created: `home`, else STIM_HOME from `env`, else the default home.
 * Operations run in the calling process against the client's home and project, so clients for different
 * homes can share a process.
 * Resources remain workspace-owned until stop() is called.
 */
export function createStim(options: StimOptions): StimClient {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(options.projectRoot);
  } catch (error) {
    throw new StimError({
      code: 'STIM_NO_PROJECT',
      message: `Could not resolve projectRoot ${options.projectRoot}: ${error instanceof Error ? error.message : String(error)}`,
      remedy: 'Pass the path to an existing, readable app directory.',
    });
  }
  for (const [name, path] of [
    ['home', options.home],
    ['buildCache', options.buildCache],
  ]) {
    if (path !== undefined && !isAbsolute(path)) {
      throw new StimError({ code: 'STIM_BAD_ARG', message: `${name} must be an absolute path.` });
    }
  }
  const base = options.env ?? process.env;
  const home = options.home ?? (base.STIM_HOME || join(base.HOME || base.USERPROFILE || homedir(), '.stim'));
  const clientContext = {
    ...options,
    projectRoot,
    env: {
      ...base,
      ...(options.home === undefined ? {} : { STIM_HOME: options.home }),
      ...(options.buildCache === undefined ? {} : { STIM_BUILD_CACHE: options.buildCache }),
      FORCE_COLOR: '0',
    },
  };
  const begin = (signal: AbortSignal | undefined, cancelOnProgress = false): Operation => {
    const controller = cancelOnProgress ? new AbortController() : undefined;
    const abort = () => controller?.abort();
    if (controller) {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }
    const callback: Operation['callback'] = {};
    const output: StimContext['output'] = (stream, message) => {
      if ('error' in callback) return;
      try {
        options.onProgress?.({ stream, message: stripVTControlCharacters(message) });
      } catch (error) {
        callback.error = error;
        controller?.abort();
      }
    };
    const operation = operationContext(clientContext, home, output, controller?.signal ?? signal);
    if (controller) operationState(operation).abortOperation = abort;
    return {
      context: operation,
      callback,
      dispose: () => signal?.removeEventListener('abort', abort),
    };
  };
  const report = async <T>(signal: AbortSignal | undefined, work: (context: StimContext) => Promise<T>): Promise<T> => {
    const operation = begin(signal, true);
    operation.context.env.STIM_HOME = clientContext.env.STIM_HOME;
    for (const name of ['AGENT_DEVICE_STATE_DIR', 'AGENT_DEVICE_CLAIMS_DIR', 'AGENT_DEVICE_IOS_RUNNER_LEASE_DIR']) {
      const directory = operation.context.env[name]?.trim();
      if (directory) operation.context.env[name] = resolve(operation.context.cwd, directory);
    }
    try {
      return await read(operation, (context) =>
        runReport(context, (request) => withAmbientContext(request, () => work(request))),
      );
    } finally {
      operation.dispose();
    }
  };
  return {
    projectRoot,
    start: ({ signal, ...request }: StimStartOptions = {}) => {
      const operation = begin(signal, true);
      operation.context.env.STIM_HOME = clientContext.env.STIM_HOME;
      return lifecycle(operation, (context) => start(context, request));
    },
    identity: ({ signal }: StimReadOptions = {}) =>
      read(begin(signal), (operation) => ensureHomeIdentity(operation.signal)),
    doctor: async ({ signal, platform, record }: StimDoctorOptions = {}) => {
      if (platform !== undefined && platform !== 'ios' && platform !== 'android')
        return Promise.reject(new StimError({ code: 'STIM_BAD_ARG', message: 'platform must be ios or android.' }));
      const result = await report(signal, (context) => readDoctorReport(context, platform, version));
      if (record !== true) return result;
      return read(begin(signal), async (context) => {
        await recordDoctorCheck(result.project, platform, version, context.signal);
        return result;
      });
    },
    plan: ({ signal, ...request }: StimPlanOptions) =>
      report(signal, (context) => {
        const task = Promise.resolve().then(async () => {
          if (request.platform === 'macos') {
            try {
              return await planMacos(context, findStartRoot(context.projectRoot) ?? context.projectRoot);
            } catch (cause) {
              if (cause instanceof Error && 'reportCleanup' in cause) throw cause;
              context.signal.throwIfAborted();
              const code =
                cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
                  ? cause.code
                  : 'STIM_BAD_ARG';
              const remedy =
                cause instanceof Error && 'remedy' in cause && typeof cause.remedy === 'string'
                  ? cause.remedy
                  : 'Check the macOS project settings in stim guide macos.';
              throw new StimError({
                code,
                message: cause instanceof Error ? cause.message : String(cause),
                remedy,
              });
            }
          }
          if (request.platform !== 'ios' && request.platform !== 'android')
            throw new StimError({ code: 'STIM_BAD_ARG', message: 'platform must be ios, android or macos.' });
          const selectors = { slot: validateDeviceSlot(request.slot) };
          const result =
            request.platform === 'ios'
              ? await readIosBuildPlan(context, selectors)
              : await readAndroidBuildPlan(context, selectors);
          context.signal.throwIfAborted();
          if ('platform' in result) return result;
          throw new StimError({ ...result.refusal, details: { lines: result.lines } });
        });
        trackReportResource(
          context,
          task.then(
            () => undefined,
            (cause: unknown) => {
              if (cause instanceof Error && 'reportCleanup' in cause) throw cause;
            },
          ),
          () => {},
        );
        return task;
      }),
    gc: ({ signal, olderThan, cache, worktrees }: StimGcOptions = {}) => {
      if (olderThan !== undefined && !Number.isSafeInteger(olderThan))
        return Promise.reject(
          new StimError({ code: 'STIM_BAD_ARG', message: 'olderThan must be a whole number of days.' }),
        );
      return report(signal, async (context) => {
        const result = await readGcReport(
          { olderThan, cache, worktrees },
          {
            operation: context,
            easLedgerRoot: join(context.env.HOME || context.env.USERPROFILE || homedir(), '.stim', 'machine', 'eas'),
          },
        );
        if ('code' in result) throw new StimError(result);
        return result;
      });
    },
    collectGarbage: ({ signal, olderThan, cache, worktrees, delete: deleting, idleMs }: StimGcMutationOptions = {}) => {
      const invalid =
        olderThan !== undefined && !Number.isSafeInteger(olderThan)
          ? 'olderThan must be a whole number of days.'
          : cache !== undefined && (typeof cache !== 'string' || !cache.trim())
            ? 'cache must name a cache.'
            : worktrees !== undefined && typeof worktrees !== 'boolean'
              ? 'worktrees must be a boolean.'
              : deleting !== undefined && typeof deleting !== 'boolean'
                ? 'delete must be a boolean.'
                : idleMs !== undefined && (!Number.isSafeInteger(idleMs) || idleMs <= 0)
                  ? 'idleMs must be a positive whole number of milliseconds.'
                  : null;
      if (invalid) return Promise.reject(new StimError({ code: 'STIM_BAD_ARG', message: invalid }));
      const operation = begin(signal, true);
      operation.context.env.STIM_HOME = clientContext.env.STIM_HOME;
      const request = { olderThan, cache, worktrees, delete: deleting, idle: idleMs, json: true };
      return lifecycle(operation, (context) =>
        withGcMaintenanceClaim(request, (claim) =>
          runReport(context, (bounded) =>
            withAmbientContext(bounded, () => {
              const task = executeGc(
                request,
                {
                  operation: bounded,
                  easLedgerRoot: join(
                    bounded.env.HOME || bounded.env.USERPROFILE || homedir(),
                    '.stim',
                    'machine',
                    'eas',
                  ),
                },
                (_stream, line) => bounded.output('stderr', `${line}\n`),
                claim,
              ).then(({ payload, exitCode }) => {
                if ('code' in payload) throw new StimError(payload);
                return { report: payload, exitCode };
              });
              trackReportResource(
                bounded,
                task.then(
                  () => undefined,
                  (cause: unknown) => {
                    if (
                      cause instanceof WorkspaceProcessCleanupError ||
                      (cause instanceof Error && 'reportCleanup' in cause)
                    )
                      throw cause;
                  },
                ),
                () => {},
              );
              return task;
            }),
          ),
        ).catch((cause: unknown) => {
          if (cause instanceof WorkspaceProcessCleanupError) throw cause;
          const failure = claimFailure(cause, null);
          if (failure) throw new StimError(failure);
          throw cause;
        }),
      );
    },
    settings: ({ signal }: StimReadOptions = {}) =>
      read(begin(signal), async (operation) =>
        readSettingsPayload(
          await readSettingsContext(
            operation.projectRoot,
            { ...operation.env, STIM_HOME: clientContext.env.STIM_HOME },
            note(operation),
            operation.signal,
          ),
          operation.signal,
        ),
      ),
    setSetting: (key, value, { signal, scope, beforeWrite }: StimSettingWriteOptions = {}) =>
      read(begin(signal), (operation) =>
        mutateSetting(
          { action: 'set', key, value, scope },
          {
            cwd: operation.projectRoot,
            env: { ...operation.env, STIM_HOME: clientContext.env.STIM_HOME },
            note: note(operation),
            signal: operation.signal,
            beforeWrite,
          },
        ),
      ),
    unsetSetting: (key, { signal, scope, beforeWrite }: StimSettingWriteOptions = {}) =>
      read(begin(signal), (operation) =>
        mutateSetting(
          { action: 'unset', key, scope },
          {
            cwd: operation.projectRoot,
            env: { ...operation.env, STIM_HOME: clientContext.env.STIM_HOME },
            note: note(operation),
            signal: operation.signal,
            beforeWrite,
          },
        ),
      ),
    stats: ({ signal }: StimReadOptions = {}) =>
      read(
        begin(signal),
        async (operation) =>
          (await readProjectStats(findProjectRoot(operation.projectRoot), operation.env, operation.signal)).report,
      ),
    logs: ({ signal, ...request }: StimLogsOptions = {}) =>
      read(begin(signal), (operation) => readWorkspaceLogs(operation, request)),
    followLogs: ({ signal, ...request }, onRecord, onBackfill) => {
      const operation = begin(signal);
      return read(operation, async (readContext) => {
        const stop = await followWorkspaceLogs(readContext, request, onRecord, onBackfill);
        if ('error' in operation.callback) stop();
        return stop;
      });
    },
    build: (({ signal, ...request }: StimBuildOptions) =>
      lifecycle(begin(signal, true), (operation) => build(operation, request))) as StimClient['build'],
    run: (({ signal, ...request }: StimRunOptions) =>
      lifecycle(begin(signal, true), (operation) => run(operation, request))) as StimClient['run'],
    stop: ({ signal, ...request } = {}) =>
      read(begin(signal), async (operation) => {
        const root = findStartRoot(operation.projectRoot) ?? operation.projectRoot;
        request.beforeStop?.(root);
        const logs = workspaceLogsDir(root);
        let result: Awaited<ReturnType<typeof stopWorkspaceNow>>;
        try {
          result = await stopWorkspaceNow({ root, slot: request.slot, report: note(operation), operation });
        } catch (error) {
          if (operation.signal.aborted) throw error;
          const failure = error as Partial<StimFailure>;
          throw new StimError({
            code: failure.code ?? 'STIM_RUN_FAILED',
            message: error instanceof Error ? error.message : String(error),
            remedy: failure.remedy ?? null,
            details: { logs, cause: failure.details },
          });
        }
        if ('refusal' in result) throw new StimError({ ...result.refusal, details: { logs, cause: result.remote } });
        return result;
      }),
    reload: async ({ signal, ...request }: StimReloadOptions = {}) => {
      const requestOperation = begin(signal, true);
      try {
        return await read(requestOperation, (context) =>
          runReport(context, (operation) =>
            withAmbientContext(operation, () => {
              const result = reload(operation, request);
              trackReportResource(
                operation,
                result.then(
                  () => undefined,
                  () => undefined,
                ),
                () => {},
              );
              return result;
            }),
          ),
        );
      } finally {
        requestOperation.dispose();
      }
    },
    diagnostics({ signal, ...request } = {}) {
      if (request.tail !== undefined && (!Number.isSafeInteger(request.tail) || request.tail < 0)) {
        return Promise.reject(new StimError({ code: 'STIM_BAD_ARG', message: 'tail must be a non-negative integer.' }));
      }
      return read(begin(signal), async (operation) => {
        const directory = workspaceLogsDir(operation.projectRoot);
        if (request.tail === 0) return { directory, records: [] };
        const view = await openLogDir(directory, { signal: operation.signal });
        try {
          return {
            directory,
            records: await view.query({ tail: request.tail ?? 200, errorsOnly: request.errors ?? false }),
          };
        } finally {
          await view.close();
        }
      });
    },
  };
}

function operationContext(
  client: StimOptions & { env: NodeJS.ProcessEnv; projectRoot: string },
  home: string,
  output: StimContext['output'],
  signal: AbortSignal | undefined,
): StimContext {
  const runId = validRunId(client.env[RUN_ID_ENV]) ?? randomBytes(6).toString('hex');
  return {
    home,
    buildCache: client.buildCache ?? null,
    projectRoot: client.projectRoot,
    cwd: client.projectRoot,
    runId,
    env: { ...client.env, STIM_HOME: home, [RUN_ID_ENV]: runId },
    signal: signal ?? new AbortController().signal,
    output,
  };
}

interface Operation {
  context: StimContext;
  /** The first exception the client's onProgress threw; output stops at it and the operation rejects with it. */
  callback: { error?: unknown };
  dispose(): void;
}

async function read<T>({ context, callback }: Operation, operation: (context: StimContext) => Promise<T>): Promise<T> {
  const { signal } = context;
  if (signal.aborted) throw cancelled();
  let result: T;
  try {
    refuseRelativeStimPaths(context.env);
    result = await withAmbientContext(context, () => operation(context));
  } catch (error) {
    const cleanupUnresolved =
      error instanceof Error &&
      ('reportCleanup' in error || ('code' in error && error.code === 'STIM_CLAIM_UNAVAILABLE'));
    if ('error' in callback && !cleanupUnresolved) throw callback.error;
    if (signal.aborted && !cleanupUnresolved) throw cancelled();
    if (error instanceof StimError) throw error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('STIM_')) {
      const remedy =
        error instanceof SettingsRefusal
          ? error.remedy
          : cleanupUnresolved && 'remedy' in error && typeof error.remedy === 'string'
            ? error.remedy
            : null;
      throw new StimError(
        { code: error.code, message: error.message, remedy },
        cleanupUnresolved ? { cause: error } : undefined,
      );
    }
    throw error;
  }
  if ('error' in callback) throw callback.error;
  if (signal.aborted) throw cancelled();
  return result;
}

function note(operation: StimContext): (line: string) => void {
  return (line) => operation.output('stderr', `${line}\n`);
}

function cancelled(): StimError {
  return new StimError({ code: 'STIM_CANCELLED', message: 'The Stim operation was cancelled.' });
}

async function lifecycle<T>(operation: Operation, work: (context: StimContext) => Promise<T>): Promise<T> {
  try {
    return await read(operation, async (context) => {
      const logs = workspaceLogsDir(context.projectRoot);
      try {
        return await work(context);
      } catch (error) {
        const failure = error as Partial<StimFailure>;
        throw new StimError({
          code: failure?.code ?? 'STIM_RUN_FAILED',
          message: error instanceof Error ? error.message : String(error),
          remedy: failure?.remedy ?? null,
          details: {
            logs,
            cause:
              error instanceof WorkspaceProcessCleanupError
                ? { retainedClaimRoots: [...new Set(error.claims.map((claim) => claim.root))] }
                : failure?.details,
          },
        });
      }
    });
  } finally {
    operation.dispose();
  }
}

async function start(context: StimContext, options: StimStartOptions): Promise<StimStartResult> {
  if (options.waitSeconds !== undefined && (!Number.isSafeInteger(options.waitSeconds) || options.waitSeconds <= 0)) {
    throw new StimError({ code: 'STIM_BAD_ARG', message: 'waitSeconds must be a positive whole number.' });
  }
  const root = findStartRoot(context.projectRoot);
  if (!root) throw new StimError(NO_PROJECT_REFUSAL);
  const problem = projectProblem(root, 'dev-server');
  if (problem) throw new StimError({ code: 'STIM_NO_PROJECT', ...problem });
  options.beforeStart?.(root);
  context.signal.throwIfAborted();
  return withAmbientContext({ ...context, projectRoot: root }, async () => {
    const { context: settingsContext, settings } = await resolveProjectSettingsAsync(root, {
      env: context.env,
      signal: context.signal,
    });
    const shapeErrors = settingShapeErrors(settings);
    if (shapeErrors.length) {
      throw new StimError({ code: 'STIM_BAD_ARG', message: shapeErrors.join('\n'), remedy: SETTING_SHAPE_REMEDY });
    }
    for (const key of unknownSettingKeys(settings))
      note(context)(`Warning: setting "${key}" is not read by Stim and will be ignored.`);
    const cacheError = cacheProviderSettingError(settings);
    if (cacheError) note(context)(`Warning: ${cacheError} No cache provider is used.`);
    await ensureWorkspaceStorageAsync(root, context.signal);
    await recordWorkspaceUseAsync(root, new Date(), context.env, context.cwd, context.signal);
    const result = await startDevServer({
      root,
      settings,
      settingsContext,
      waitSeconds: options.waitSeconds,
      remote: options.remote,
      resetCache: options.resetCache,
      out: (line) => context.output('stdout', `${line}\n`),
      note: note(context),
    });
    if (!result.ok) {
      for (const line of result.lines) note(context)(line);
      throw new StimError({
        ...result.error,
        details: {
          lines: result.lines,
          reclaimed: result.reclaimed,
          ...(result.retainedClaimRoots ? { retainedClaimRoots: result.retainedClaimRoots } : {}),
        },
      });
    }
    return result.facts;
  });
}

async function reload(context: StimContext, options: StimReloadOptions): Promise<StimReloadResult> {
  if (options.platform !== undefined && !['ios', 'android', 'web'].includes(options.platform)) {
    throw new StimError({ code: 'STIM_BAD_ARG', message: 'platform must be ios, android or web.' });
  }
  const root = await findCommandWorkspaceAsync(
    context.projectRoot,
    (cwd) => repoRootAsync(cwd, { env: context.env, signal: context.signal }),
    note(context),
  );
  context.signal.throwIfAborted();
  if (!root)
    throw new StimError({
      code: 'STIM_NO_PROJECT',
      message: `No Stim environment is registered for ${context.projectRoot}.`,
      remedy: 'Run stim start first.',
    });
  options.beforeReload?.(root);
  context.signal.throwIfAborted();
  await recordWorkspaceUseAsync(root, new Date(), context.env, context.projectRoot, context.signal);
  const result = await runReload({ root, platform: options.platform, signal: context.signal });
  if (!result.ok) throw new StimError(result.error);
  return result.facts;
}

async function build(context: StimContext, options: StimBuildOptions): Promise<StimBuildResult> {
  const root = context.projectRoot;
  switch (options.platform) {
    case 'ios':
      return { platform: 'ios', facts: await buildIosOperation(context, root, options) };
    case 'android':
      return { platform: 'android', facts: await buildAndroidOperation(context, root, options) };
    case 'macos':
      return { platform: 'macos', facts: await buildMacosOperation(context, root, options) };
    default:
      throw new StimError({ code: 'STIM_BAD_ARG', message: 'Unknown Stim build platform.' });
  }
}

async function run(context: StimContext, options: StimRunOptions): Promise<StimRunResult> {
  const root = context.projectRoot;
  switch (options.platform) {
    case 'ios': {
      let error: FailArgs | undefined;
      const result = await runIosOperation(context, root, options, {}, (failure) => {
        error = failure;
      });
      if (!result)
        throw new StimError({
          code: error?.code ?? 'STIM_RUN_FAILED',
          message: error?.message ?? 'The iOS run failed.',
          remedy: error?.remedy,
          details: error,
        });
      return { platform: 'ios', facts: result.facts };
    }
    case 'android': {
      const result = await runAndroidOperation(context, root, options);
      if (!result.ok || !result.facts)
        throw new StimError({
          code: result.error?.code ?? 'STIM_RUN_FAILED',
          message: result.error?.message ?? 'The Android run failed.',
          remedy: result.error?.remedy,
          details: result.error,
        });
      return { platform: 'android', facts: result.facts };
    }
    case 'macos': {
      const record = await runMacos(context, root, note(context), options.remote, options.remoteBuild);
      return {
        platform: 'macos',
        facts: {
          product: record.product,
          bundle: record.bundle,
          bundleId: record.bundleId,
          executable: record.executable,
          pid: record.app?.pid ?? null,
          launched: record.hostLaunched ?? record.app !== undefined,
          build: record.build,
          logs: { dir: workspaceLogsDir(root) },
        },
      };
    }
    case 'web': {
      const result = await runWeb({ root, headed: options.headed ?? false, note: note(context), context });
      if (!result.ok) throw new StimError(result.error);
      if (result.remedy) note(context)(result.remedy);
      return { platform: 'web', facts: result.facts };
    }
    default:
      throw new StimError({ code: 'STIM_BAD_ARG', message: 'Unknown Stim platform.' });
  }
}
