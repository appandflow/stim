import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  findPeer,
  isJsonObject,
  parseMachine,
  HOSTED_METRO_REQUESTS_KEY,
  hostedMetroRequests,
  hostedMetroGateways,
  type DeviceHostMachineCredential,
  type HostedMetroRequest,
} from '@stim-cli/core/state';
import { inspectProcessIdentity } from '../process-identity.ts';
import { realIo } from '../offload/tailnet.ts';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

export function gatewayAddresses(
  credential: DeviceHostMachineCredential,
  status: unknown,
): { address: string; peer: string } {
  const machine = parseMachine(credential.machine);
  const peer = machine ? findPeer(status, machine.name) : 'missing';
  if (typeof peer === 'string' || peer.nodeId !== credential.nodeId) {
    throw new Error(`${credential.machine} no longer resolves to its pinned tailnet node. Run stim doctor.`);
  }
  const self = isJsonObject(status) && isJsonObject(status.Self) ? status.Self : null;
  const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
  const address = ips.find(
    (ip): ip is string => typeof ip === 'string' && isIP(ip) === isIP(peer.address) && isIP(ip) !== 0,
  );
  if (!address) throw new Error('This Mac has no Tailscale address compatible with the hosting Mac.');
  return { address, peer: peer.address };
}

export function requireHostedMetro(root: string): void {
  const supervisor = readWorkspaceState(root)?.supervisor;
  if (supervisor?.hostedMetro === true && inspectProcessIdentity(supervisor) === 'same') return;
  throw Object.assign(
    new Error(
      'Hosted Debug runs require a running Metro supervisor with private gateway support. Run stim stop; stim start, then retry.',
    ),
    { code: 'STIM_HOSTING_REFUSED', remedy: 'Run stim stop; stim start, then retry.' },
  );
}

export async function requestHostedMetro(
  root: string,
  session: string,
  credential: DeviceHostMachineCredential,
): Promise<{ gatewayPort: number; secret: string }> {
  requireHostedMetro(root);
  const addresses = gatewayAddresses(credential, realIo.status());
  const previous = hostedMetroRequests(readWorkspaceState(root))[session];
  const request: HostedMetroRequest =
    previous && previous.address === addresses.address && previous.peer === addresses.peer
      ? previous
      : { id: randomUUID(), machine: credential.machine, ...addresses, secret: randomBytes(32).toString('hex') };
  updateWorkspaceState(root, (state) => ({
    ...state,
    [HOSTED_METRO_REQUESTS_KEY]: { ...hostedMetroRequests(state), [session]: request },
  }));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = readWorkspaceState(root);
    const gateway = hostedMetroGateways(state)[session];
    if (gateway?.id === request.id && gateway.processToken === state?.supervisor?.processToken) {
      if (gateway.error) throw new Error(gateway.error);
      if (gateway.port) return { gatewayPort: gateway.port, secret: request.secret };
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `The Metro supervisor did not open a private gateway for ${credential.machine}. Run stim stop; stim start, then retry.`,
  );
}

export function clearHostedMetro(root: string, session: string): void {
  updateWorkspaceState(root, (state) => {
    const requests = { ...hostedMetroRequests(state) };
    delete requests[session];
    return { ...state, [HOSTED_METRO_REQUESTS_KEY]: requests };
  });
}

export async function closeHostedMetro(root: string, session: string): Promise<void> {
  clearHostedMetro(root, session);
  const deadline = Date.now() + 5000;
  while (true) {
    const state = readWorkspaceState(root);
    const gateway = hostedMetroGateways(state)[session];
    const supervisor = state?.supervisor;
    if (!gateway?.port || !supervisor || gateway.processToken !== supervisor.processToken) return;
    if (inspectProcessIdentity(supervisor) === 'gone') return;
    if (Date.now() >= deadline)
      throw new Error('The Metro supervisor did not close its private gateway. Restart Metro, then retry stim stop.');
    await new Promise((done) => setTimeout(done, 100));
  }
}
