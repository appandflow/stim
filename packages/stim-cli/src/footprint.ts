import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiledHelper, configDir, type StimContext } from '@stim-cli/core';
import { getExecutor } from './exec.ts';
import { runOperationFile, runOperationFileQuiet } from './engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';

const SOURCE = 'stim-footprint.swift';
const COMPILE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 5000;

function helperSource(): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') return fileURLToPath(new URL(`../helper/${SOURCE}`, import.meta.url));
  return join(dirname(here), SOURCE);
}

async function buildHelper(operation?: StimContext): Promise<string | null> {
  const exec = getExecutor();
  const developer = operation
    ? await runOperationFileQuiet(operation, exec, 'xcode-select', ['-p'], {
        timeoutMs: READ_TIMEOUT_MS,
        cwd: operation.cwd,
      })
    : exec.runFileQuiet('xcode-select', ['-p'], { timeoutMs: READ_TIMEOUT_MS });
  if (!developer) return null;
  const source = helperSource();
  try {
    return await compiledHelper({
      dir: join(configDir(), 'helpers'),
      name: 'stim-footprint',
      inputs: [source],
      version: '',
      prune: !operation,
      compile: async (output) => {
        await runOperationFile(
          operation,
          exec,
          'xcrun',
          ['swiftc', '-O', '-swift-version', '5', '-o', output, source],
          {
            timeoutMs: COMPILE_TIMEOUT_MS,
            cwd: operation?.cwd,
          },
        );
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    return null;
  }
}

const RETRY_BACKOFF_INITIAL_MS = 10_000;
const RETRY_BACKOFF_MAX_MS = 10 * 60_000;

let built: { home: string; promise: Promise<string | null> } | null = null;
let failure: { home: string; nextRetryAt: number; backoffMs: number } | null = null;

/** The `stim-footprint` helper, compiled on first use. A success is kept for the process's life; a failure retries after a doubling backoff instead of being pinned forever. */
function footprintHelper(operation?: StimContext): Promise<string | null> {
  if (operation) return buildHelper(operation);
  const home = configDir();
  if (built?.home === home) return built.promise;
  if (failure?.home === home && Date.now() < failure.nextRetryAt) return Promise.resolve(null);
  const promise = buildHelper(operation).then((helper) => {
    if (helper === null) {
      const backoffMs =
        failure?.home === home ? Math.min(failure.backoffMs * 2, RETRY_BACKOFF_MAX_MS) : RETRY_BACKOFF_INITIAL_MS;
      failure = { home, nextRetryAt: Date.now() + backoffMs, backoffMs };
      if (built?.promise === promise) built = null;
      return null;
    }
    return helper;
  });
  built = { home, promise };
  return promise;
}

/** Parses the helper's `<pid> <bytes>` lines into footprint bytes by pid. */
function parseFootprints(output: string): Map<number, number> {
  const footprints = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+) (\d+)$/.exec(line.trim());
    if (match) footprints.set(Number(match[1]), Number(match[2]));
  }
  return footprints;
}

/** Every readable process's physical footprint in bytes, or null when the helper is unavailable or fails. */
export async function readFootprints(operation?: StimContext): Promise<Map<number, number> | null> {
  const helper = await footprintHelper(operation);
  const output = helper
    ? operation
      ? await runOperationFileQuiet(operation, getExecutor(), helper, [], {
          timeoutMs: READ_TIMEOUT_MS,
          cwd: operation.cwd,
        })
      : getExecutor().runFileQuiet(helper, [], { timeoutMs: READ_TIMEOUT_MS })
    : null;
  return output === null ? null : parseFootprints(output);
}
