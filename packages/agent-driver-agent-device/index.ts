import { join } from 'node:path';
import {
  AGENT_DRIVER_API_VERSION,
  type AgentDriverActions,
  type AgentDriverClient,
  type AgentDriverInput,
} from '@stim-cli/agent-driver';
import { createAgentActionReader } from '@stim-cli/core/state';
import { AgentDeviceDriver } from './driver.ts';

export { AgentDeviceDriver, resolveAgentDevice, type AgentDeviceDriverOptions } from './driver.ts';

export const apiVersion: typeof AGENT_DRIVER_API_VERSION = AGENT_DRIVER_API_VERSION;

export const id: string = 'agent-device';

export function createAgentDriver(input: AgentDriverInput): AgentDeviceDriver {
  return new AgentDeviceDriver(input);
}

export const client: AgentDriverClient = {
  configFile: 'agent-device-remote.json',
  access({ grant, baseUrl, file, platform }) {
    if (
      grant.driver !== id ||
      !grant.lease ||
      grant.lease.backend !== (platform === 'macos' ? undefined : `${platform}-instance`)
    )
      return null;
    const config = {
      daemonBaseUrl: baseUrl,
      daemonAuthToken: grant.token,
      tenant: grant.lease.tenant,
      sessionIsolation: 'tenant',
      runId: grant.lease.runId,
      ...(platform === 'macos' ? { leaseId: grant.scope } : {}),
      leaseBackend: platform === 'macos' ? 'macos-app' : `${platform}-instance`,
      leaseProvider: 'proxy',
      clientId: grant.lease.clientId,
      deviceKey: grant.lease.deviceKey,
      platform,
    };
    return {
      config: `${JSON.stringify(config, null, 2)}\n`,
      command: `agent-device <command> --remote-config ${file}`,
    };
  },
};

export const actions: AgentDriverActions = {
  read: ({ workspaceDir }) =>
    createAgentActionReader({ sessionsDirs: [join(workspaceDir, 'agent-device', 'sessions')] })(),
};
