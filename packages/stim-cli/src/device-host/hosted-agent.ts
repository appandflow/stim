import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseHostedAgentGrant, type DeviceHostMachineCredential, type HostedAgentAccess } from '@stim-cli/core/state';
import { parseMachine } from '../offload/tailnet.ts';
import { agentClientFiles, agentDriverClient } from './agent-drivers.ts';

/** Removes every driver's client file beside `file`, the placement's agent-device config path. */
export async function removeAgentAccess(file: string, keep?: string): Promise<void> {
  for (const name of agentClientFiles()) {
    const path = join(dirname(file), name);
    if (path !== keep) rmSync(path, { force: true });
  }
}

/**
 * Writes the remote config that lets agent-device drive a hosted app and says how to use it. A tailnet machine is
 * reached at its `tailscale serve` route. A local network machine is reached only through `relay`, the loopback port
 * of this workspace's supervisor relay, or not at all when `relay` is the reason there is none.
 */
export async function agentAccess(
  file: string,
  credential: DeviceHostMachineCredential,
  grant: unknown,
  note: (line: string) => void,
  platform: 'macos' | 'ios' | 'android' = 'macos',
  relay:
    | number
    | string = `Agent control of apps hosted on ${credential.machine} over the local network is relayed only for hosted iOS and Android Debug runs.`,
): Promise<HostedAgentAccess> {
  const machine = parseMachine(credential.machine);
  const local = machine?.transport === 'local';
  if (local && typeof relay === 'string') {
    if (grant !== undefined) note(relay);
    await removeAgentAccess(file);
    return { driver: 'none', setting: 'hosting.agentDriver' };
  }
  const parsed = grant === undefined ? null : parseHostedAgentGrant(grant);
  const issued = parsed && 'token' in parsed ? parsed : null;
  const loaded = issued ? await agentDriverClient(issued.driver) : null;
  if ((grant !== undefined && !parsed) || (loaded && 'unavailable' in loaded))
    note(`${credential.machine} offered agent control this Stim does not support.`);
  const port = machine?.port ?? 443;
  const client = loaded && 'client' in loaded ? loaded.client : null;
  const target = client ? join(dirname(file), client.configFile) : file;
  const access =
    client && issued
      ? client.access({
          grant: issued,
          baseUrl: local
            ? `http://127.0.0.1:${relay}${issued.path}`
            : `https://${credential.address}${port === 443 ? '' : `:${port}`}${issued.path}`,
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
