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
  type SettingsObject,
} from '@stim-cli/core/state';
import { inspectProcessIdentity } from '../process-identity.ts';
import { tailscaleStatusAsync } from '../offload/tailnet.ts';
import {
  readWorkspaceState,
  updateWorkspaceState,
  updateWorkspaceStateAsync,
  withWorkspaceStateLockAsync,
} from '../workspace/workspace-state.ts';
import { cancelledError, throwIfCancelled } from '../cancellation.ts';
import { watchWorkspaceState } from '../workspace/workspace-state-watch.ts';

async function waitForGateway<T>(
  root: string,
  read: () => T | null,
  { waitMs, signal, what }: { waitMs: number; signal?: AbortSignal; what: string },
): Promise<T | null> {
  throwIfCancelled(signal, what);
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let observer: ReturnType<typeof watchWorkspaceState> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued: ReturnType<typeof setImmediate> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const check = () => {
        clearImmediate(queued);
        queued = undefined;
        clearTimeout(timer);
        try {
          throwIfCancelled(signal, what);
          observer?.refresh();
          const result = read();
          const remaining = deadline - Date.now();
          if (result !== null || remaining <= 0) resolve(result);
          else {
            // macOS fs.watch exposes no ready event: https://github.com/nodejs/node/issues/52601
            const repairMs = Date.now() - startedAt < 500 ? 100 : 1000;
            timer = setTimeout(check, Math.min(remaining, repairMs));
          }
        } catch (error) {
          reject(error);
        }
      };
      onAbort = () => reject(cancelledError(what));
      signal?.addEventListener('abort', onAbort, { once: true });
      observer = watchWorkspaceState(root, () => {
        queued ??= setImmediate(check);
      });
      check();
    });
  } finally {
    observer?.close();
    clearTimeout(timer);
    clearImmediate(queued);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export function gatewayAddresses(
  credential: DeviceHostMachineCredential,
  status: unknown,
): { address: string; peer: string } {
  const machine = parseMachine(credential.machine);
  const peer = machine ? findPeer(status, machine.name) : 'missing';
  if (typeof peer === 'string') {
    throw new Error(`${credential.machine} no longer resolves to one tailnet peer. Run stim doctor.`);
  }
  const self = isJsonObject(status) && isJsonObject(status.Self) ? status.Self : null;
  const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
  const address = ips.find(
    (ip): ip is string => typeof ip === 'string' && isIP(ip) === isIP(peer.address) && isIP(ip) !== 0,
  );
  if (!address) throw new Error('This machine has no Tailscale address compatible with the hosting Mac.');
  return { address, peer: peer.address };
}

/**
 * A hosted Debug run needs the hosting machine to reach this machine's Metro, which today goes through a gateway on
 * this machine's tailnet address that trusts WireGuard source addresses. A `local:` machine has no such address.
 */
export function requireTailnetMetro(machine: string): void {
  if (parseMachine(machine)?.transport !== 'local') return;
  throw Object.assign(
    new Error(
      `${machine} is on the local network, and hosted Debug runs there cannot reach this machine's Metro yet: the hosting machine's connection to Metro needs a tailnet address.`,
    ),
    {
      code: 'STIM_HOSTING_REFUSED',
      remedy:
        'Run a Release configuration or variant there, run Debug on a remote.machines entry on the tailnet, or run it on this machine.',
    },
  );
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
  signal?: AbortSignal,
): Promise<{ gatewayPort: number; secret: string }> {
  throwIfCancelled(signal, 'hosted Metro gateway');
  requireTailnetMetro(credential.machine);
  requireHostedMetro(root);
  const addresses = gatewayAddresses(credential, await tailscaleStatusAsync(signal));
  throwIfCancelled(signal, 'hosted Metro gateway');
  requireHostedMetro(root);
  const previous = hostedMetroRequests(readWorkspaceState(root))[session];
  const request: HostedMetroRequest =
    previous && previous.address === addresses.address && previous.peer === addresses.peer
      ? previous
      : { id: randomUUID(), machine: credential.machine, ...addresses, secret: randomBytes(32).toString('hex') };
  await updateWorkspaceStateAsync(
    root,
    (state) => ({
      ...state,
      [HOSTED_METRO_REQUESTS_KEY]: { ...hostedMetroRequests(state), [session]: request },
    }),
    signal,
  );
  const opened = await waitForGateway(
    root,
    () => {
      const state = readWorkspaceState(root);
      const gateway = hostedMetroGateways(state)[session];
      if (gateway?.id === request.id && gateway.processToken === state?.supervisor?.processToken) {
        if (gateway.error) throw new Error(gateway.error);
        if (gateway.port) return { gatewayPort: gateway.port, secret: request.secret };
      }
      return null;
    },
    { waitMs: 15_000, signal, what: 'hosted Metro gateway' },
  );
  if (opened) return opened;
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

export async function closeHostedMetro(root: string, session: string, signal?: AbortSignal): Promise<void> {
  await withWorkspaceStateLockAsync(root, () => clearHostedMetro(root, session), signal);
  const closed = await waitForGateway(
    root,
    () => {
      const state = readWorkspaceState(root);
      const gateway = hostedMetroGateways(state)[session];
      const supervisor = state?.supervisor;
      if (!gateway?.port || !supervisor || gateway.processToken !== supervisor.processToken) return true;
      return inspectProcessIdentity(supervisor) === 'gone' ? true : null;
    },
    { waitMs: 5000, signal, what: 'close hosted Metro' },
  );
  if (!closed)
    throw new Error('The Metro supervisor did not close its private gateway. Restart Metro, then retry stim stop.');
}

export function hostedMetroSettings(settings: SettingsObject, hosted: boolean): SettingsObject {
  return hosted
    ? {
        ...settings,
        ios: { ...(isJsonObject(settings.ios) ? settings.ios : {}), remote: undefined },
        android: { ...(isJsonObject(settings.android) ? settings.android : {}), remote: undefined },
        metro: {
          ...(isJsonObject(settings.metro) ? settings.metro : {}),
          tunnel: undefined,
          publicUrl: undefined,
          ngrokUrl: undefined,
        },
      }
    : settings;
}
