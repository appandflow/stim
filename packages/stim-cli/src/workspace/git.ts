import { type ExecOptions, getExecutor } from '../exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

const GIT_TIMEOUT_MS = 10_000;
const GIT_CONCURRENCY = 6;

interface GitOptions extends Partial<ExecOptions> {
  /** The call changes the repository, so git may take its optional locks. Read-only calls run with `--no-optional-locks`. */
  write?: boolean;
  /** `gitAsync` only: aborts queued or active commands. */
  signal?: AbortSignal;
}

function gitCall(
  cwd: string,
  args: readonly string[],
  { write, signal: _signal, timeoutMs = GIT_TIMEOUT_MS, ...opts }: GitOptions,
) {
  return {
    args: [...(write ? [] : ['--no-optional-locks']), '-C', cwd, ...args],
    opts: { ...opts, timeoutMs },
  };
}

/** Runs git in `cwd`, bounded by `timeoutMs` (10 s by default); throws like `runFile`. */
export function git(cwd: string, args: readonly string[], opts: GitOptions = {}): string {
  const call = gitCall(cwd, args, opts);
  return getExecutor().runFile('git', call.args, call.opts);
}

/** `git`, returning null instead of throwing. */
export function gitQuiet(cwd: string, args: readonly string[], opts: GitOptions = {}): string | null {
  const call = gitCall(cwd, args, opts);
  return getExecutor().runFileQuiet('git', call.args, call.opts);
}

const queue: (() => void)[] = [];
let running = 0;

/** `git` without blocking the event loop, at most six at a time; the budget starts when the call leaves the queue. */
export async function gitAsync(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const signal = opts.signal ?? getExecutor().reportSignal?.();
  signal?.throwIfAborted();
  if (running < GIT_CONCURRENCY) running++;
  else
    await new Promise<void>((resolve, reject) => {
      const proceed = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = queue.indexOf(proceed);
        if (index !== -1) queue.splice(index, 1);
        reject(signal?.reason);
      };
      queue.push(proceed);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  let cleanupFailed = false;
  try {
    signal?.throwIfAborted();
    const call = gitCall(cwd, args, opts);
    return await getExecutor().runFileAsync('git', call.args, { ...call.opts, signal });
  } catch (error) {
    cleanupFailed =
      error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error);
    throw error;
  } finally {
    const next = queue.shift();
    if (next) next();
    else running--;
    if (!cleanupFailed) signal?.throwIfAborted();
  }
}

/** `gitAsync`, returning null for ordinary failures; cancellation and unresolved cleanup reject. */
export async function gitQuietAsync(
  cwd: string,
  args: readonly string[],
  opts: GitOptions = {},
): Promise<string | null> {
  try {
    return await gitAsync(cwd, args, opts);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    (opts.signal ?? getExecutor().reportSignal?.())?.throwIfAborted();
    return null;
  }
}
