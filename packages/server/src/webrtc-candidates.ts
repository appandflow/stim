import { isIPv4, isIPv6 } from 'node:net';

/**
 * Which ICE candidates the machine that sends a share's video may offer to a viewer and use for a viewer's. Only
 * addresses reachable on a local network or a tailnet pass, so a viewer on the public internet never learns the
 * sender's public address from the SDP, and the sender never sends it an ICE check, which would show that address to
 * the viewer as the packet's source.
 */

function ipv4Allowed(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Whether `address` is loopback, private (RFC 1918, unique local), link-local, or in the tailnet range 100.64.0.0/10. */
export function privateAddress(address: string): boolean {
  const bare = (address.split('%')[0] ?? '').toLowerCase();
  if (isIPv4(bare)) return ipv4Allowed(bare);
  if (!isIPv6(bare)) return false;
  const mapped = /^(?:0{0,4}:){2,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return ipv4Allowed(mapped[1] ?? '');
  if (bare === '::1') return true;
  const first = parseInt(bare.split(':')[0] || '0', 16);
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
}

export interface FilteredSdp {
  sdp: string;
  /** The candidates that remain. */
  kept: number;
}

/**
 * Removes the `a=candidate` lines of `sdp` whose address is not {@link privateAddress}. An mDNS name (`<uuid>.local`)
 * stays: it resolves only on the viewer's own link. Any other host name goes, because resolving it would be a DNS query
 * the viewer chose. A connection line (`c=`) with a public address becomes 0.0.0.0, the value browsers write.
 */
export function filterCandidates(sdp: string): FilteredSdp {
  let kept = 0;
  const lines = sdp.split(/\r?\n/).filter((line) => {
    if (!line.startsWith('a=candidate:')) return true;
    const address = line.split(' ')[4] ?? '';
    const allowed = privateAddress(address) || /^[0-9a-f-]+\.local$/i.test(address);
    if (allowed) kept++;
    return allowed;
  });
  const hidden = lines.map((line) => {
    const connection = /^c=IN IP[46] (\S+)$/.exec(line);
    return connection && !privateAddress(connection[1] ?? '') ? 'c=IN IP4 0.0.0.0' : line;
  });
  return { sdp: hidden.join('\r\n'), kept };
}
