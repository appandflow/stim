import { StimConnection } from '@/lib/connection';
import { listMacs, macToken, saveMac, type PairedMac } from '@/lib/macs';

export interface DevPairing {
  endpoint: string;
  deviceToken: string;
}

/**
 * The Mac `pnpm run dev:pair` wrote to `.env.local`. Expo loads `.env.local` for release bundles too,
 * so the variables are read only under `__DEV__`, which lets the minifier drop their values.
 */
export function devPairing(): DevPairing | null {
  if (__DEV__) {
    const endpoint = process.env.EXPO_PUBLIC_STIM_DEV_ENDPOINT;
    const deviceToken = process.env.EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN;
    if (endpoint && deviceToken) return { endpoint, deviceToken };
  }
  return null;
}

function serverName(pairing: DevPairing, client: { name: string; version: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = new StimConnection({
      endpoint: pairing.endpoint,
      auth: { deviceToken: pairing.deviceToken },
      client,
      onState: (state) => {
        if (state.kind === 'open') resolve(state.server.name);
        else if (state.kind === 'refused' || state.kind === 'waiting') reject(new Error(state.reason));
        else return;
        connection.close();
      },
    });
    connection.start();
  });
}

/** Stores the `.env.local` Mac, named from the server's `hello` unless it is already stored. */
export async function applyDevPairing(
  pairing: DevPairing,
  client: { name: string; version: string },
): Promise<PairedMac> {
  const existing = (await listMacs()).find((mac) => mac.endpoint === pairing.endpoint);
  if (existing && (await macToken(existing.id)) === pairing.deviceToken) return existing;
  const name = existing?.name ?? (await serverName(pairing, client));
  return saveMac({ name, endpoint: pairing.endpoint }, pairing.deviceToken);
}
