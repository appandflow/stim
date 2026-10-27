import { isJsonObject } from './json-file.ts';

const DEFAULT_SERVE_PORT = 7443;
/** stim-server's own port, which a machine on the local network connects to directly. */
export const DEFAULT_SERVER_PORT = 7787;
const LOCAL_PREFIX = 'local:';

/**
 * A `remote.machines` entry: a tailnet name, or `local:` and a host name or IPv4 address on the local network, each
 * optionally with `:<port>`.
 */
export const TAILNET_MACHINE_PATTERN: string =
  '^(?:local:)?[A-Za-z0-9][A-Za-z0-9.-]*(?::(?!0+$)(?:[0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$';

export interface TailnetPeer {
  nodeId: string;
  dnsName: string;
  /** A tailnet address of the node; WireGuard delivers packets to it only from that node. */
  address: string;
  /** Tailscale's `OS` for the node, such as `macOS` or `linux`; absent when the status does not report it. */
  os?: string;
  /** Tailscale's `Online` for the node: whether the control plane sees it connected. Absent when not reported. */
  online?: boolean;
  /** When Tailscale last saw the node, as an ISO timestamp; absent when it never did or the status omits it. */
  lastSeen?: string;
}

function peerPresence(peer: Record<string, unknown>): Pick<TailnetPeer, 'online' | 'lastSeen'> {
  const lastSeen = typeof peer.LastSeen === 'string' ? peer.LastSeen : '';
  return {
    ...(typeof peer.Online === 'boolean' ? { online: peer.Online } : {}),
    ...(lastSeen && Date.parse(lastSeen) > 0 ? { lastSeen } : {}),
  };
}

/**
 * The environment to run the Tailscale CLI with. The macOS Tailscale.app CLI prints "The Tailscale GUI failed to start"
 * instead of its output when `TERM` is unset, as under launchd (https://github.com/appandflow/stim/issues/4500).
 */
export function tailscaleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.TERM ? env : { ...env, TERM: 'dumb' };
}

export type MachineTransport = 'tailscale' | 'local';

/**
 * A `remote.machines` entry's parts. A `tailscale` entry names a tailnet peer and the port of its `tailscale serve`
 * route; a `local` entry names a host on the local network and stim-server's own port there.
 */
export function parseMachine(entry: string): { transport: MachineTransport; name: string; port: number } | null {
  const trimmed = entry.trim();
  if (!new RegExp(TAILNET_MACHINE_PATTERN).test(trimmed)) return null;
  const local = trimmed.startsWith(LOCAL_PREFIX);
  const [name, port] = (local ? trimmed.slice(LOCAL_PREFIX.length) : trimmed).split(':');
  return {
    transport: local ? 'local' : 'tailscale',
    name: name!.toLowerCase(),
    port: port !== undefined ? Number(port) : local ? DEFAULT_SERVER_PORT : DEFAULT_SERVE_PORT,
  };
}

/**
 * The one peer in `tailscale status --json` whose MagicDNS name is `name` or starts with `name.`. `ID` there is
 * the node's StableID, the same value `tailscale whois` reports as `Node.StableID`.
 */
export function findPeer(status: unknown, name: string): TailnetPeer | 'missing' | 'ambiguous' {
  const peers = isJsonObject(status) && isJsonObject(status.Peer) ? Object.values(status.Peer) : [];
  const found = peers.flatMap((peer) => {
    if (!isJsonObject(peer) || typeof peer.ID !== 'string' || typeof peer.DNSName !== 'string') return [];
    const dnsName = peer.DNSName.replace(/\.$/, '').toLowerCase();
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
    const address = addresses.find((ip) => !ip.includes(':')) ?? addresses[0];
    if (!address || !(dnsName === name || dnsName.startsWith(`${name}.`))) return [];
    return [
      {
        nodeId: peer.ID,
        dnsName,
        address,
        ...(typeof peer.OS === 'string' && peer.OS ? { os: peer.OS } : {}),
        ...peerPresence(peer),
      },
    ];
  });
  if (found.length === 0) return 'missing';
  return found.length === 1 ? found[0]! : 'ambiguous';
}

/**
 * Whether `tailscale status` reports the peer a `remote.machines` entry names as running an OS other than macOS.
 * Such a machine can build but never host simulators or emulators; an unknown OS counts as able to host.
 */
export function cannotHost(status: unknown, entry: string): boolean {
  const parsed = parseMachine(entry);
  const peer = parsed?.transport === 'tailscale' ? findPeer(status, parsed.name) : 'missing';
  return typeof peer === 'object' && peer.os !== undefined && peer.os !== 'macOS';
}

export interface Endpoint {
  url: string;
  servername: string;
  host: string;
}

/**
 * Connects to the node's own tailnet address from `tailscale status`. `tailscale serve` still needs the MagicDNS name
 * for TLS (SNI and certificate) and for its Host routing.
 */
export function endpoint(peer: TailnetPeer, port: number): Endpoint {
  const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address;
  const suffix = port === 443 ? '' : `:${port}`;
  return {
    url: `wss://${address}${suffix}`,
    servername: peer.dnsName,
    host: `${peer.dnsName}${suffix}`,
  };
}

/**
 * A `local` entry's stim-server, reached directly with plain WebSocket: protocol 2's Noise session authenticates and
 * encrypts it, so it needs no TLS.
 */
export function localEndpoint(name: string, port: number): Endpoint {
  return {
    url: `ws://${name}:${port}`,
    servername: name,
    host: `${name}:${port}`,
  };
}

/**
 * Where to reach a `remote.machines` entry now, or why Stim cannot. The tailnet or local network only carries the
 * bytes: the Noise handshake, pinned to the worker's server key, decides whether the machine answering is the one this
 * machine paired with. `current` is `tailscale status --json`, which a `local` entry does not need.
 */
export function machineEndpoint(machine: string, current: unknown): Endpoint | string {
  const parsed = parseMachine(machine);
  if (!parsed) return `${machine} is not a tailnet name or local: address`;
  if (parsed.transport === 'local') return localEndpoint(parsed.name, parsed.port);
  if (!isJsonObject(current)) return 'Tailscale is not running';
  const peer = findPeer(current, parsed.name);
  if (peer === 'missing') return `no peer on this tailnet is named ${parsed.name}`;
  if (peer === 'ambiguous') return `several tailnet peers match ${parsed.name}`;
  return endpoint(peer, parsed.port);
}
