import type { StimContext } from '@stim-cli/core';
import type { Executor, ExecOptions } from '../exec.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { childEnvironment, killOnAbort } from '../workspace/git-read.ts';
import { operationState } from './operation-state.ts';

export async function runOperationFile(
  context: StimContext | undefined,
  executor: Executor,
  file: string,
  args: string[],
  options: ExecOptions,
): Promise<string> {
  const signal = context ? (operationState(context).runSignal ?? context.signal) : undefined;
  throwIfCancelled(signal, file);
  const environment = context ? childEnvironment(context.env) : { env: {}, omitEnv: [] };
  const output = await executor.runFileAsync(file, args, {
    ...environment,
    ...options,
    ...(context ? { env: { ...environment.env, ...options.env } } : {}),
    omitEnv: [...environment.omitEnv.filter((name) => options.env?.[name] === undefined), ...(options.omitEnv ?? [])],
    declareFor: context,
    onSpawn: killOnAbort(signal),
  });
  throwIfCancelled(signal, file);
  return output;
}
