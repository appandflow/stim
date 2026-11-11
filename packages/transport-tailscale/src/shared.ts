import { execFile, type ExecFileException } from 'node:child_process';

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The environment to run the Tailscale CLI with. The macOS Tailscale.app CLI prints "The Tailscale GUI failed to start"
 * instead of its output when `TERM` is unset, as under launchd (https://github.com/appandflow/stim/issues/4500).
 */
function tailscaleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.TERM ? env : { ...env, TERM: 'dumb' };
}

export function portOf(hostPort: string): number {
  return Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
}

export interface Ran {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}

/** Runs the tailscale command; each caller turns a failure into its own message. */
export function runTailscale(
  binary: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options: { timeout: number; maxBuffer?: number; kill?: boolean },
): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        env: tailscaleEnv(env),
        timeout: options.timeout,
        ...(options.kill === false ? {} : { killSignal: 'SIGKILL' as const }),
        ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}
