import type { PluginSource } from '@stim-cli/core/plugin-loader';
import {
  agentClientConfigFile,
  loadAgentDriverModule,
  type AgentDriverClient,
  type AgentDriverInvocation,
} from '@stim-cli/agent-driver';
import type { HostedAgentDriverName } from '@stim-cli/core/state';

const DRIVERS: Record<Exclude<HostedAgentDriverName, 'none'>, PluginSource> = {
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

/** The client side of a first-party driver, or a reason it is unavailable to this Stim. */
export async function agentDriverClient(
  name: string,
): Promise<{ client: AgentDriverClient } | { unavailable: string }> {
  if (!registered(name)) return { unavailable: `this Stim has no ${name} driver` };
  const loaded = await loadAgentDriverModule(name, DRIVERS[name]);
  if ('unavailable' in loaded) return loaded;
  const { client } = loaded.module;
  return client ? { client } : { unavailable: `the ${name} driver has no client` };
}

/** How the first-party driver `name` runs its tool on this machine. Throws why it cannot. */
export async function agentDriverInvocation(name: string, env: NodeJS.ProcessEnv): Promise<AgentDriverInvocation> {
  if (!registered(name)) throw new Error(`this Stim has no ${name} driver`);
  const loaded = await loadAgentDriverModule(name, DRIVERS[name]);
  if ('unavailable' in loaded) throw new Error(loaded.unavailable);
  if (!loaded.module.invocation) throw new Error(`the ${name} driver has no invocation`);
  return loaded.module.invocation(env);
}

/**
 * The config file names every first-party driver's client writes beside a placement. They are derived from the
 * driver ids, so access is removed even when a driver package does not load.
 */
export function agentClientFiles(): string[] {
  return Object.keys(DRIVERS).map(agentClientConfigFile);
}
