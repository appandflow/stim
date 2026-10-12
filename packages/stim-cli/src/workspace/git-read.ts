import type { ChildProcess } from 'node:child_process';
import { sep } from 'node:path';
import { gitAsync } from './git.ts';

export function childEnvironment(env: NodeJS.ProcessEnv): { env: Record<string, string>; omitEnv: string[] } {
  return {
    env: Object.fromEntries(
      Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
    ),
    omitEnv: Object.keys(process.env).filter((name) => env[name] === undefined),
  };
}

export function killOnAbort(signal: AbortSignal | undefined): (child: ChildProcess) => void {
  return (child) => {
    if (!signal) return;
    if (signal.aborted) return void child.kill('SIGKILL');
    const kill = () => child.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    child.once('close', () => signal.removeEventListener('abort', kill));
  };
}

/** `git rev-parse <args>` in `cwd` as a native path, or null; Git runs with exactly `env` and dies when `signal` aborts. */
export function gitPath(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string | null> {
  return gitAsync(cwd, ['rev-parse', ...args], { ...childEnvironment(env), onSpawn: killOnAbort(signal) }).then(
    (out) => {
      const path = out.trim();
      if (!path) return null;
      return sep === '/' ? path : path.replaceAll('/', sep);
    },
    () => null,
  );
}
