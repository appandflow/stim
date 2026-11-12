import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ApiOperation } from '../run-operation.ts';
import type { StimClient, StimFailure, StimOptions } from './types.ts';

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

/** The client's project root: `projectRoot` resolved once, with `home` and `buildCache` checked as absolute paths. */
export function clientProjectRoot(options: StimOptions): string {
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
      throw new StimError({
        code: 'STIM_BAD_ARG',
        message: `${name} must be an absolute path.`,
        remedy: `Pass ${name} as an absolute path, or leave it out.`,
      });
    }
  }
  return projectRoot;
}

/** A client of `projectRoot` whose every operation is `call(name, args)`; typecheck holds it to `StimClient`. */
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
    gc: op('gc'),
    collectGarbage: op('collectGarbage'),
    deleteGarbageItem: op('deleteGarbageItem'),
    warmWorktree: op('warmWorktree'),
    removeWorktree: op('removeWorktree'),
    build: op('build'),
    run: op('run'),
    stop: op('stop'),
    reload: op('reload'),
    diagnostics: op('diagnostics'),
    settings: op('settings'),
    setSetting: op('setSetting'),
    unsetSetting: op('unsetSetting'),
    stats: op('stats'),
    logs: op('logs'),
    followLogs: op('followLogs'),
  };
}
