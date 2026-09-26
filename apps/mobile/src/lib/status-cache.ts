import type { StatusPayload } from '@/protocol/types';

/** The subset of `react-native-mmkv`'s `MMKV` the cache uses. */
export interface KeyValueStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): boolean;
  getAllKeys(): string[];
}

export interface CachedStatus {
  status: StatusPayload;
  /** The machine's name, for the rows shown before the pairings load. */
  name: string;
  /** When the phone last knew this status was current: written while connected, or when the connection dropped. */
  seenAt: number;
}

const PREFIX = 'status:';
const VERSION = 1;
export const MAX_ENTRY_CHARS = 1_000_000;

const keyOf = (macId: string) => `${PREFIX}${macId}`;

function parse(raw: string | undefined): CachedStatus | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      v?: unknown;
      name?: unknown;
      seenAt?: unknown;
      status?: { environments?: unknown };
    };
    if (
      value.v !== VERSION ||
      typeof value.name !== 'string' ||
      typeof value.seenAt !== 'number' ||
      !Array.isArray(value.status?.environments)
    ) {
      return null;
    }
    return { status: value.status as StatusPayload, name: value.name, seenAt: value.seenAt };
  } catch {
    return null;
  }
}

/** Each paired machine's last status, one key per machine, so a cold launch can show it before connecting. */
export class StatusCache {
  constructor(private readonly store: KeyValueStore) {}

  /** Every readable entry by machine id; an unreadable one is removed. */
  readAll(): Record<string, CachedStatus> {
    const out: Record<string, CachedStatus> = {};
    for (const key of this.store.getAllKeys()) {
      if (!key.startsWith(PREFIX)) continue;
      const entry = parse(this.store.getString(key));
      if (entry) out[key.slice(PREFIX.length)] = entry;
      else this.store.remove(key);
    }
    return out;
  }

  write(macId: string, entry: CachedStatus): void {
    const raw = JSON.stringify({ v: VERSION, name: entry.name, seenAt: entry.seenAt, status: entry.status });
    if (raw.length > MAX_ENTRY_CHARS) this.store.remove(keyOf(macId));
    else this.store.set(keyOf(macId), raw);
  }

  /** Removes the entries of machines no longer paired. */
  keepOnly(macIds: string[]): void {
    const keep = new Set(macIds.map(keyOf));
    for (const key of this.store.getAllKeys()) {
      if (key.startsWith(PREFIX) && !keep.has(key)) this.store.remove(key);
    }
  }
}
