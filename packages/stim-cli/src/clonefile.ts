import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiledHelper, configDir, type StimContext } from '@stim-cli/core';
import { getExecutor } from './exec.ts';
import { runOperationFile, runOperationFileQuiet } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';

const COMPILE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5000;

function helperSource(source: string): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') return fileURLToPath(new URL(`../helper/${source}`, import.meta.url));
  return join(dirname(here), source);
}

/** The `stim-clonefile` helper, compiled on first use, or null off macOS, without the Command Line Tools, or when the compile fails. */
export function clonefileHelper(operation: StimContext): Promise<string | null> {
  return compiledCHelper('stim-clonefile', operation);
}

/**
 * The `stim-privsize` helper, compiled on first use, or null off macOS, without the Command Line Tools, or when the
 * compile fails or does not finish within `timeoutMs`.
 */
export function privateSizeHelper(operation?: StimContext, timeoutMs?: number): Promise<string | null> {
  return compiledCHelper('stim-privsize', operation, timeoutMs);
}

async function compiledCHelper(
  name: string,
  operation: StimContext | undefined,
  timeoutMs: number = PROBE_TIMEOUT_MS + COMPILE_TIMEOUT_MS,
): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const deadline = Date.now() + timeoutMs;
  const exec = getExecutor();
  const developer = await runOperationFileQuiet(operation, exec, 'xcode-select', ['-p'], {
    timeoutMs: Math.min(PROBE_TIMEOUT_MS, timeoutMs),
    cwd: operation?.cwd,
  });
  if (!developer) return null;
  const source = helperSource(`${name}.c`);
  try {
    return await compiledHelper({
      dir: join(configDir(), 'helpers'),
      name,
      inputs: [source],
      version: '',
      prune: false,
      compile: async (output) => {
        await runOperationFile(operation, exec, 'xcrun', ['clang', '-O2', '-o', output, source], {
          timeoutMs: Math.max(1, Math.min(COMPILE_TIMEOUT_MS, deadline - Date.now())),
          cwd: operation?.cwd,
        });
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    return null;
  }
}
