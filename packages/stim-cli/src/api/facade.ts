import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ApiOperation } from '../run-operation.ts';
import type {
  EngineDiagnosticsOptions,
  EngineOptions,
  EngineRunOptions,
  StimClient,
  StimDiagnosticsOptions,
  StimFailure,
  StimOptions,
  StimRunOptions,
} from './types.ts';

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

/** The client's project root: `projectRoot` resolved once, with `home` and the cache directory checked as absolute paths. */
export function clientProjectRoot(
  options: { projectRoot: string; home?: string },
  cacheDir: readonly [name: string, path: string | undefined],
): string {
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
  for (const [name, path] of [['home', options.home], cacheDir]) {
    if (path !== undefined && !isAbsolute(path)) {
      throw new StimError({
        code: 'STIM_BAD_ARG',
        message: `${name} must be an absolute path.`,
        remedy: `Pass ${name} as an absolute path, or leave it out.`,
      });
    }
  }
  return projectRoot;
}

// compat C30 until 2026-12-12
function renamed(old: string, next: string, remedy: string): StimError {
  return new StimError({
    code: 'STIM_BAD_ARG',
    message: `${old} was renamed to ${next}.`,
    remedy,
  });
}
// compat end

/** The options of `createStim` under the names an engine of any build reads. */
export function engineOptions({ buildCacheDir, ...options }: StimOptions): EngineOptions {
  // compat C30 until 2026-12-12
  if ('buildCache' in options) throw renamed('buildCache', 'buildCacheDir', 'Pass the directory as buildCacheDir.');
  // compat end
  return buildCacheDir === undefined ? options : { ...options, buildCache: buildCacheDir };
}

function engineRunOptions(options: StimRunOptions): EngineRunOptions {
  if (typeof options !== 'object' || options === null) return options;
  // compat C30 until 2026-12-12
  if ('wait' in options)
    throw renamed('wait', 'waitSeconds', 'Pass waitSeconds as a number of seconds, or false to not wait.');
  // compat end
  if (!('waitSeconds' in options)) return options;
  const { waitSeconds, ...rest } = options;
  if (waitSeconds === undefined) return rest;
  if (waitSeconds !== false && (!Number.isSafeInteger(waitSeconds) || waitSeconds <= 0))
    throw new StimError({
      code: 'STIM_BAD_ARG',
      message: 'waitSeconds must be a positive whole number, or false.',
      remedy: 'Pass waitSeconds as a whole number of seconds above 0, false to not wait, or leave it out.',
    });
  return { ...rest, wait: waitSeconds === false ? false : String(waitSeconds) };
}

function engineDiagnosticsOptions(options?: StimDiagnosticsOptions): EngineDiagnosticsOptions | undefined {
  if (typeof options !== 'object' || options === null) return options;
  // compat C30 until 2026-12-12
  if ('errors' in options) throw renamed('errors', 'errorsOnly', 'Pass errorsOnly with the same boolean.');
  // compat end
  if (!('errorsOnly' in options)) return options;
  const { errorsOnly, ...rest } = options;
  return errorsOnly === undefined ? rest : { ...rest, errors: errorsOnly };
}

/** Rejects with the refusal `translate` throws, or runs `send` with what it returns. */
function translated<T>(translate: () => T, send: (value: T) => Promise<never>): Promise<never> {
  let value: T;
  try {
    value = translate();
  } catch (error) {
    return Promise.reject(error);
  }
  return send(value);
}

/**
 * A client of `projectRoot` whose every operation is `call(name, args)` with the engine's operation name and options,
 * which keep their names across builds; typecheck holds it to `StimClient`.
 */
export function facadeClient(
  projectRoot: string,
  call: (name: ApiOperation, args: unknown[]) => Promise<unknown>,
): StimClient {
  const dispatch: Function = call;
  const op =
    (name: ApiOperation): ((...args: unknown[]) => Promise<never>) =>
    (...args) =>
      Reflect.apply(dispatch, undefined, [name, args]);
  const client: StimClient = {
    projectRoot,
    start: op('start'),
    identity: op('identity'),
    doctor: op('doctor'),
    remoteMachines: op('remoteMachines'),
    repairDoctor: op('repairDoctor'),
    unlockDevice: op('unlockDevice'),
    deviceTool: op('deviceTool'),
    requestMachineAccess: op('requestMachineAccess'),
    plan: op('plan'),
    previewGarbage: op('gc'),
    collectGarbage: op('collectGarbage'),
    deleteGarbageItem: op('deleteGarbageItem'),
    warmWorktree: op('warmWorktree'),
    removeWorktree: op('removeWorktree'),
    build: op('build'),
    run: (options: StimRunOptions) => translated(() => engineRunOptions(options), op('run')),
    stop: op('stop'),
    reload: op('reload'),
    diagnostics: (options?: StimDiagnosticsOptions) =>
      translated(() => engineDiagnosticsOptions(options), op('diagnostics')),
    settings: op('settings'),
    setSetting: op('setSetting'),
    unsetSetting: op('unsetSetting'),
    stats: op('stats'),
    logs: op('logs'),
    followLogs: op('followLogs'),
  };
  // compat C30 until 2026-12-12
  return Object.assign(client, {
    gc: () => Promise.reject(renamed('gc()', 'previewGarbage()', 'Call previewGarbage() with the same options.')),
  });
  // compat end
}
