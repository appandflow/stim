import { loadAgentDriverModule, type AgentDriverClient } from '@stim-cli/agent-driver';
import type { HostedAgentDriverName } from '@stim-cli/core/state';

const DRIVERS: Record<Exclude<HostedAgentDriverName, 'none'>, { load: () => Promise<unknown>; configFile: string }> = {
  'agent-device': { load: () => import('@stim-cli/agent-driver-agent-device'), configFile: 'agent-device-remote.json' },
};

function registered(name: string): name is keyof typeof DRIVERS {
  return Object.hasOwn(DRIVERS, name);
}

/** The client side of a first-party driver, or a reason it is unavailable to this Stim. */
export async function agentDriverClient(
  name: string,
): Promise<{ client: AgentDriverClient } | { unavailable: string }> {
  if (!registered(name)) return { unavailable: `this Stim has no ${name} driver` };
  const { load, configFile } = DRIVERS[name];
  const loaded = await loadAgentDriverModule(name, load);
  if ('unavailable' in loaded) return loaded;
  const { client } = loaded.module;
  if (!client) return { unavailable: `the ${name} driver has no client` };
  if (client.configFile !== configFile) {
    return { unavailable: `the ${name} driver writes ${client.configFile}, not ${configFile}` };
  }
  return { client };
}

/**
 * The config file names every first-party driver's client writes beside a placement. They are listed here rather
 * than read from the drivers, so access is removed even when a driver package does not load.
 */
export function agentClientFiles(): string[] {
  return Object.values(DRIVERS).map((driver) => driver.configFile);
}
