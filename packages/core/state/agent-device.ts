import { readdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { configDir } from '../index.ts';
import { ambientEnv } from '../context.ts';

export function agentDeviceStateDirs(
  home: string = ambientEnv().HOME || ambientEnv().USERPROFILE || homedir(),
  env: NodeJS.ProcessEnv = ambientEnv(),
): string[] {
  const override = env.AGENT_DEVICE_STATE_DIR?.trim();
  const dirs = new Set([override ? resolve(override) : join(home, '.agent-device')]);
  const workspaces = join(configDir(), 'workspaces');
  try {
    for (const name of readdirSync(workspaces)) {
      const dir = join(workspaces, name, 'agent-device');
      try {
        if (statSync(dir).isDirectory()) dirs.add(dir);
      } catch {}
    }
  } catch {}
  return [...dirs];
}

export async function agentDeviceStateDirsAsync(
  home: string = ambientEnv().HOME || ambientEnv().USERPROFILE || homedir(),
  env: NodeJS.ProcessEnv = ambientEnv(),
): Promise<string[]> {
  const override = env.AGENT_DEVICE_STATE_DIR?.trim();
  const dirs = new Set([override ? resolve(override) : join(home, '.agent-device')]);
  const workspaces = join(configDir(), 'workspaces');
  try {
    for (const name of await readdir(workspaces)) {
      const dir = join(workspaces, name, 'agent-device');
      try {
        if ((await stat(dir)).isDirectory()) dirs.add(dir);
      } catch {}
    }
  } catch {}
  return [...dirs];
}
