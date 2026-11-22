import { dirname } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { lowPriorityCommand } from '../io-priority.ts';
import { removeTemporaryEntryAsync } from '../temporary.ts';
import { runOperationFile } from './operation-exec.ts';
import { operationState } from './operation-state.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-lock.ts';

export async function removeTree(
  path: string,
  operation?: StimContext,
  signal?: AbortSignal,
  throttleIo = false,
): Promise<void> {
  const operationSignal = operation ? (operationState(operation).runSignal ?? operation.signal) : undefined;
  const removalSignal =
    operationSignal && signal && operationSignal !== signal
      ? AbortSignal.any([operationSignal, signal])
      : (operationSignal ?? signal);
  removalSignal?.throwIfAborted();
  if (process.platform !== 'win32') {
    const args = ['-rf', '--', path];
    const [file, argv]: [string, string[]] = throttleIo ? lowPriorityCommand('rm', args, true) : ['rm', args];
    try {
      await runOperationFile(operation, getExecutor(), file, argv, {
        timeoutMs: 'unbounded',
        signal: removalSignal,
        cwd: dirname(path),
      });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      removalSignal?.throwIfAborted();
    }
  }
  await removeTemporaryEntryAsync(path, removalSignal);
}
