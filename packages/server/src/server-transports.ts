import type { Transport } from '@stim-cli/transport';
import type { ServerOptions } from './handlers/context.ts';
import { createTailnet, tailscalePackage, type Tailnet } from './tailnet-helper.ts';

/**
 * The transports a server starts with, and its tailnet. With `options.tailnet` the Tailscale transport joins the list
 * only once something loads it; otherwise the server builds it now from `tailscale`, `tailscaleState` and
 * `tailscaleMonitor`, or takes the one `transports` holds.
 */
export async function serverTransports(options: ServerOptions): Promise<{ transports: Transport[]; tailnet: Tailnet }> {
  if (options.tailnet) return { transports: [...(options.transports ?? [])], tailnet: options.tailnet };
  const { isTailscaleTransport, tailscaleTransport } = await tailscalePackage();
  const given = options.transports?.find(isTailscaleTransport);
  const tailscale =
    given ??
    tailscaleTransport({
      env: options.env,
      snapshot: {
        binary: options.tailscale ?? null,
        state: options.tailscaleState ?? { state: 'unavailable', reason: 'the tailscale command was not found' },
      },
      monitor: options.tailscaleMonitor ?? null,
    });
  return { transports: options.transports ?? [tailscale], tailnet: createTailnet(options.env, tailscale) };
}
