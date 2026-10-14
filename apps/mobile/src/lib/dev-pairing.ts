import { pair } from '@/lib/connection';
import { listMacs, saveMac, type PairedMac } from '@/lib/macs';
import { parsePairingCode } from '@/lib/pairing';
import type { PairingPayload } from '@/protocol/types';

const DEVICE_NAME = 'Stim Mobile development';

/**
 * The pairing code `pnpm run dev:pair` wrote to `.env.local`. Expo loads `.env.local` for release bundles too, so
 * the variable is read only under `__DEV__`, which lets the minifier drop its value.
 */
export function devPairing(): PairingPayload | null {
  if (__DEV__) {
    const code = process.env.EXPO_PUBLIC_STIM_DEV_PAIRING;
    if (code) {
      const parsed = parsePairingCode(code);
      if (parsed.ok) return parsed.payload;
    }
  }
  return null;
}

/** Spends the `.env.local` pairing code once; a Mac already stored for its endpoint is kept as it is. */
export async function applyDevPairing(
  pairing: PairingPayload,
  client: { name: string; version: string },
): Promise<PairedMac> {
  const existing = (await listMacs()).find((mac) => mac.endpoint === pairing.endpoint);
  if (existing) return existing;
  const paired = await pair(pairing.endpoint, pairing, DEVICE_NAME, client);
  return saveMac({
    name: pairing.name || paired.serverName,
    endpoint: pairing.endpoint,
    serverKey: paired.serverKey,
    ...(paired.serverId ? { serverId: paired.serverId } : {}),
  });
}
