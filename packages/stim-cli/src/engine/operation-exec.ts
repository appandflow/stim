import type { StimContext } from '@stim-cli/core';
import type { Executor, ExecOptions } from '../exec.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { childEnvironment } from '../workspace/git-read.ts';
import { operationState } from './operation-state.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-lock.ts';

export async function runOperationFile(
  context: StimContext | undefined,
  executor: Executor,
  file: string,
  args: string[],
  options: ExecOptions,
): Promise<string> {
  const signal = context ? (operationState(context).runSignal ?? context.signal) : options.signal;
  throwIfCancelled(signal, file);
  const environment = context ? childEnvironment(context.env) : { env: {}, omitEnv: [] };
  const output = await executor.runFileAsync(file, args, {
    ...environment,
    ...options,
    ...(context ? { env: { ...environment.env, ...options.env } } : {}),
    omitEnv: [...environment.omitEnv.filter((name) => options.env?.[name] === undefined), ...(options.omitEnv ?? [])],
    declareFor: context,
    signal,
  });
  throwIfCancelled(signal, file);
  return output;
}

/** Contextual probes return null for ordinary failures and propagate cancellation or unresolved cleanup; other calls retain the executor's quiet behavior. */
export async function runOperationFileQuiet(
  context: StimContext | undefined,
  executor: Executor,
  file: string,
  args: string[],
  options: ExecOptions,
): Promise<string | null> {
  const signal = context ? (operationState(context).runSignal ?? context.signal) : options.signal;
  signal?.throwIfAborted();
  try {
    const output = context
      ? await runOperationFile(context, executor, file, args, options)
      : await executor.runFileQuietAsync(file, args, options);
    options.signal?.throwIfAborted();
    signal?.throwIfAborted();
    return output;
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    options.signal?.throwIfAborted();
    signal?.throwIfAborted();
    return null;
  }
}
