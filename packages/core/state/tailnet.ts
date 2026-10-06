import { isJsonObject } from './json-file.ts';

const DEFAULT_SERVE_PORT = 7443;

export const TAILNET_MACHINE_PATTERN: string =
  '^[A-Za-z0-9][A-Za-z0-9.-]*(?::(?!0+$)(?:[0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$';

export interface TailnetPeer {
  nodeId: string;
  dnsName: string;
  /** A tailnet address of the node; WireGuard delivers packets to it only from that node. */
  address: string;
}

export function parseMachine(entry: string): { name: string; port: number } | null {
  if (!new RegExp(TAILNET_MACHINE_PATTERN).test(entry.trim())) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*?)(?::(\d{1,5}))?$/.exec(entry.trim());
  if (!match) return null;
  const port = match[2] === undefined ? DEFAULT_SERVE_PORT : Number(match[2]);
  return port >= 1 && port <= 65535 ? { name: match[1]!.toLowerCase(), port } : null;
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
    return [{ nodeId: peer.ID, dnsName, address }];
  });
  if (found.length === 0) return 'missing';
  return found.length === 1 ? found[0]! : 'ambiguous';
}

export interface Endpoint {
  url: string;
  servername: string;
  host: string;
}

/**
 * Connects to the pinned node's own tailnet address rather than resolving its name, so the socket reaches the
 * node whose ID was just checked. `tailscale serve` still needs the MagicDNS name for TLS (SNI and certificate)
 * and for its Host routing.
 */
export function endpoint(peer: TailnetPeer, port: number): Endpoint {
  const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address;
  const suffix = port === 443 ? '' : `:${port}`;
  return { url: `wss://${address}${suffix}`, servername: peer.dnsName, host: `${peer.dnsName}${suffix}` };
}

/**
 * The endpoint of a paired machine's pinned node, or why Stim does not connect to it. The name must still
 * resolve to exactly the pinned node; the token is never sent anywhere else.
 */
export function pinnedEndpoint(credential: { machine: string; nodeId: string }, current: unknown): Endpoint | string {
  const parsed = parseMachine(credential.machine);
  if (!parsed) return `${credential.machine} is not a tailnet name`;
  if (!isJsonObject(current)) return 'Tailscale is not running';
  const peer = findPeer(current, parsed.name);
  if (peer === 'missing') return `no peer on this tailnet is named ${parsed.name}`;
  if (peer === 'ambiguous') return `several tailnet peers match ${parsed.name}`;
  if (peer.nodeId !== credential.nodeId) {
    return `${peer.dnsName} is now node ${peer.nodeId}, not the pinned ${credential.nodeId}; run stim doctor`;
  }
  return endpoint(peer, parsed.port);
}
