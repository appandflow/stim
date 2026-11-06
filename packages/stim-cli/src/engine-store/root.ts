import { homedir } from 'node:os';
import { join } from 'node:path';

/** The engine store: `STIM_ENGINE_ROOT` (absolute; the CLI refuses a relative one), else `~/.stim/engine`. */
export function engineRoot(env: NodeJS.ProcessEnv): string {
  return env.STIM_ENGINE_ROOT || join(homedir(), '.stim', 'engine');
}
