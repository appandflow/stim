import { delimiter } from 'node:path';
import { meetsNodePinMajor, projectNodeBin, projectNodePin, satisfiesNodePin } from '@stim-cli/core/toolchain';
import { getExecutor } from '../exec.ts';

function pathNodeVersion(env: NodeJS.ProcessEnv): string | null {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  return getExecutor().runFileQuiet('node', ['-p', 'process.versions.node'], { timeoutMs: 5000, env: childEnv });
}

/**
 * `env` with the Node `projectNodeBin` picks for the pin in `root`, or the nearest directory above it up to `top`
 * (`.nvmrc`, `.node-version`, `.tool-versions` or Volta), first on `PATH`, for the processes Stim starts that run the
 * project's own Node code. It changes nothing when the project pins no Node, when no install fits the pin, or when
 * the `node` already on `PATH` satisfies it: matching the pin, or, when no install matches it, of its major and not
 * older than it.
 */
export function withProjectNode(
  root: string,
  env: NodeJS.ProcessEnv,
  {
    nodeVersion = pathNodeVersion,
    top = root,
  }: { nodeVersion?: (env: NodeJS.ProcessEnv) => string | null; top?: string } = {},
): {
  env: NodeJS.ProcessEnv;
  pinned: { bin: string; version: string; pin: string; spec: string; match: 'exact' | 'major' } | null;
} {
  const pinned = projectNodeBin(root, env, undefined, top);
  if (!pinned) return { env, pinned: null };
  const current = nodeVersion(env);
  if (
    current &&
    (satisfiesNodePin(current, pinned.spec) || (pinned.match === 'major' && meetsNodePinMajor(current, pinned.spec)))
  )
    return { env, pinned: null };
  return {
    env: { ...env, PATH: [pinned.bin, ...(env.PATH ?? '').split(delimiter).filter(Boolean)].join(delimiter) },
    pinned,
  };
}

/**
 * Why the project's own Node code may have failed under `env`: the pin that `root`, or the nearest directory above it
 * up to `top`, sets when neither an install nor the `node` on `PATH` fits it as `withProjectNode` decides, else null.
 */
export function unmetNodePin(
  root: string,
  env: NodeJS.ProcessEnv,
  {
    nodeVersion = pathNodeVersion,
    top = root,
  }: { nodeVersion?: (env: NodeJS.ProcessEnv) => string | null; top?: string } = {},
): string | null {
  const pin = projectNodePin(root, undefined, top);
  if (!pin || projectNodeBin(root, env, undefined, top)) return null;
  const current = nodeVersion(env);
  if (current && (satisfiesNodePin(current, pin.spec) || meetsNodePinMajor(current, pin.spec))) return null;
  return `Node ${current ?? 'unknown'} on PATH does not satisfy ${pin.file} ${pin.spec}, and no installed Node does.`;
}
