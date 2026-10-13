import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentDriverUnavailable,
  loadAgentDriver,
  loadAgentDriverModule,
  type AgentDriverActions,
  type HostedAgentDevice,
  type HostedAgentDriver,
} from '@stim-cli/agent-driver';
import type { HostedAgentDriverName } from '@stim-cli/core/state';

const DRIVERS: Record<Exclude<HostedAgentDriverName, 'none'>, () => Promise<unknown>> = {
  'agent-device': () => import('@stim-cli/agent-driver-agent-device'),
};

const NAMES = Object.keys(DRIVERS) as (keyof typeof DRIVERS)[];

function registered(name: unknown): name is keyof typeof DRIVERS {
  return typeof name === 'string' && Object.hasOwn(DRIVERS, name);
}

/**
 * Creates the driver `hosting.agentDriver` names, with its state and claim under `area`. Resolves null for
 * `none` and rejects with `AgentDriverUnavailable` when the named driver cannot load. A load failure's reason,
 * which can name host paths, goes to stderr; the rejection carries a generic notice for the client.
 */
export async function configuredAgentDriver(
  name: unknown,
  env: NodeJS.ProcessEnv,
  area: string,
  device?: HostedAgentDevice,
): Promise<HostedAgentDriver | null> {
  if (name === undefined || name === 'none') return null;
  if (!registered(name))
    throw new AgentDriverUnavailable(
      `hosting.agentDriver names ${JSON.stringify(name)}, which this stim-server has no driver for.`,
    );
  const loaded = await loadAgentDriver(name, DRIVERS[name], {
    env,
    stateDir: join(area, name),
    claimRoot: join(area, `${name}.claims`),
    ...(device ? { device } : {}),
  });
  if ('unavailable' in loaded) {
    process.stderr.write(`The ${name} agent driver could not load: ${loaded.unavailable}\n`);
    throw new AgentDriverUnavailable(
      `The ${name} agent driver could not load on the hosting Mac. Check its stim-server log.`,
    );
  }
  return loaded.driver;
}

/**
 * The driver whose claim root a stopping hosted device session has, else the configured one when it is
 * registered. A session no registered driver ran for stops without one.
 */
export async function stoppingAgentDriver(
  name: unknown,
  env: NodeJS.ProcessEnv,
  area: string,
  device: HostedAgentDevice,
): Promise<HostedAgentDriver | null> {
  const ran = NAMES.find((driver) => existsSync(join(area, `${driver}.claims`)));
  if (!ran && !registered(name)) return null;
  return configuredAgentDriver(ran ?? name, env, area, device);
}

/** The action readers of every first-party driver that loads; a driver that does not load contributes none. */
export async function agentActionReaders(): Promise<AgentDriverActions[]> {
  const readers: AgentDriverActions[] = [];
  for (const name of NAMES) {
    const loaded = await loadAgentDriverModule(name, DRIVERS[name]);
    if ('module' in loaded && loaded.module.actions) readers.push(loaded.module.actions);
    else if ('unavailable' in loaded)
      process.stderr.write(`The ${name} agent driver could not load: ${loaded.unavailable}\n`);
  }
  return readers;
}
