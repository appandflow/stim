import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiledHelper, configDir, type StimContext } from '@stim-cli/core';
import { getExecutor } from './exec.ts';
import { runOperationFile, runOperationFileQuiet } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';

const SOURCE = 'stim-clonefile.c';
const COMPILE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5000;

function helperSource(): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') return fileURLToPath(new URL(`../helper/${SOURCE}`, import.meta.url));
  return join(dirname(here), SOURCE);
}

/** The `stim-clonefile` helper, compiled on first use, or null off macOS, without the Command Line Tools, or when the compile fails. */
export async function clonefileHelper(operation: StimContext): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const exec = getExecutor();
  const developer = await runOperationFileQuiet(operation, exec, 'xcode-select', ['-p'], {
    timeoutMs: PROBE_TIMEOUT_MS,
    cwd: operation.cwd,
  });
  if (!developer) return null;
  const source = helperSource();
  try {
    return await compiledHelper({
      dir: join(configDir(), 'helpers'),
      name: 'stim-clonefile',
      inputs: [source],
      version: '',
      prune: false,
      compile: async (output) => {
        await runOperationFile(operation, exec, 'xcrun', ['clang', '-O2', '-o', output, source], {
          timeoutMs: COMPILE_TIMEOUT_MS,
          cwd: operation.cwd,
        });
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation.signal.throwIfAborted();
    return null;
  }
}
