import { validHomeId } from '../workspace-link.ts';
import { configCorruptRepair, loadConfig } from './config.ts';
import type { Config } from './config-types.ts';

/** The persistent, nonsecret identity of this Stim home; null until the CLI initializes it. */
export function readHomeIdentity(config: Config | null = loadConfig()): string | null {
  const id = config?.homeId;
  if (id === undefined) return null;
  if (!validHomeId(id))
    throw Object.assign(new Error(`Stim home identity is not a UUID. ${configCorruptRepair()}`), {
      code: 'STIM_CONFIG_CORRUPT',
    });
  return id.toLowerCase();
}
