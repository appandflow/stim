import { delimiter } from 'node:path';
import { projectNodeBin, satisfiesNodePin } from '@stim-cli/core/toolchain';
import { getExecutor } from '../exec.ts';

function pathNodeVersion(env: NodeJS.ProcessEnv): string | null {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  return getExecutor().runFileQuiet('node', ['-p', 'process.versions.node'], { timeoutMs: 5000, env: childEnv });
}

/**
 * `env` with the Node that `root` pins (`.nvmrc`, `.node-version`, `.tool-versions` or Volta) first on `PATH`,
 * for the dev server Stim starts through its `#!/usr/bin/env node` script. It changes nothing when the project pins
 * no Node, when no installed Node satisfies the pin, or when the `node` already on `PATH` satisfies it.
 */
export function withProjectNode(
  root: string,
  env: NodeJS.ProcessEnv,
  { nodeVersion = pathNodeVersion }: { nodeVersion?: (env: NodeJS.ProcessEnv) => string | null } = {},
): { env: NodeJS.ProcessEnv; pinned: { bin: string; version: string; pin: string } | null } {
  const pinned = projectNodeBin(root, env);
  if (!pinned) return { env, pinned: null };
  const current = nodeVersion(env);
  if (current && satisfiesNodePin(current, pinned.spec)) return { env, pinned: null };
  return {
    env: { ...env, PATH: [pinned.bin, ...(env.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter) },
    pinned,
  };
}
