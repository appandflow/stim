import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { AttentionMachine } from '@/lib/attention';
import { usePolledRequest } from '@/hooks/polled-request';
import { StimConnection } from '@/lib/connection';
import type { HomeArchive, HomeItem, HomeWorktree } from '@/lib/home';
import { createMachineStore, IDLE_LINK, type MachineLink, type MachinesState } from '@/lib/machine-store';
import { listMacs, macToken, type PairedMac } from '@/lib/macs';
import { StatusCache } from '@/lib/status-cache';
import type { MachineUsage, StatusPayload, StatusUsage } from '@/protocol/types';
import { statusStorage } from '@/storage';

export const CLIENT = { name: 'stim-mobile', version: Constants.expoConfig?.version ?? '0.0.0' };

const USAGE_INTERVAL_MS = 15_000;

const machines = createMachineStore({ cache: new StatusCache(statusStorage) });
AppState.addEventListener('change', (state) => {
  if (state !== 'active') machines.flushAll();
});

function useMachines<T>(selector: (state: MachinesState) => T): T {
  return useStore(machines.store, selector);
}

const reload = () => {
  listMacs().then(
    (macs) => machines.setMacs(macs, true),
    () => machines.setMacs([], false),
  );
};

export interface MacConnection extends MachineLink {
  mac: PairedMac | null;
}

export type PairedConnection = MachineLink & {
  mac: PairedMac;
  status: StatusPayload | null;
  usage: MachineUsage | null;
  /** Set while `status` comes from the cache: when it was last known current. */
  cachedSeenAt: number | null;
};

function MacLink({ mac }: { mac: PairedMac }) {
  const [connection, setConnection] = useState<StimConnection | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let created: StimConnection | null = null;
    let cancelled = false;
    let wasOpen = false;
    (async () => {
      const token = await macToken(mac.id);
      if (cancelled) return;
      if (!token) {
        machines.patchLink(mac.id, { missing: true, state: { kind: 'closed' } });
        return;
      }
      const next = new StimConnection({
        endpoint: mac.endpoint,
        auth: { deviceToken: token },
        client: CLIENT,
        onState: (state) => {
          if (cancelled) return;
          const isOpen = state.kind === 'open';
          setOpen(isOpen);
          machines.patchLink(
            mac.id,
            state.kind === 'open'
              ? { state, home: state.server.home ?? null, disconnectedAt: null }
              : wasOpen
                ? { state, disconnectedAt: Date.now() }
                : { state },
          );
          wasOpen = isOpen;
        },
      });
      created = next;
      setConnection(next);
      machines.patchLink(mac.id, { connection: next, missing: false, state: { kind: 'connecting' } });
      next.start();
    })();
    return () => {
      cancelled = true;
      created?.close();
      machines.removeLink(mac.id);
    };
  }, [mac.id, mac.endpoint]);

  useEffect(() => {
    if (!connection) return;
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') connection.retryNow();
    });
    return () => listener.remove();
  }, [connection]);

  useEffect(() => {
    if (!connection) return;
    return connection.subscribe('status.subscribe', {}, (event) => {
      if (event.event !== 'status') return;
      machines.receiveStatus(
        mac.id,
        event.ownLeases ? { ...event.payload, ownLeases: event.ownLeases } : event.payload,
      );
      machines.setHistory(mac.id, event.usage);
    });
  }, [connection, mac.id]);

  usePolledRequest(
    connection,
    'machine.get',
    {},
    {
      intervalMs: USAGE_INTERVAL_MS,
      active: open,
      onData: (usage) => machines.setUsage(mac.id, usage),
    },
  );

  return null;
}

export function MacsProvider({ children }: { children: ReactNode }) {
  const macs = useMachines((state) => state.macs);
  useEffect(reload, []);
  return (
    <>
      {(macs ?? []).map((mac) => (
        <MacLink key={`${mac.id}\n${mac.endpoint}\n${mac.pairedAt}`} mac={mac} />
      ))}
      {children}
    </>
  );
}

export function useMacs(): { macs: PairedMac[] | null; reload: () => void; connections: PairedConnection[] } {
  const { macs, links, snapshots, usage } = useMachines(
    useShallow((state) => ({ macs: state.macs, links: state.links, snapshots: state.snapshots, usage: state.usage })),
  );
  const connections = useMemo(
    () =>
      (macs ?? []).map((mac) => ({
        mac,
        ...(links[mac.id] ?? IDLE_LINK),
        status: snapshots[mac.id]?.status ?? null,
        cachedSeenAt: snapshots[mac.id]?.cachedSeenAt ?? null,
        usage: usage[mac.id] ?? null,
      })),
    [macs, links, snapshots, usage],
  );
  return { macs, reload, connections };
}

/** What home's attention strip and the notifications read of a machine; a still-cached status counts as none. */
export function toAttentionMachine(c: PairedConnection): AttentionMachine {
  return {
    id: c.mac.id,
    name: c.mac.name,
    state: c.state,
    missing: c.missing,
    status: c.cachedSeenAt === null ? c.status : null,
    usage: c.usage,
    home: c.home,
    disconnectedAt: c.disconnectedAt,
    seenAt: c.cachedSeenAt,
  };
}

/** The paired machines, null until the pairings load. */
export function usePairedMacs(): PairedMac[] | null {
  return useMachines((state) => state.macs);
}

export function useMacById(id: string | undefined): MacConnection {
  const loaded = useMachines((state) => state.macs !== null);
  const mac = useMachines((state) => state.macs?.find((m) => m.id === id) ?? null);
  const link = useMachines((state) => (id ? state.links[id] : undefined));
  return useMemo(
    () =>
      mac
        ? { mac, ...(link ?? IDLE_LINK) }
        : { ...IDLE_LINK, mac: null, missing: loaded, state: { kind: loaded ? 'closed' : 'connecting' } },
    [mac, link, loaded],
  );
}

/** The Mac the current `/mac/[id]/...` route names. */
export function useMacConnection(): MacConnection {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return useMacById(id);
}

export function useMachineStatus(macId: string | undefined): StatusPayload | null {
  return useMachines((state) => (macId ? (state.snapshots[macId]?.status ?? null) : null));
}

export function useStatus(): StatusPayload | null {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return useMachineStatus(id);
}

export function useMachineUsage(macId: string | undefined): MachineUsage | null {
  return useMachines((state) => (macId ? (state.usage[macId] ?? null) : null));
}

/** The CPU and memory history the server sent with its latest status; null from a server that keeps none. */
export function useStatusHistory(macId: string | undefined): StatusUsage | null {
  return useMachines((state) => (macId ? (state.history[macId] ?? null) : null));
}

export function useMachineLink(macId: string): MachineLink {
  return useMachines((state) => state.links[macId] ?? IDLE_LINK);
}

export interface MachinePresence {
  online: boolean;
  /** Whether the machine's status is the cached one, not yet replaced by a live status. */
  cached: boolean;
  /** When the machine's status was last known current: the cached status's time, or the drop. */
  lastSeenAt: number | null;
}

export function useMachinePresence(macId: string): MachinePresence {
  return useMachines(
    useShallow((state) => {
      const link = state.links[macId];
      const cachedSeenAt = state.snapshots[macId]?.cachedSeenAt ?? null;
      return {
        online: link?.state.kind === 'open',
        cached: cachedSeenAt !== null,
        lastSeenAt: cachedSeenAt ?? link?.disconnectedAt ?? null,
      };
    }),
  );
}

/** Every workspace of every machine, in home's order, from the pairings or, before they load, the cache. */
export function useWorkspaceItems(): HomeItem[] {
  return useMachines((state) => state.workspaces);
}

export function useArchiveItems(): HomeArchive[] {
  return useMachines((state) => state.archives);
}

export function useWorktreeItems(): HomeWorktree[] {
  return useMachines((state) => state.worktrees);
}

/** One workspace's item, undefined while its machine has no status or no longer lists it. */
export function useWorkspace(macId: string, path: string): HomeItem | undefined {
  const key = `${macId}\n${path}`;
  return useMachines((state) => state.workspaces.find((item) => item.key === key));
}

export function useHasStatus(macId: string): boolean {
  return useMachines((state) => macId in state.snapshots);
}
