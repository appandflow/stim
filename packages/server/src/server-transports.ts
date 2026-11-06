import type { Transport } from '@stim-cli/transport';
import {
  isTailscaleTransport,
  tailscaleTransport,
  type TailscaleState,
  type TailscaleTransport,
} from '@stim-cli/transport-tailscale';
import type { ServerOptions } from './handlers/context.ts';

const NO_TAILSCALE: TailscaleState = { state: 'unavailable', reason: 'the tailscale command was not found' };

export function serverTransports(options: ServerOptions): { transports: Transport[]; tailscale: TailscaleTransport } {
  const given = options.transports?.find(isTailscaleTransport);
  const tailscale =
    given ??
    tailscaleTransport({
      env: options.env,
      snapshot: { binary: options.tailscale ?? null, state: options.tailscaleState ?? NO_TAILSCALE },
      monitor: options.tailscaleMonitor ?? null,
    });
  return { transports: options.transports ?? [tailscale], tailscale };
}
