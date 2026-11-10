import type { ServeRoute } from '@stim-cli/core/protocol';
import { peerEndpoint } from '@stim-cli/core/state';
import { isIP } from 'node:net';
import type { Transport, TransportInput, TransportWatchEvent } from '@stim-cli/transport';
import {
  findTailscale,
  readRawTailscaleStatus,
  readTailscaleStatus,
  serveRoute,
  setupServeRoute,
  whois,
} from './src/tailscale.ts';
import { watchTailscale, type TailscaleMonitor, type TailscaleSnapshot } from './src/tailscale-monitor.ts';

export {
  addFunnelRoute,
  freeFunnelPort,
  funnelPorts,
  holdsFunnelRoute,
  readServeConfig,
  removeFunnelRoute,
  type FunnelRoute,
} from './src/funnel.ts';
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
  resolve: NonNullable<Transport['resolve']>;
  serveRoute(target: number, timeoutMs?: number): Promise<ServeRoute>;
  setupRoute(target: number): Promise<ServeRoute>;
}

export function isTailscaleTransport(transport: Transport): transport is TailscaleTransport {
  return transport.id === id && 'snapshot' in transport && typeof transport.snapshot === 'function';
}

function runningAddresses({ state }: TailscaleSnapshot): string[] {
  return state.state === 'running' ? state.ips : [];
}

export function tailscaleTransport({
  env,
  snapshot,
  monitor = null,
  status,
}: {
  env: NodeJS.ProcessEnv;
  snapshot: TailscaleSnapshot;
  monitor?: TailscaleMonitor | null;
  /** Reads the running `tailscale status --json`, or null; defaults to this transport's own `tailscale` call. */
  status?: () => unknown;
}): TailscaleTransport {
  const now = () => monitor?.current() ?? snapshot;
  const rawStatus = async () => (status ? status() : readRawTailscaleStatus(now().binary, env));
  return {
    id,
    monitor,
    snapshot: now,
    ...(monitor && {
      bindAddresses: () => runningAddresses(monitor.current()),
      watch: (listener: (event: TransportWatchEvent) => void) =>
        monitor.onChange((current) => listener({ addresses: runningAddresses(current) })),
    }),
    async identify({ address }) {
      if (!isIP(address)) return null;
      const identity = await whois(now().binary, env, address);
      return identity && { id: identity.nodeId, name: identity.nodeName, user: identity.user };
    },
    rawStatus,
    async resolve({ name }) {
      const [peer = '', port = ''] = name.split(':');
      if (!peer || !/^\d{1,5}$/.test(port)) return { unresolved: `${name} is not a peer name and port` };
      const found = peerEndpoint(peer, Number(port), await rawStatus());
      return typeof found === 'string' ? { unresolved: found } : found;
    },
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
