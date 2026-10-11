import { configDir, withAmbientContext, type StimContext } from '@stim-cli/core';
import { runId } from '@stim-cli/core/state';
import { operationState } from './engine/operation-state.ts';

const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
type Interrupt = keyof typeof EXIT_CODES;

/** The context of an operation this process runs for its own command line. */
export function processContext(projectRoot: string, signal: AbortSignal): StimContext {
  return {
    home: configDir(),
    buildCache: process.env.STIM_BUILD_CACHE || null,
    projectRoot,
    env: process.env,
    cwd: process.cwd(),
    runId: runId(),
    signal,
    output: (stream, text) => {
      process[stream].write(text);
    },
  };
}

export interface ProcessOperation {
  context: StimContext;
  /**
   * Cancel the operation as `interrupt` would. A second cancel, or a first one no part of the operation drains,
   * ends the process at once: with 130 or 143 when the operation acted on it, otherwise with the signal's default
   * disposition.
   */
  cancel(interrupt: Interrupt): void;
  /** The exit code a received interrupt asks for, or null. */
  interrupted(): number | null;
  /** Route this process's `SIGINT` and `SIGTERM` to `cancel`, and run its exit cleanups on any exit, until `dispose`. */
  listen(): void;
  dispose(): void;
}

export function processOperation(projectRoot: string): ProcessOperation {
  const controller = new AbortController();
  const context = processContext(projectRoot, controller.signal);
  let received: Interrupt | null = null;
  const runExitCleanups = () => {
    for (const cleanup of operationState(context).exitCleanups) {
      try {
        cleanup();
      } catch {}
    }
  };
  const exitNow = (code: number) => {
    runExitCleanups();
    process.exit(code);
  };
  const onInterrupt = () => operation.cancel('SIGINT');
  const onTerminate = () => operation.cancel('SIGTERM');
  const operation: ProcessOperation = {
    context,
    cancel(interrupt) {
      if (received) return exitNow(EXIT_CODES[received]);
      received = interrupt;
      controller.abort(interrupt);
      const state = operationState(context);
      if (state.draining) return;
      if (state.handled) return exitNow(EXIT_CODES[interrupt]);
      operation.dispose();
      process.kill(process.pid, interrupt);
    },
    interrupted: () => (received ? EXIT_CODES[received] : null),
    listen() {
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      process.on('exit', runExitCleanups);
    },
    dispose() {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('exit', runExitCleanups);
    },
  };
  return operation;
}

/**
 * Run `fn` as this process's operation: `SIGINT` and `SIGTERM` cancel it through its context, and the context is
 * also the ambient one for code that is not passed it yet. Returns `fn`'s value and the exit code an interrupt
 * asks for.
 */
export async function runProcessOperation<T>(
  projectRoot: string,
  fn: (context: StimContext) => Promise<T>,
): Promise<{ value: T; interrupted: number | null }> {
  const operation = processOperation(projectRoot);
  operation.listen();
  try {
    const value = await withAmbientContext(operation.context, () => fn(operation.context));
    return { value, interrupted: operation.interrupted() };
  } finally {
    operation.dispose();
  }
}

export function exitAfterFlush(
  code = 0,
  {
    exit = (c: number) => process.exit(c),
    stream = process.stdout,
  }: { exit?: (code: number) => void; stream?: NodeJS.WriteStream } = {},
): void {
  try {
    stream.write('', () => exit(code));
  } catch {
    exit(code);
  }
}
