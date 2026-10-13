import type { ServeRoute } from '@stim-cli/core/protocol';
import { isIP } from 'node:net';
import { TRANSPORT_API_VERSION, type Transport, type TransportInput } from '@stim-cli/transport';
import {
  findTailscale,
  readRawTailscaleStatus,
  readTailscaleStatus,
  serveRoute,
  setupServeRoute,
  whois,
} from './src/tailscale.ts';
import { watchTailscale, type TailscaleMonitor, type TailscaleSnapshot } from './src/tailscale-monitor.ts';

export { planServe, type ServeRecord } from './src/serve-plan.ts';
export {
  findTailscale,
  readRawTailscaleStatus,
  readTailscaleStatus,
  serveCommand,
  serveRoute,
  tailnetEndpoint,
  tailscaleInstall,
  type TailnetIdentity,
  type TailscaleInstall,
  type TailscaleState,
} from './src/tailscale.ts';
export { watchTailscale, type TailscaleMonitor, type TailscaleSnapshot } from './src/tailscale-monitor.ts';

export const apiVersion: typeof TRANSPORT_API_VERSION = TRANSPORT_API_VERSION;
export const id = 'tailscale';

/**
 * The Tailscale transport, plus what stim-server still reads from Tailscale directly: the snapshot behind the
 * `tailscale` and `route` fields of `/health`, the raw status that pins paired machines, and `route.setup`.
 */
export interface TailscaleTransport extends Transport {
  id: typeof id;
  snapshot(): TailscaleSnapshot;
  monitor: TailscaleMonitor | null;
  rawStatus(): Promise<unknown>;
  serveRoute(target: number, timeoutMs?: number): Promise<ServeRoute>;
  setupRoute(target: number): Promise<ServeRoute>;
}

export function isTailscaleTransport(transport: Transport): transport is TailscaleTransport {
  return transport.id === id && 'snapshot' in transport && typeof transport.snapshot === 'function';
}

export function tailscaleTransport({
  env,
  snapshot,
  monitor = null,
}: {
  env: NodeJS.ProcessEnv;
  snapshot: TailscaleSnapshot;
  monitor?: TailscaleMonitor | null;
}): TailscaleTransport {
  const now = () => monitor?.current() ?? snapshot;
  return {
    id,
    traits: { privateNetwork: true, tls: 'end-to-end', peerIdentity: true },
    monitor,
    snapshot: now,
    ...(monitor && {
      bindAddresses() {
        const { state } = monitor.current();
        return state.state === 'running' ? state.ips : [];
      },
      watch: (listener: () => void) => monitor.onChange(() => listener()),
    }),
    async identify({ address }) {
      if (!isIP(address)) return null;
      const identity = await whois(now().binary, env, address);
      return identity && { id: identity.nodeId, name: identity.nodeName, user: identity.user };
    },
    rawStatus: () => readRawTailscaleStatus(now().binary, env),
    serveRoute(target, timeoutMs) {
      const { binary, state } = now();
      return serveRoute(binary, env, target, state.state === 'running' ? state.ips : [], timeoutMs);
    },
    setupRoute(target) {
      const { binary, state } = now();
      return setupServeRoute(binary, env, target, state);
    },
    close: () => monitor?.stop(),
  };
}

export async function createTransport({ env }: TransportInput): Promise<TailscaleTransport> {
  const binary = findTailscale(env);
  const state = await readTailscaleStatus(binary, env);
  const monitor = watchTailscale({ env, initial: { binary, state } });
  return tailscaleTransport({ env, snapshot: { binary, state }, monitor });
}
