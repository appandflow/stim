import type { StimContext } from '@stim-cli/core';
import { binaryPath, type NotCloned } from 'cow-clone';
import { runOperationFile } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import { getExecutor, type ExecOptions } from './exec.ts';

/** Why a pair was not cloned, in cow-clone's terms. `path` is the entry the failing call was about. */
export type CloneFailure = Pick<NotCloned, 'reason' | 'code' | 'message' | 'path'>;

/**
 * Clones each `[source, destination]` pair copy-on-write with the prebuilt cow-clone binary, in one child process:
 * one clonefile(2) call per pair on APFS, a file-by-file walk on btrfs, XFS, ReFS and a Dev Drive. A destination
 * must not exist. Returns null for a pair that cloned and the failure for one that did not, whose partial
 * destination cow-clone has removed; a pair that fails does not stop the ones after it.
 */
export async function clonePairs(
  operation: StimContext,
  pairs: readonly (readonly [source: string, destination: string])[],
  { timeoutMs = 'unbounded' }: Partial<Pick<ExecOptions, 'timeoutMs'>> = {},
): Promise<(CloneFailure | null)[]> {
  if (!pairs.length) return [];
  const every = (failure: Omit<CloneFailure, 'path'>) => pairs.map(([, path]) => ({ ...failure, path }));
  const binary = binaryPath();
  if (!binary)
    return every({
      reason: 'unsupported',
      code: 'ENOTSUP',
      message: `cow-clone has no binary for ${process.platform}-${process.arch}`,
    });
  let output: unknown;
  let failure = { code: '', message: 'cow-clone printed no result' };
  try {
    // cow-clone --stdin reads NUL-terminated paths, so no pair count reaches the command-line length limit.
    output = await runOperationFile(operation, getExecutor(), binary, ['--json', '--stdin'], {
      timeoutMs,
      cwd: operation.cwd,
      input: pairs.map(([source, destination]) => `${source}\0${destination}\0`).join(''),
    });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation.signal.throwIfAborted();
    // cow-clone exits 1 when a pair did not clone and still prints every result.
    if (error instanceof Error && 'status' in error && error.status === 1 && 'stdout' in error) output = error.stdout;
    failure = {
      code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '',
      message: (error instanceof Error ? error.message : String(error)).trim().split('\n').at(-1) ?? failure.message,
    };
  }
  try {
    const { results }: { results: ({ cloned: true } | ({ cloned: false } & CloneFailure))[] } = JSON.parse(
      String(output),
    );
    if (results.length === pairs.length)
      return results.map((result) =>
        result.cloned ? null : { reason: result.reason, code: result.code, message: result.message, path: result.path },
      );
  } catch {}
  return every({ reason: 'failed', ...failure });
}

/** One clause saying why a clone did not happen, with cow-clone's reason and errno name. */
export function describeCloneFailure({ reason, code, message, path }: CloneFailure): string {
  if (reason === 'unsupported') return `the file system cannot clone (unsupported, ${code})`;
  if (reason === 'cross-device')
    return `the source and the destination are on different volumes (cross-device, ${code})`;
  return `${message}: ${path} (${code ? `failed, ${code}` : 'failed'})`;
}
