import * as SecureStore from 'expo-secure-store';
import { validHomeId } from '@stim-cli/core/workspace-link';
import { clientPublicKey } from 'react-native-stim-session';

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

const CLIENT_KEY = 'stim.client-key';

let queue: Promise<unknown> = Promise.resolve();
/** Runs index reads and writes one at a time, so a migration cannot write back an index a save already replaced. */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function parseIndex(raw: string | null): Partial<PairedMac>[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as Partial<PairedMac>[]) : [];
  } catch {
    return [];
  }
}

/** The index, without pairings this phone can no longer use; call it inside `serially`. */
async function readIndex(): Promise<PairedMac[]> {
  const macs = parseIndex(await SecureStore.getItemAsync(INDEX_KEY));
  const current = macs.filter((mac): mac is PairedMac => typeof mac.serverKey === 'string');
  if (current.length < macs.length) await dropProtocolOnePairings(macs, current);
  return (await clientKeyChanged()) ? dropAll(current) : current;
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

let checkedClientKey = false;
/**
 * Whether the session made a new client key since the Macs were saved, as after its stored key could not be read;
 * the Macs know only the old one. Checked once per launch; a key the session cannot read now is left for the
 * connection to report.
 */
async function clientKeyChanged(): Promise<boolean> {
  if (checkedClientKey) return false;
  let key: string;
  try {
    key = clientPublicKey();
  } catch {
    return false;
  }
  checkedClientKey = true;
  const saved = await SecureStore.getItemAsync(CLIENT_KEY);
  if (saved !== key) await SecureStore.setItemAsync(CLIENT_KEY, key);
  return saved !== null && saved !== key;
}

async function dropAll(macs: PairedMac[]): Promise<PairedMac[]> {
  for (const mac of macs) await SecureStore.deleteItemAsync(identityKey(mac.id));
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([]));
  return [];
}

async function readMacs(): Promise<PairedMac[]> {
  const macs = await readIndex();
  return Promise.all(
    macs.map(async (mac) => {
      const serverId = await SecureStore.getItemAsync(identityKey(mac.id)).catch(() => null);
      return { ...mac, ...(validHomeId(serverId) ? { serverId: serverId.toLowerCase() } : {}) };
    }),
  );
}

export function listMacs(): Promise<PairedMac[]> {
  return serially(readMacs);
}

/** Pairing the same endpoint again replaces its entry and pinned key. */
export function saveMac(mac: Omit<PairedMac, 'id' | 'pairedAt'>): Promise<PairedMac> {
  return serially(async () => {
    const macs = await readMacs();
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
  });
}

export function renameMac(id: string, name: string): Promise<void> {
  return serially(async () => {
    const macs = await readMacs();
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(macs.map((m) => (m.id === id ? { ...m, name } : m))));
  });
}

export function forgetMac(id: string): Promise<void> {
  return serially(async () => {
    await SecureStore.deleteItemAsync(identityKey(id));
    const macs = await readMacs();
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(macs.filter((m) => m.id !== id)));
  });
}
