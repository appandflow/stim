import { parseMachine, type Endpoint } from '@stim-cli/core/state';
import { localTransport } from '@stim-cli/transport-local';

/** The Tailscale transport package, loaded only when something on this machine needs the tailnet. */
export const tailscalePackage = (): Promise<typeof import('@stim-cli/transport-tailscale')> =>
  import('@stim-cli/transport-tailscale');

/**
 * Where to dial a paired machine, resolved by the transport that carries it. `status` reads `tailscale status --json`
 * for a tailnet machine; resolving loads no listener and no monitor.
 */
export async function dialEndpoint(
  machine: string,
  status: () => unknown | Promise<unknown>,
): Promise<Endpoint | string> {
  const parsed = parseMachine(machine);
  if (!parsed) return `${machine} is not a tailnet name or local: address`;
  const transport =
    parsed.transport === 'local'
      ? localTransport({ entries: () => [] })
      : (await tailscalePackage()).tailscaleTransport({
          env: {},
          snapshot: { binary: null, state: { state: 'unavailable', reason: 'status is read by the caller' } },
          status,
        });
  const found = await transport.resolve({ name: `${parsed.name}:${parsed.port}`, credential: { machine } });
  return 'unresolved' in found ? found.unresolved : found;
}
