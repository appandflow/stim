import { type ExecOptions, getExecutor } from '../exec.ts';

const GIT_TIMEOUT_MS = 10_000;
const GIT_CONCURRENCY = 6;

interface GitOptions extends Partial<ExecOptions> {
  /** The call changes the repository, so git may take its optional locks. Read-only calls run with `--no-optional-locks`. */
  write?: boolean;
}

function gitCall(cwd: string, args: readonly string[], { write, timeoutMs = GIT_TIMEOUT_MS, ...opts }: GitOptions) {
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
  if (running < GIT_CONCURRENCY) running++;
  else await new Promise<void>((proceed) => queue.push(proceed));
  try {
    const call = gitCall(cwd, args, opts);
    return await getExecutor().runFileAsync('git', call.args, call.opts);
  } finally {
    const next = queue.shift();
    if (next) next();
    else running--;
  }
}
