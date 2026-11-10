import { hostname } from 'node:os';
import type { ServeRoute } from '@stim-cli/core/protocol';
import { parseMachine, type Endpoint } from '@stim-cli/core/state';
import { loadTransport } from '@stim-cli/transport';
import { localTransport } from '@stim-cli/transport-local';
import type { TailscaleState, TailscaleTransport } from '@stim-cli/transport-tailscale';

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

const CACHE_MS = 30_000;

/** The Tailscale state and, while it runs with a DNS name, the route to the server's port: what `/health` reports. */
interface TailnetHealth {
  state: TailscaleState;
  route?: ServeRoute;
}

/**
 * The tailnet as stim-server reaches it: the Tailscale transport, loaded only when something asks for the tailnet, and
 * the reads `/health`, the server name and paired machines need meanwhile. Reads made before the transport loads come
 * from one `tailscale status` and one `tailscale serve status` kept for 30 seconds.
 */
export interface Tailnet {
  current(): TailscaleTransport | null;
  /** Calls `listener` with the transport when it loads, at once when it already has. */
  onLoad(listener: (transport: TailscaleTransport) => void): void;
  /**
   * Loads the transport and its monitor for this run, once; null when it cannot load. It never writes the tailnet
   * marker: a deliberate act that should load the transport at every later start calls `markTailnet` itself.
   */
  load(reason: string): Promise<TailscaleTransport | null>;
  health(port: number, timeoutMs: number): Promise<TailnetHealth>;
  rawStatus(): Promise<unknown>;
  binary(): Promise<string | null>;
  /** Tailscale's HostName for this machine while it runs, else the OS host name. */
  hostName(): Promise<string>;
  close(): void;
}

interface CachedRead {
  binary: string | null;
  state: TailscaleState;
  routes: Map<number, Promise<ServeRoute>>;
}

async function loadTailscale(env: NodeJS.ProcessEnv): Promise<TailscaleTransport | string> {
  const loaded = await loadTransport({
    reference: '@stim-cli/transport-tailscale',
    manifest: async () => (await tailscalePackage()).manifest,
    load: tailscalePackage,
    input: { env, options: {} },
  });
  if ('unavailable' in loaded) return `the Tailscale transport is unavailable: ${loaded.unavailable}`;
  if (!(await tailscalePackage()).isTailscaleTransport(loaded.transport)) {
    void loaded.transport.close?.();
    return '@stim-cli/transport-tailscale did not create a Tailscale transport';
  }
  return loaded.transport;
}

/** The tailnet of a server; `given` is a transport the caller already built, which then counts as loaded. */
export function createTailnet(env: NodeJS.ProcessEnv, given: TailscaleTransport | null = null): Tailnet {
  let transport = given;
  let loading: Promise<TailscaleTransport | null> | null = null;
  let closed = false;
  const listeners: ((transport: TailscaleTransport) => void)[] = [];
  let cached: { until: number; read: Promise<CachedRead> } | null = null;
  const read = (): Promise<CachedRead> => {
    if (!cached || cached.until <= Date.now()) {
      const fresh = tailscalePackage().then(async ({ findTailscale, readTailscaleStatus }) => {
        const binary = findTailscale(env);
        return {
          binary,
          state: await readTailscaleStatus(binary, env),
          routes: new Map<number, Promise<ServeRoute>>(),
        };
      });
      cached = { until: Date.now() + CACHE_MS, read: fresh };
    }
    return cached.read;
  };
  const currentState = async () => (transport ? transport.snapshot().state : (await read()).state);
  return {
    current: () => transport,
    onLoad(listener) {
      listeners.push(listener);
      if (transport) listener(transport);
    },
    load(reason) {
      if (transport) return Promise.resolve(transport);
      if (closed) return Promise.resolve(null);
      return (loading ??= (async () => {
        console.log(`stim-server: loading the Tailscale transport (${reason}).`);
        const loaded = await loadTailscale(env);
        if (typeof loaded === 'string') {
          console.error(`stim-server: ${loaded}`);
          loading = null;
          return null;
        }
        if (closed) {
          void loaded.close?.();
          return null;
        }
        transport = loaded;
        for (const listener of listeners) listener(loaded);
        return loaded;
      })());
    },
    async health(port, timeoutMs) {
      if (transport) {
        const { state } = transport.snapshot();
        if (state.state !== 'running' || !state.dnsName) return { state };
        return { state, route: await transport.serveRoute(port, timeoutMs) };
      }
      const current = await read();
      const { state } = current;
      if (state.state !== 'running' || !state.dnsName) return { state };
      let route = current.routes.get(port);
      if (!route) {
        route = tailscalePackage().then(({ serveRoute }) =>
          serveRoute(current.binary, env, port, state.ips, timeoutMs),
        );
        current.routes.set(port, route);
      }
      return { state, route: await route };
    },
    async rawStatus() {
      if (transport) return transport.rawStatus();
      const { findTailscale, readRawTailscaleStatus } = await tailscalePackage();
      return readRawTailscaleStatus(findTailscale(env), env);
    },
    async binary() {
      return transport ? transport.snapshot().binary : (await tailscalePackage()).findTailscale(env);
    },
    async hostName() {
      const current = await currentState();
      return (current.state === 'running' && current.hostName) || hostname();
    },
    close() {
      closed = true;
      if (transport !== given) void transport?.close?.();
    },
  };
}
