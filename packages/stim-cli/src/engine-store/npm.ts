import { delimiter, dirname } from 'node:path';

/** `env` with PATH led by the directory of the Node running stim, where npm and the `node` its shebang names live. */
export function npmEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { [key]: [dirname(process.execPath), env[key]].filter(Boolean).join(delimiter) };
}
