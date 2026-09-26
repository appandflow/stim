import { createStore } from 'zustand/vanilla';

import type { ConnectionState, StimConnection } from '@/lib/connection';
import { mergeWorkspaces, type HomeItem } from '@/lib/home';
import type { PairedMac } from '@/lib/macs';
import type { StatusCache } from '@/lib/status-cache';
import { shareItems, shareStatus } from '@/lib/status-share';
import type { MachineUsage, StatusPayload } from '@/protocol/types';

export interface MachineLink {
  connection: StimConnection | null;
  state: ConnectionState;
  missing: boolean;
  /** The Mac's home folder, from `hello`; null until connected or from an older server. */
  home: string | null;
  /** When the connection last dropped; null while connected or before the first connection. */
  disconnectedAt: number | null;
}

export interface MachineSnapshot {
  status: StatusPayload;
  /** The machine's name when the snapshot was cached, for the rows shown before the pairings load. */
  name: string;
  /** Set while the status comes from the cache: when it was last known current. Null once a live status arrives. */
  cachedSeenAt: number | null;
}

export interface MachinesState {
  macs: PairedMac[] | null;
  links: Record<string, MachineLink>;
  snapshots: Record<string, MachineSnapshot>;
  usage: Record<string, MachineUsage>;
  /** Every workspace of every machine, in home's order; an unchanged workspace keeps its item. */
  workspaces: HomeItem[];
}

export const IDLE_LINK: MachineLink = {
  connection: null,
  state: { kind: 'connecting' },
  missing: false,
  home: null,
  disconnectedAt: null,
};

export const CACHE_WRITE_DELAY_MS = 5000;

function workspacesOf(state: Pick<MachinesState, 'macs' | 'snapshots' | 'workspaces'>): HomeItem[] {
  const machines = state.macs
    ? state.macs.map((mac) => ({ id: mac.id, name: mac.name }))
    : Object.entries(state.snapshots).map(([id, snapshot]) => ({ id, name: snapshot.name }));
  const next = mergeWorkspaces(machines.map((mac) => ({ ...mac, status: state.snapshots[mac.id]?.status ?? null })));
  return shareItems(state.workspaces, next);
}

const without = <T>(record: Record<string, T>, id: string): Record<string, T> => {
  if (!(id in record)) return record;
  const { [id]: _removed, ...rest } = record;
  return rest;
};

/**
 * The pool of paired machines: each one's connection, last status and usage. The cache, when given, fills the
 * snapshots at creation and receives each machine's live status at most every `writeDelayMs`, and at once when
 * its connection drops or `flushAll` runs.
 */
export function createMachineStore({
  cache = null,
  writeDelayMs = CACHE_WRITE_DELAY_MS,
  now = Date.now,
}: { cache?: StatusCache | null; writeDelayMs?: number; now?: () => number } = {}) {
  const snapshots: Record<string, MachineSnapshot> = {};
  for (const [id, entry] of Object.entries(cache?.readAll() ?? {})) {
    snapshots[id] = { status: entry.status, name: entry.name, cachedSeenAt: entry.seenAt };
  }
  const store = createStore<MachinesState>()(() => ({
    macs: null,
    links: {},
    snapshots,
    usage: {},
    workspaces: workspacesOf({ macs: null, snapshots, workspaces: [] }),
  }));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const write = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    const { snapshots: all, links } = store.getState();
    const snapshot = all[id];
    if (!cache || !snapshot || snapshot.cachedSeenAt !== null) return;
    const link = links[id];
    const seenAt = link?.state.kind === 'open' ? now() : (link?.disconnectedAt ?? now());
    cache.write(id, { status: snapshot.status, name: snapshot.name, seenAt });
  };

  const schedule = (id: string) => {
    if (cache && !timers.has(id))
      timers.set(
        id,
        setTimeout(() => write(id), writeDelayMs),
      );
  };

  const forget = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  return {
    store,
    /** `prune` removes the snapshots and cache entries of machines not in `macs`; pass it only for a list read successfully. */
    setMacs(macs: PairedMac[], prune: boolean) {
      store.setState((state) => {
        const ids = new Set(macs.map((mac) => mac.id));
        let { snapshots: kept, usage } = state;
        if (prune) {
          for (const id of Object.keys(kept)) {
            if (!ids.has(id)) {
              forget(id);
              kept = without(kept, id);
              usage = without(usage, id);
            }
          }
          cache?.keepOnly([...ids]);
        }
        for (const mac of macs) {
          const snapshot = kept[mac.id];
          if (snapshot && snapshot.name !== mac.name) kept = { ...kept, [mac.id]: { ...snapshot, name: mac.name } };
        }
        return { macs, snapshots: kept, usage, workspaces: workspacesOf({ ...state, macs, snapshots: kept }) };
      });
    },
    patchLink(id: string, patch: Partial<MachineLink>) {
      const before = store.getState().links[id];
      store.setState((state) => ({ links: { ...state.links, [id]: { ...(state.links[id] ?? IDLE_LINK), ...patch } } }));
      if (before?.state.kind === 'open' && patch.state && patch.state.kind !== 'open') write(id);
    },
    removeLink(id: string) {
      if (store.getState().links[id]?.state.kind === 'open') write(id);
      store.setState((state) => ({ links: without(state.links, id), usage: without(state.usage, id) }));
    },
    receiveStatus(id: string, payload: StatusPayload) {
      const state = store.getState();
      const prev = state.snapshots[id];
      const status = shareStatus(prev?.status ?? null, payload);
      if (prev && prev.status === status && prev.cachedSeenAt === null) return;
      const name = state.macs?.find((mac) => mac.id === id)?.name ?? prev?.name ?? '';
      const snapshots = { ...state.snapshots, [id]: { status, name, cachedSeenAt: null } };
      store.setState({
        snapshots,
        workspaces: prev?.status === status ? state.workspaces : workspacesOf({ ...state, snapshots }),
      });
      schedule(id);
    },
    setUsage(id: string, usage: MachineUsage) {
      store.setState((state) => ({ usage: { ...state.usage, [id]: usage } }));
    },
    /** Writes every live status now, as the app leaves the foreground. */
    flushAll() {
      for (const id of Object.keys(store.getState().snapshots)) write(id);
    },
  };
}

export type MachineStore = ReturnType<typeof createMachineStore>;
