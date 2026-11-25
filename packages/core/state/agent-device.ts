import { readdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configDir } from '../index.ts';
import { ambientEnv } from '../context.ts';
import { agentDeviceStateDirsIn, userHome } from './paths.ts';

export function agentDeviceStateDirs(
  home: string = userHome(ambientEnv()),
  env: NodeJS.ProcessEnv = ambientEnv(),
): string[] {
  const override = env.AGENT_DEVICE_STATE_DIR?.trim();
  const dirs = new Set([override ? resolve(override) : join(home, '.agent-device')]);
  const workspaces = join(configDir(), 'workspaces');
  try {
    for (const name of readdirSync(workspaces))
      for (const dir of agentDeviceStateDirsIn(join(workspaces, name)))
        try {
          if (statSync(dir).isDirectory()) dirs.add(dir);
        } catch {}
  } catch {}
  return [...dirs];
}

export async function agentDeviceStateDirsAsync(
  home: string = userHome(ambientEnv()),
  env: NodeJS.ProcessEnv = ambientEnv(),
): Promise<string[]> {
  const override = env.AGENT_DEVICE_STATE_DIR?.trim();
  const dirs = new Set([override ? resolve(override) : join(home, '.agent-device')]);
  const workspaces = join(configDir(), 'workspaces');
  try {
    for (const name of await readdir(workspaces))
      for (const dir of agentDeviceStateDirsIn(join(workspaces, name)))
        try {
          if ((await stat(dir)).isDirectory()) dirs.add(dir);
        } catch {}
  } catch {}
  return [...dirs];
}
