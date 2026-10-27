import { t } from '@lingui/core/macro';

import type { PairingPayload } from '@/protocol/types';

export type PairingResult = { ok: true; payload: PairingPayload } | { ok: false; error: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const ENDPOINT = /^(wss?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?(\/[^\s?#]*)?$/i;

/** 32 bytes in base64url without padding: the pairing token and the server key. */
const KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** The lowercase host of an endpoint `manualPairing` accepted. */
export function endpointHost(endpoint: string): string {
  return ENDPOINT.exec(endpoint)?.[2].toLowerCase() ?? endpoint;
}

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.map(Number);
}

/**
 * A loopback, RFC 1918, link-local, shared (RFC 6598, which Tailscale uses) or unique local IP literal. A host name
 * cannot be checked without resolving it, so it never counts.
 */
function isPrivateAddress(host: string): boolean {
  if (LOOPBACK.has(host)) return true;
  const v4 = ipv4(host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const v6 = host.slice(1, -1).toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
}

/** Stim Desktop pairs through Tailscale or a private network; any other host deserves a second look. */
export function isExpectedHost(host: string): boolean {
  return host.endsWith('.ts.net') || isPrivateAddress(host);
}

/** `wss://` anywhere; plain `ws://` only to a private address, since the Noise session encrypts either way. */
function checkEndpoint(endpoint: string): string | null {
  const match = ENDPOINT.exec(endpoint);
  if (!match) return t`The endpoint is not a ws:// or wss:// URL.`;
  const [, scheme, host] = match;
  if (scheme.toLowerCase() === 'wss') return null;
  if (isPrivateAddress(host.toLowerCase())) return null;
  return t`The endpoint must start with wss://, or use ws:// with a private IP address.`;
}

export function parsePairingCode(text: string): PairingResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: t`This QR code is not a Stim pairing code.` };
  }
  if (!value || typeof value !== 'object') return { ok: false, error: t`This QR code is not a Stim pairing code.` };
  const { v, name, endpoint, pairingToken, fingerprint } = value as Record<string, unknown>;
  if (v === 1)
    return { ok: false, error: t`This pairing code is from an older stim-server. Update stim-server on this Mac.` };
  if (v !== 2) return { ok: false, error: t`This pairing code needs a newer version of the app.` };
  if (typeof endpoint !== 'string' || typeof pairingToken !== 'string' || typeof fingerprint !== 'string') {
    return { ok: false, error: t`This QR code is not a Stim pairing code.` };
  }
  if (!KEY.test(fingerprint)) return { ok: false, error: t`This QR code is not a Stim pairing code.` };
  const parsed = manualPairing(endpoint, pairingToken, typeof name === 'string' ? name : '');
  return parsed.ok ? { ok: true, payload: { ...parsed.payload, fingerprint } } : parsed;
}

export function manualPairing(endpoint: string, pairingToken: string, name = ''): PairingResult {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  const problem = checkEndpoint(trimmed);
  if (problem) return { ok: false, error: problem };
  const token = pairingToken.trim();
  if (token === '') return { ok: false, error: t`Enter the pairing token Stim Desktop shows.` };
  if (!KEY.test(token)) return { ok: false, error: t`The pairing token is 43 letters, digits, - and _.` };
  return { ok: true, payload: { v: 2, name, endpoint: trimmed, pairingToken: token } };
}
