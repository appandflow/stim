import { loadAgentDriverModule, type AgentDriverClient } from '@stim-cli/agent-driver';
import type { HostedAgentDriverName } from '@stim-cli/core/state';

const DRIVERS: Record<Exclude<HostedAgentDriverName, 'none'>, () => Promise<unknown>> = {
  'agent-device': () => import('@stim-cli/agent-driver-agent-device'),
};

function registered(name: string): name is keyof typeof DRIVERS {
  return Object.hasOwn(DRIVERS, name);
}

/** The client side of a first-party driver, or a reason it is unavailable to this Stim. */
export async function agentDriverClient(
  name: string,
): Promise<{ client: AgentDriverClient } | { unavailable: string }> {
  if (!registered(name)) return { unavailable: `this Stim has no ${name} driver` };
  const loaded = await loadAgentDriverModule(name, DRIVERS[name]);
  if ('unavailable' in loaded) return loaded;
  return loaded.module.client ? { client: loaded.module.client } : { unavailable: `the ${name} driver has no client` };
}

/** The config file names every first-party driver's client writes beside a placement. */
export async function agentClientFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const name of Object.keys(DRIVERS)) {
    const loaded = await agentDriverClient(name);
    if ('client' in loaded) files.push(loaded.client.configFile);
  }
  return files;
}
