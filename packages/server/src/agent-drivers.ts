import type { PluginSource } from '@stim-cli/core/plugin-loader';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentDriverUnavailable,
  createAgentDriverHost,
  loadAgentDriver,
  loadAgentDriverModule,
  type AgentDriverHost,
  type HostedAgentDevice,
  type HostedAgentDriver,
} from '@stim-cli/agent-driver';
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

function driverHost(dirs: { stateDir: string; claimRoot: string }): AgentDriverHost {
  const { claims, processes } = createAgentDriverHost(dirs);
  return { claims, processes };
}

const NAMES = Object.keys(DRIVERS) as (keyof typeof DRIVERS)[];

function registered(name: unknown): name is keyof typeof DRIVERS {
  return typeof name === 'string' && Object.hasOwn(DRIVERS, name);
}

/**
 * Creates the driver `hosting.agentDriver` names, with its state and claim under `area`. Resolves null for
 * `none` and rejects with `agent-driver-unavailable` when the named driver cannot load. A load failure's reason,
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
    throw agentDriverUnavailable(
      `hosting.agentDriver names ${JSON.stringify(name)}, which this stim-server has no driver for.`,
    );
  const dirs = { stateDir: join(area, name), claimRoot: join(area, `${name}.claims`) };
  const loaded = await loadAgentDriver(name, DRIVERS[name], {
    env,
    ...dirs,
    ...(device ? { device } : {}),
    host: driverHost(dirs),
  });
  if ('unavailable' in loaded) {
    process.stderr.write(`The ${name} agent driver could not load: ${loaded.unavailable}\n`);
    throw agentDriverUnavailable(
      `The ${name} agent driver did not load on the hosting Mac, so agent control is off there. Its server log has the reason; update or reinstall Stim on that Mac.`,
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

/**
 * Runs each first-party driver's `recover` for every area that holds its state. Never rejects; what a driver could
 * not resolve goes to stderr.
 */
export async function recoverAgentDrivers(env: NodeJS.ProcessEnv, areas: string[]): Promise<void> {
  for (const name of NAMES) {
    const loaded = await loadAgentDriverModule(name, DRIVERS[name]);
    if (!('module' in loaded) || !loaded.module.recover) continue;
    for (const area of areas) {
      if (!existsSync(join(area, name))) continue;
      try {
        const dirs = { stateDir: join(area, name), claimRoot: join(area, `${name}.claims`) };
        await loaded.module.recover({ env, ...dirs, host: driverHost(dirs) });
      } catch (error) {
        process.stderr.write(
          `The ${name} agent driver could not recover ${area}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
}
