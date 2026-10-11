import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { type StimContext, withAmbientContext } from '@stim-cli/core';
import { findProjectRoot, RUN_ID_ENV, validRunId } from '@stim-cli/core/state';
import { readProjectStats } from './engine/stats-report.ts';
import { getExecutor } from './exec.ts';
import { spawnEntry } from './spawn-entry.ts';
import { refuseRelativeStimPaths } from './workspace/config.ts';
import { readSettingsContext, readSettingsPayload, SettingsRefusal } from './workspace/settings-payload.ts';
import type {
  StimBuildOptions,
  StimClient,
  StimFailure,
  StimOptions,
  StimReadOptions,
  StimRunOptions,
  WorkerRequest,
  WorkerResponse,
} from './api/types.ts';

export type {
  StimBuildOptions,
  StimBuildResult,
  StimClient,
  StimDiagnostics,
  StimDiagnosticsOptions,
  StimOptions,
  StimPlatform,
  StimProgress,
  StimReadOptions,
  StimRunOptions,
  StimRunResult,
  StimSettings,
  StimStats,
  StimStopOptions,
  StimStopResult,
} from './api/types.ts';

export class StimError extends Error {
  readonly code: string;
  readonly remedy: string | null;
  readonly details: unknown;

  constructor({ code, message, remedy = null, details }: Omit<StimFailure, 'remedy'> & { remedy?: string | null }) {
    super(message);
    this.name = 'StimError';
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

/**
 * Creates a client without starting processes or changing the caller's cwd, environment, or signal handlers.
 * The Stim home is fixed when the client is created: `home`, else STIM_HOME from `env`, else the default home.
 * build, run, stop and diagnostics each run in a separate Stim worker. Reads such as settings and stats run in the calling
 * process against the client's home and project, so clients for different homes can share a process.
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
  const home = options.home ?? (base.STIM_HOME || join(base.HOME || homedir(), '.stim'));
  const context = {
    ...options,
    projectRoot,
    env: {
      ...base,
      ...(options.home === undefined ? {} : { STIM_HOME: options.home }),
      ...(options.buildCache === undefined ? {} : { STIM_BUILD_CACHE: options.buildCache }),
      FORCE_COLOR: '0',
    },
  };
  const output = (stream: 'stdout' | 'stderr', message: string) => options.onProgress?.({ stream, message });
  const note = (line: string) => output('stderr', `${line}\n`);
  return {
    projectRoot,
    settings: ({ signal }: StimReadOptions = {}) =>
      read(operationContext(context, home, output, signal), async (operation) =>
        readSettingsPayload(
          await readSettingsContext(operation.projectRoot, operation.env, note, operation.signal),
          operation.signal,
        ),
      ),
    stats: ({ signal }: StimReadOptions = {}) =>
      read(
        operationContext(context, home, output, signal),
        async (operation) =>
          (await readProjectStats(findProjectRoot(operation.projectRoot), operation.env, operation.signal)).report,
      ),
    build: (({ signal, ...request }: StimBuildOptions) =>
      invoke(context, { operation: 'build', options: request }, signal)) as StimClient['build'],
    run: (({ signal, ...request }: StimRunOptions) =>
      invoke(context, { operation: 'run', options: request }, signal)) as StimClient['run'],
    stop({ signal, ...request } = {}) {
      return invoke(context, { operation: 'stop', options: request }, signal) as ReturnType<StimClient['stop']>;
    },
    diagnostics({ signal, ...request } = {}) {
      if (request.tail !== undefined && (!Number.isSafeInteger(request.tail) || request.tail < 0)) {
        return Promise.reject(new StimError({ code: 'STIM_BAD_ARG', message: 'tail must be a non-negative integer.' }));
      }
      return invoke(context, { operation: 'diagnostics', options: request }, signal) as ReturnType<
        StimClient['diagnostics']
      >;
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

async function read<T>(context: StimContext, operation: (context: StimContext) => Promise<T>): Promise<T> {
  const { signal } = context;
  if (signal.aborted) throw cancelled();
  let result: T;
  try {
    refuseRelativeStimPaths(context.env);
    result = await withAmbientContext(context, () => operation(context));
  } catch (error) {
    if (signal.aborted) throw cancelled();
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('STIM_')) {
      const remedy = error instanceof SettingsRefusal ? error.remedy : null;
      throw new StimError({ code: error.code, message: error.message, remedy });
    }
    throw error;
  }
  if (signal.aborted) throw cancelled();
  return result;
}

function cancelled(): StimError {
  return new StimError({ code: 'STIM_CANCELLED', message: 'The Stim operation was cancelled.' });
}

function invoke(
  context: StimOptions & { env: NodeJS.ProcessEnv },
  request: WorkerRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const child = getExecutor().spawn(process.execPath, [spawnEntry('api-run')], {
      cwd: context.projectRoot,
      env: context.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let response: WorkerResponse | undefined;
    let transportError: Error | undefined;
    let callbackError: unknown;
    let callbackFailed = false;
    let stderr = '';
    const abort = () => {
      child.send?.({ operation: 'cancel' }, (error) => {
        if (error) child.kill('SIGINT');
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const progress = (stream: 'stdout' | 'stderr', message: string) => {
      if (stream === 'stderr') stderr = (stderr + message).slice(-16_384);
      if (!context.onProgress || callbackFailed) return;
      try {
        context.onProgress({ stream, message });
      } catch (error) {
        callbackError = error;
        callbackFailed = true;
        abort();
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => progress('stdout', chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => progress('stderr', chunk));
    child.on('message', (message: WorkerResponse) => {
      response = message;
    });
    child.on('error', (error) => {
      transportError = error;
    });
    child.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      if (callbackFailed) return reject(callbackError);
      if (signal?.aborted) return reject(cancelled());
      if (transportError)
        return reject(
          new StimError({
            code: 'STIM_WORKER_FAILED',
            message: transportError.message,
            details: { stderr },
          }),
        );
      if (response?.ok === false) return reject(new StimError(response.error));
      if (code === 0 && response?.ok) return resolve(response.result);
      reject(
        new StimError({
          code: 'STIM_WORKER_FAILED',
          message: `Stim worker exited without a result (${exitSignal ?? code}).`,
          details: { stderr },
        }),
      );
    });
    child.send?.({ ...request, projectRoot: context.projectRoot }, (error) => {
      if (error) transportError = error;
    });
  });
}
