import type { PairingPayload } from '@/protocol/types';

export type PairingResult = { ok: true; payload: PairingPayload } | { ok: false; error: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `wss://` anywhere; plain `ws://` only to this device, for the mock server and the simulator. */
export function checkEndpoint(endpoint: string): string | null {
  const match = /^(wss?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?(\/[^\s?#]*)?$/i.exec(endpoint);
  if (!match) return 'The endpoint is not a ws:// or wss:// URL.';
  const [, scheme, host] = match;
  if (scheme.toLowerCase() === 'wss') return null;
  if (LOOPBACK.has(host.toLowerCase())) return null;
  return 'The endpoint must start with wss://.';
}

export function parsePairingCode(text: string): PairingResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This QR code is not a Stim pairing code.' };
  }
  if (!value || typeof value !== 'object') return { ok: false, error: 'This QR code is not a Stim pairing code.' };
  const { v, name, endpoint, pairingToken } = value as Record<string, unknown>;
  if (v !== 1) return { ok: false, error: 'This pairing code needs a newer version of the app.' };
  if (typeof endpoint !== 'string' || typeof pairingToken !== 'string' || pairingToken === '') {
    return { ok: false, error: 'This QR code is not a Stim pairing code.' };
  }
  return manualPairing(endpoint, pairingToken, typeof name === 'string' ? name : '');
}

export function manualPairing(endpoint: string, pairingToken: string, name = ''): PairingResult {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  const problem = checkEndpoint(trimmed);
  if (problem) return { ok: false, error: problem };
  if (pairingToken.trim() === '') return { ok: false, error: 'Enter the pairing token Stim Desktop shows.' };
  return { ok: true, payload: { v: 1, name, endpoint: trimmed, pairingToken: pairingToken.trim() } };
}
