import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseHostedAgentGrant, type DeviceHostMachineCredential, type HostedAgentAccess } from '@stim-cli/core/state';
import { parseMachine } from '../offload/tailnet.ts';
import { agentClientFiles, agentDriverClient } from './agent-drivers.ts';

/** Removes every driver's client file beside `file`, the placement's agent-device config path. */
export async function removeAgentAccess(file: string, keep?: string): Promise<void> {
  for (const name of await agentClientFiles()) {
    const path = join(dirname(file), name);
    if (path !== keep) rmSync(path, { force: true });
  }
}

export async function agentAccess(
  file: string,
  credential: DeviceHostMachineCredential,
  grant: unknown,
  note: (line: string) => void,
  platform: 'macos' | 'ios' | 'android' = 'macos',
): Promise<HostedAgentAccess> {
  const parsed = grant === undefined ? null : parseHostedAgentGrant(grant);
  const issued = parsed && 'token' in parsed ? parsed : null;
  const loaded = issued ? await agentDriverClient(issued.driver) : null;
  if ((grant !== undefined && !parsed) || (loaded && 'unavailable' in loaded))
    note(`${credential.machine} offered agent control this Stim does not support.`);
  const port = parseMachine(credential.machine)?.port ?? 443;
  const client = loaded && 'client' in loaded ? loaded.client : null;
  const target = client ? join(dirname(file), client.configFile) : file;
  const access =
    client && issued
      ? client.access({
          grant: issued,
          baseUrl: `https://${credential.dnsName}${port === 443 ? '' : `:${port}`}${issued.path}`,
          file: target,
          platform,
        })
      : null;
  if (!issued || !access) {
    await removeAgentAccess(file);
    return { driver: 'none', setting: 'hosting.agentDriver' };
  }
  await removeAgentAccess(file, target);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, access.config, { mode: 0o600 });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { driver: issued.driver, remoteConfig: target, command: access.command };
}
