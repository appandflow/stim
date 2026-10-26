import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { TRANSPORT_API_VERSION, type Transport, type TransportInput } from '@stim-cli/transport';

export const apiVersion: typeof TRANSPORT_API_VERSION = TRANSPORT_API_VERSION;
export const id = 'local';

const POLL_MS = 5000;

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** What `server.lanAddresses` names now: the addresses to listen on, and why each other entry is left out. */
export interface LanAddresses {
  addresses: string[];
  problems: string[];
}

/** RFC 1918 and link-local IPv4 addresses: a local network, never the public internet or a loopback. */
function isPrivateIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * The private IPv4 addresses that `entries` name on this machine's interfaces now. An entry is an IPv4 address or an
 * interface name such as `en0`; an interface contributes each private IPv4 address it has. Wildcard, loopback, public
 * and IPv6 addresses are refused, and an address no interface holds now is left out until one does.
 */
export function resolveLanAddresses(entries: readonly string[], interfaces: Interfaces): LanAddresses {
  const held = new Set(
    Object.values(interfaces).flatMap((each) => (each ?? []).filter((info) => info.family === 'IPv4')),
  );
  const addresses = new Set<string>();
  const problems: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (isIPv4(entry)) {
      if (!isPrivateIPv4(entry)) {
        problems.push(`${entry} is not a private local network address (10/8, 172.16/12, 192.168/16 or 169.254/16)`);
      } else if (![...held].some((info) => info.address === entry)) {
        problems.push(`no network interface has ${entry} now`);
      } else {
        addresses.add(entry);
      }
      continue;
    }
    const named = interfaces[entry];
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(entry)) {
      problems.push(`${entry} is neither an IPv4 address nor a network interface name`);
    } else if (!named) {
      problems.push(`no network interface is named ${entry} now`);
    } else {
      const found = named.filter((info) => info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address));
      if (!found.length) problems.push(`${entry} has no private IPv4 address now`);
      for (const info of found) addresses.add(info.address);
    }
  }
  return { addresses: [...addresses], problems };
}

/** The local network transport, plus the reasons stim-server cannot listen on some of the entries it was given. */
export interface LocalTransport extends Transport {
  id: typeof id;
  lan(): LanAddresses;
  bindAddresses(): string[];
  watch(listener: () => void): () => void;
}

/**
 * Listens on the local network addresses `entries` names, read again on every poll so a changed setting or a new
 * DHCP lease applies without a restart. It carries plain WebSocket: stim-server's Noise handshake authenticates every
 * client by its key and encrypts the connection, so the transport needs no TLS and never identifies anyone.
 */
export function localTransport({
  entries,
  interfaces = networkInterfaces,
  pollMs = POLL_MS,
}: {
  entries: () => readonly string[];
  interfaces?: () => Interfaces;
  pollMs?: number;
}): LocalTransport {
  const read = (): LanAddresses => {
    try {
      return resolveLanAddresses(entries(), interfaces());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { addresses: [], problems: [`could not read the local network addresses: ${reason}`] };
    }
  };
  const timers = new Set<NodeJS.Timeout>();
  return {
    id,
    traits: { privateNetwork: false, tls: 'none', peerIdentity: false },
    lan: read,
    bindAddresses: () => read().addresses,
    watch(listener) {
      let last = JSON.stringify(read());
      const timer = setInterval(() => {
        const next = JSON.stringify(read());
        if (next === last) return;
        last = next;
        listener();
      }, pollMs);
      timer.unref();
      timers.add(timer);
      return () => {
        clearInterval(timer);
        timers.delete(timer);
      };
    },
    close() {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    },
  };
}

export function createTransport({ options }: TransportInput): LocalTransport {
  const given = Array.isArray(options.addresses) ? options.addresses : [];
  const addresses = given.filter((entry): entry is string => typeof entry === 'string');
  return localTransport({ entries: () => addresses });
}
