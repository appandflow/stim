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

/** The options of `createStim` under the names an engine of any build reads. */
export function engineOptions({ buildCacheDir, ...options }: StimOptions): EngineOptions {
  return buildCacheDir === undefined ? options : { ...options, buildCache: buildCacheDir };
}

function engineRunOptions(options: StimRunOptions): EngineRunOptions {
  if (typeof options !== 'object' || options === null || !('waitSeconds' in options)) return options;
  const { waitSeconds, ...rest } = options;
  return waitSeconds === undefined ? rest : { ...rest, wait: waitSeconds === false ? false : String(waitSeconds) };
}

function engineDiagnosticsOptions(options?: StimDiagnosticsOptions): EngineDiagnosticsOptions | undefined {
  if (typeof options !== 'object' || options === null || !('errorsOnly' in options)) return options;
  const { errorsOnly, ...rest } = options;
  return errorsOnly === undefined ? rest : { ...rest, errors: errorsOnly };
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
  return {
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
    run: (options: StimRunOptions) => op('run')(engineRunOptions(options)),
    stop: op('stop'),
    reload: op('reload'),
    diagnostics: (options?: StimDiagnosticsOptions) => op('diagnostics')(engineDiagnosticsOptions(options)),
    settings: op('settings'),
    setSetting: op('setSetting'),
    unsetSetting: op('unsetSetting'),
    stats: op('stats'),
    logs: op('logs'),
    followLogs: op('followLogs'),
  };
}
