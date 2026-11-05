import { AsyncLocalStorage } from 'node:async_hooks';

/** Where an operation writes progress that the CLI prints and an API client receives through `onProgress`. */
export type StimOutput = (stream: 'stdout' | 'stderr', text: string) => void;

/**
 * Everything one Stim operation takes from its caller instead of from `process`. The CLI builds one per command
 * from `process`; `createStim` builds one per operation from the client's options. Engine code receives it as a
 * parameter.
 */
export interface StimContext {
  home: string;
  buildCache: string | null;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  runId: string;
  signal: AbortSignal;
  output: StimOutput;
}

const ambient = new AsyncLocalStorage<StimContext>();

/**
 * Runs `fn` with `context` reachable through `ambientContext()`, including after an `await` inside it. A temporary
 * bridge for call sites that are not passed a context yet: `configDir()`, `runId()` and the exec wrapper's base
 * environment.
 */
export function withAmbientContext<T>(context: StimContext, fn: () => T): T {
  return ambient.run(context, fn);
}

/** The context set by `withAmbientContext`, for call sites that are not passed one yet. */
export function ambientContext(): StimContext | undefined {
  return ambient.getStore();
}

/** Writes `text` to the ambient context's output, or to the process stream outside one. */
export function ambientWrite(stream: 'stdout' | 'stderr', text: string): void {
  const context = ambient.getStore();
  if (context) context.output(stream, text);
  else process[stream].write(text);
}

/** The environment of the ambient context, or `process.env` outside one. */
export function ambientEnv(): NodeJS.ProcessEnv {
  return ambient.getStore()?.env ?? process.env;
}
