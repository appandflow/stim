import * as SecureStore from 'expo-secure-store';
import { validHomeId } from '@stim-cli/core/workspace-link';

export interface PairedMac {
  id: string;
  name: string;
  endpoint: string;
  pairedAt: string;
  serverId?: string;
}

const INDEX_KEY = 'stim.macs';
const tokenKey = (id: string) => `stim.mac.${id}.token`;
const identityKey = (id: string) => `stim.mac.${id}.home-id`;

export async function rememberServerIdentity(id: string, serverId: string): Promise<void> {
  if (validHomeId(serverId)) await SecureStore.setItemAsync(identityKey(id), serverId.toLowerCase());
}

export async function listMacs(): Promise<PairedMac[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return Promise.all(
      (value as PairedMac[]).map(async (mac) => {
        const serverId = await SecureStore.getItemAsync(identityKey(mac.id)).catch(() => null);
        return { ...mac, ...(validHomeId(serverId) ? { serverId: serverId.toLowerCase() } : {}) };
      }),
    );
  } catch {
    return [];
  }
}

/** Pairing the same endpoint again replaces its entry and token. */
export async function saveMac(mac: Omit<PairedMac, 'id' | 'pairedAt'>, deviceToken: string): Promise<PairedMac> {
  const macs = await listMacs();
  const existing = macs.find((m) => m.endpoint === mac.endpoint);
  const { serverId, ...record } = mac;
  const saved: PairedMac = {
    ...record,
    id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    pairedAt: new Date().toISOString(),
  };
  if (serverId) await rememberServerIdentity(saved.id, serverId);
  await SecureStore.setItemAsync(tokenKey(saved.id), deviceToken);
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...macs.filter((m) => m.id !== saved.id), saved]));
  return saved;
}

export async function renameMac(id: string, name: string): Promise<void> {
  const macs = await listMacs();
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(macs.map((m) => (m.id === id ? { ...m, name } : m))));
}

export async function forgetMac(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(id));
  await SecureStore.deleteItemAsync(identityKey(id));
  const macs = await listMacs();
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(macs.filter((m) => m.id !== id)));
}

export function macToken(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(id));
}
