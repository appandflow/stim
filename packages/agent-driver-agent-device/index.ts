import type { AgentDriverClient, AgentDriverInput, AgentDriverRecoveryInput } from '@stim-cli/agent-driver';
import { AgentDeviceDriver, stopRecorders } from './driver.ts';

export { AgentDeviceDriver, type AgentDeviceDriverOptions } from './driver.ts';
export { DEVICE_COMMAND_RULES, REFUSED_DEVICE_COMMANDS, type DeviceCommandRule } from './device-policy.ts';

export const id: string = 'agent-device';

export function createAgentDriver(input: AgentDriverInput): AgentDeviceDriver {
  return new AgentDeviceDriver(input);
}

export function recover({ stateDir, host }: AgentDriverRecoveryInput): Promise<void> {
  return stopRecorders(host, stateDir);
}

export const client: AgentDriverClient = {
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
