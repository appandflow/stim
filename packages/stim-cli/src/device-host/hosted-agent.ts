import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseHostedAgentGrant, type DeviceHostMachineCredential, type HostedAgentAccess } from '@stim-cli/core/state';
import { parseMachine } from '../offload/tailnet.ts';

export function agentAccess(
  file: string,
  credential: DeviceHostMachineCredential,
  grant: unknown,
  note: (line: string) => void,
  platform: 'macos' | 'ios' = 'macos',
): HostedAgentAccess {
  const parsed = grant === undefined ? null : parseHostedAgentGrant(grant);
  if (grant !== undefined && !parsed) note(`${credential.machine} offered agent control this Stim does not support.`);
  if (!parsed || parsed.driver === 'none' || (parsed.lease.backend === 'ios-instance') !== (platform === 'ios')) {
    rmSync(file, { force: true });
    return { driver: 'none', setting: 'hosting.agentDriver' };
  }
  const port = parseMachine(credential.machine)?.port ?? 443;
  const config = {
    daemonBaseUrl: `https://${credential.dnsName}${port === 443 ? '' : `:${port}`}${parsed.path}`,
    daemonAuthToken: parsed.token,
    tenant: parsed.lease.tenant,
    sessionIsolation: 'tenant',
    runId: parsed.lease.runId,
    ...(platform === 'macos' ? { leaseId: parsed.scope } : {}),
    leaseBackend: platform === 'ios' ? 'ios-instance' : 'macos-app',
    leaseProvider: 'proxy',
    clientId: parsed.lease.clientId,
    deviceKey: parsed.lease.deviceKey,
    platform,
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { driver: 'agent-device', remoteConfig: file, command: `agent-device <command> --remote-config ${file}` };
}
