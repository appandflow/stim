import * as SecureStore from 'expo-secure-store';
import { validHomeId } from '@stim-cli/core/workspace-link';

export interface PairedMac {
  id: string;
  name: string;
  endpoint: string;
  pairedAt: string;
  serverId?: string;
  /** The server's base64url X25519 key, pinned when this phone paired; the session refuses any other. */
  serverKey: string;
}

const INDEX_KEY = 'stim.macs';
const legacyTokenKey = (id: string) => `stim.mac.${id}.token`;
const identityKey = (id: string) => `stim.mac.${id}.home-id`;

export async function rememberServerIdentity(id: string, serverId: string): Promise<void> {
  if (validHomeId(serverId)) await SecureStore.setItemAsync(identityKey(id), serverId.toLowerCase());
}

async function readIndex(): Promise<PairedMac[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const macs = value as Partial<PairedMac>[];
    const current = macs.filter((mac): mac is PairedMac => typeof mac.serverKey === 'string');
    if (current.length < macs.length) await dropProtocolOnePairings(macs, current);
    return current;
  } catch {
    return [];
  }
}

/** A pairing made before protocol 2 has a device token and no server key; the phone must pair again. */
async function dropProtocolOnePairings(macs: Partial<PairedMac>[], current: PairedMac[]): Promise<void> {
  for (const mac of macs) {
    if (typeof mac.serverKey === 'string' || typeof mac.id !== 'string') continue;
    await SecureStore.deleteItemAsync(legacyTokenKey(mac.id));
    await SecureStore.deleteItemAsync(identityKey(mac.id));
  }
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(current));
}

export async function listMacs(): Promise<PairedMac[]> {
  const macs = await readIndex();
  return Promise.all(
    macs.map(async (mac) => {
      const serverId = await SecureStore.getItemAsync(identityKey(mac.id)).catch(() => null);
      return { ...mac, ...(validHomeId(serverId) ? { serverId: serverId.toLowerCase() } : {}) };
    }),
  );
}

/** Pairing the same endpoint again replaces its entry and pinned key. */
export async function saveMac(mac: Omit<PairedMac, 'id' | 'pairedAt'>): Promise<PairedMac> {
  const macs = await listMacs();
  const existing = macs.find((m) => m.endpoint === mac.endpoint);
  const { serverId, ...record } = mac;
  const saved: PairedMac = {
    ...record,
    id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    pairedAt: new Date().toISOString(),
  };
  if (serverId) await rememberServerIdentity(saved.id, serverId);
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...macs.filter((m) => m.id !== saved.id), saved]));
  return saved;
}

export async function renameMac(id: string, name: string): Promise<void> {
  const macs = await listMacs();
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(macs.map((m) => (m.id === id ? { ...m, name } : m))));
}

export async function forgetMac(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(identityKey(id));
  const macs = await listMacs();
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(macs.filter((m) => m.id !== id)));
}
