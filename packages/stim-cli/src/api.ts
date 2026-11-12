import { clientProjectRoot, facadeClient, StimError } from './api/facade.ts';
import type { RunOp } from './api/engine-route.ts';
import type { StimClient, StimFailure, StimOptions } from './api/types.ts';

export { StimError };

/** The integer of the `stim` API. It goes up only when an export is removed, renamed or changes meaning. */
export const STIM_API_VERSION = 1 as const;
export type {
  StimBuildOptions,
  StimBuildResult,
  StimClient,
  StimDiagnostics,
  StimDiagnosticsOptions,
  StimDoctorOptions,
  StimDoctorRepairOptions,
  StimDeviceUnlockOptions,
  StimDeviceToolOptions,
  StimDoctorReport,
  StimMachineAccessOptions,
  StimGcOptions,
  StimGcMutationOptions,
  StimGcMutationResult,
  StimGcItem,
  StimGcItemOptions,
  StimGcItemResult,
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
  StimRemoteMachines,
  StimStopOptions,
  StimStopResult,
  StimReloadOptions,
  StimReloadResult,
  StimStartOptions,
  StimStartResult,
  StimWorktreeWarmOptions,
  StimWorktreeRemoveOptions,
  StimWorktreeWarmResult,
  StimWorktreeRemoveResult,
} from './api/types.ts';

/**
 * Creates a client without starting processes or changing the caller's cwd, environment, or signal handlers.
 * The Stim home is fixed when the client is created: `home`, else STIM_HOME from `env`, else the default home.
 * Operations run in the calling process against the client's home and project, so clients for different
 * homes can share a process. While a machine engine of another build is installed, each operation runs that build's
 * `runOp`, loaded into this process, as a CLI command runs the engine.
 * Resources remain workspace-owned until stop() is called.
 */
export function createStim(options: StimOptions): StimClient {
  const projectRoot = clientProjectRoot(options);
  const env = { ...(options.env ?? process.env) };
  const ctx: StimOptions = { ...options, projectRoot, env };
  let local: Promise<StimClient> | undefined;
  const runLocal = async (name: string, args: unknown[]): Promise<unknown> => {
    local ??= import('./api/client.ts').then(({ createLocalStim }) => createLocalStim(ctx));
    const client = await local;
    return Reflect.apply(Reflect.get(client, name), client, args);
  };
  return facadeClient(projectRoot, async (name, args) => {
    let engine: Promise<RunOp | null> | null = null;
    if (options.admission !== 'none') {
      const { engineRunOp } = await import('./api/engine-route.ts');
      try {
        engine = engineRunOp(env);
      } catch {}
    }
    const runEngineOp = await engine;
    if (!runEngineOp) return runLocal(name, args);
    return runEngineOp(name, args, ctx).catch((failure: unknown) => {
      throw isPlainFailure(failure) ? new StimError(failure) : failure;
    });
  });
}

function isPlainFailure(value: unknown): value is StimFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

/**
 * F3's per-op entry: runs the operation `name` of a client made from `ctx` (the options of `createStim`) with `args`,
 * in this build. Resolves the operation's result, or rejects a plain `{code, message, remedy, details}`, so a caller
 * of another build can wrap it in its own `StimError`.
 */
export async function runOp(name: string, args: unknown[], ctx: StimOptions): Promise<unknown> {
  return (await import('./api/client.ts')).runOp(name, args, ctx);
}

/** Pins an existing daemon for the duration of a CI job. */
export async function holdCIStimd(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  ownedInstance: string | null,
  signal?: AbortSignal,
): Promise<() => void> {
  return (await import('./api/client.ts')).holdCIStimd(env, projectRoot, ownedInstance, signal);
}
