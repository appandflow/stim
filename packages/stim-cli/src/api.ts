import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getExecutor } from './exec.ts';
import { spawnEntry } from './spawn-entry.ts';
import type { StimClient, StimFailure, StimOptions, WorkerRequest, WorkerResponse } from './api/types.ts';

export type {
  StimClient,
  StimDiagnostics,
  StimDiagnosticsOptions,
  StimOptions,
  StimPlatform,
  StimProgress,
  StimRunOptions,
  StimRunResult,
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
 * Each operation runs in a separate Stim worker. Resources remain workspace-owned until stop() is called.
 */
export function createStim(options: StimOptions): StimClient {
  const projectRoot = realpathSync(options.projectRoot);
  for (const [name, path] of [
    ['home', options.home],
    ['buildCache', options.buildCache],
  ]) {
    if (path !== undefined && !isAbsolute(path)) {
      throw new StimError({ code: 'STIM_BAD_ARG', message: `${name} must be an absolute path.` });
    }
  }
  const context = {
    ...options,
    projectRoot,
    env: {
      ...process.env,
      ...(options.home === undefined ? {} : { STIM_HOME: options.home }),
      ...(options.buildCache === undefined ? {} : { STIM_BUILD_CACHE: options.buildCache }),
      FORCE_COLOR: '0',
    },
  };
  return {
    projectRoot,
    run({ signal, ...request }) {
      return invoke(context, { operation: 'run', options: request }, signal) as ReturnType<StimClient['run']>;
    },
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
