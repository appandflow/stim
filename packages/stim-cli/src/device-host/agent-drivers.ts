import type { PluginSource } from '@stim-cli/core/plugin-loader';
import { agentClientConfigFile, loadAgentDriverModule, type AgentDriverClient } from '@stim-cli/agent-driver';
import type { BuiltinAgentDriver } from '@stim-cli/core/state';

const DRIVERS: Record<BuiltinAgentDriver, PluginSource> = {
  'agent-device': {
    load: () => import('@stim-cli/agent-driver-agent-device'),
    manifest: () =>
      import('@stim-cli/agent-driver-agent-device/package.json', { with: { type: 'json' } }).then(
        (manifest) => manifest.default,
      ),
  },
};

function registered(name: string): name is keyof typeof DRIVERS {
  return Object.hasOwn(DRIVERS, name);
}

/**
 * The client side of a first-party driver; `unavailable` when this Stim has no client for it, `failed` with the
 * reason when its driver module does not load.
 */
export async function agentDriverClient(
  name: string,
): Promise<{ client: AgentDriverClient } | { unavailable: string } | { failed: string }> {
  if (!registered(name)) return { unavailable: `this Stim has no ${name} driver` };
  const loaded = await loadAgentDriverModule(name, DRIVERS[name]);
  if ('unavailable' in loaded) return { failed: loaded.unavailable };
  const { client } = loaded.module;
  return client ? { client } : { unavailable: `the ${name} driver has no client` };
}

/**
 * The config file names every first-party driver's client writes beside a placement. They are derived from the
 * driver ids, so access is removed even when a driver package does not load.
 */
export function agentClientFiles(): string[] {
  return Object.keys(DRIVERS).map(agentClientConfigFile);
}
