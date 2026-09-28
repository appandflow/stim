import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { useMacs } from '@/hooks/mac-connection';
import type { ConnectionState, StimConnection } from '@/lib/connection';
import {
  applyList,
  applyLive,
  inboxItems,
  markAllRead,
  markRead,
  notificationSeqs,
  parseReadState,
  type InboxFilters,
  type InboxItem,
  type MacHistory,
  type ReadState,
} from '@/lib/inbox';
import { notificationStorage as storage } from '@/storage';

const READ_PREFIX = 'inbox:';

interface InboxState {
  histories: Record<string, MacHistory>;
  reads: Record<string, ReadState>;
  refreshing: boolean;
}

const inbox = create<InboxState>(() => ({ histories: {}, reads: {}, refreshing: false }));

/** Read state is user data: `clearDerivedDataOnChange` keeps every key but the notification state. */
function readStateOf(macId: string, log: string): ReadState {
  const known = inbox.getState().reads[macId];
  return known?.log === log ? known : parseReadState(storage.getString(`${READ_PREFIX}${macId}`), log);
}

function saveRead(macId: string, next: ReadState): void {
  storage.set(`${READ_PREFIX}${macId}`, JSON.stringify(next));
  inbox.setState((state) => ({ reads: { ...state.reads, [macId]: next } }));
}

type TapData = { notification?: unknown; key?: unknown };

const pendingTaps = new Map<string, TapData[]>();

function markTapsRead(macId: string, history: MacHistory, taps: TapData[]): void {
  const seqs = taps.flatMap((data) => notificationSeqs(history, data));
  if (seqs.length === 0) return;
  const oldest = history.entries.at(-1)?.seq ?? 0;
  saveRead(macId, markRead(readStateOf(macId, history.log), seqs, oldest));
}

function setHistory(macId: string, history: MacHistory): void {
  inbox.setState((state) => ({
    histories: { ...state.histories, [macId]: history },
    reads: { ...state.reads, [macId]: readStateOf(macId, history.log) },
  }));
  const taps = pendingTaps.get(macId);
  if (!taps) return;
  pendingTaps.delete(macId);
  markTapsRead(macId, history, taps);
}

/** The connection state each Mac was last listed in, so each connection lists once. */
const listed = new Map<string, ConnectionState>();

function list(macId: string, connection: StimConnection): Promise<void> {
  const known = inbox.getState().histories[macId];
  const all = () => connection.request('notifications.list', {});
  const request = known ? connection.request('notifications.list', { since: known.cursor }) : all();
  return request
    .then((result) => (known && (result.log !== known.log || result.cursor < known.cursor) ? all() : result))
    .then(
      (result) => {
        const history = applyList(inbox.getState().histories[macId] ?? null, result);
        if (!storage.contains(`${READ_PREFIX}${macId}`)) {
          saveRead(macId, markAllRead(parseReadState(undefined, history.log), history.cursor));
        }
        setHistory(macId, history);
      },
      () => void listed.delete(macId),
    );
}

type OpenState = Extract<ConnectionState, { kind: 'open' }>;

function keepsHistory(state: ConnectionState): state is OpenState {
  return state.kind === 'open' && state.features.includes('notifications');
}

/** Marks read what a tapped notification of Mac `macId` reported, once its history is listed. */
export function markNotificationRead(macId: string, data: TapData): void {
  const history = inbox.getState().histories[macId];
  if (history) markTapsRead(macId, history, [data]);
  else pendingTaps.set(macId, [...(pendingTaps.get(macId) ?? []), data]);
}

/** Forgets a Mac's history and read state, with its pairing. */
export function forgetInbox(macId: string): void {
  storage.remove(`${READ_PREFIX}${macId}`);
  listed.delete(macId);
  pendingTaps.delete(macId);
  inbox.setState((state) => {
    const { [macId]: _history, ...histories } = state.histories;
    const { [macId]: _read, ...reads } = state.reads;
    return { histories, reads };
  });
}

interface MacLinkInfo {
  id: string;
  name: string;
  state: ConnectionState;
  connection: StimConnection | null;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function identity(value: object | null): number {
  if (!value) return 0;
  let known = identities.get(value);
  if (known === undefined) {
    known = nextIdentity++;
    identities.set(value, known);
  }
  return known;
}

function useMacLinks(): MacLinkInfo[] {
  const { connections } = useMacs();
  const key = connections
    .map(({ mac, state, connection }) => `${mac.id}\n${mac.name}\n${identity(state)}\n${identity(connection)}`)
    .join('\n\n');
  const latest = useMemo(
    () => ({
      key,
      links: connections.map(({ mac, state, connection }) => ({
        id: mac.id,
        name: mac.name,
        state,
        connection: connection ?? null,
      })),
    }),
    [connections, key],
  );
  const [stable, setStable] = useState(latest);
  if (stable.key !== latest.key) setStable(latest);
  return stable.links;
}

/** Lists each open Mac's notification history, on every connection, and adds the ones it logs while connected. */
export function InboxSync() {
  const links = useMacLinks();
  useEffect(() => {
    const stops: (() => void)[] = [];
    for (const { id, state, connection } of links) {
      if (!keepsHistory(state) || !connection) continue;
      stops.push(
        connection.onNotification((event) =>
          setHistory(id, applyLive(inbox.getState().histories[id] ?? null, event.log, event.notification)),
        ),
      );
      if (listed.get(id) === state) continue;
      listed.set(id, state);
      void list(id, connection);
    }
    return () => stops.forEach((stop) => stop());
  }, [links]);
  return null;
}

export interface Inbox {
  /** Whether any paired Mac keeps a notification history. */
  supported: boolean;
  items: InboxItem[];
  unread: number;
  refreshing: boolean;
  refresh: () => void;
  markRead: (item: InboxItem) => void;
  markAllRead: () => void;
}

const NO_FILTERS: InboxFilters = { categories: null, macIds: null };

/** `filters` must keep its identity between renders while unchanged. */
export function useInbox(filters: InboxFilters = NO_FILTERS): Inbox {
  const links = useMacLinks();
  const { histories, reads, refreshing } = inbox(useShallow((state) => state));
  const macs = useMemo(
    () =>
      links.map((link) => ({
        id: link.id,
        name: link.name,
        history: histories[link.id] ?? null,
        read: reads[link.id] ?? null,
      })),
    [links, histories, reads],
  );
  const items = useMemo(() => inboxItems(macs, filters), [macs, filters]);
  const unread = useMemo(() => inboxItems(macs, NO_FILTERS).filter((item) => !item.read).length, [macs]);
  const supported = macs.some((mac) => mac.history !== null) || links.some((link) => keepsHistory(link.state));

  const refresh = useCallback(() => {
    const pending = links.flatMap(({ id, state, connection }) =>
      keepsHistory(state) && connection ? [list(id, connection)] : [],
    );
    inbox.setState({ refreshing: true });
    void Promise.all(pending).finally(() => inbox.setState({ refreshing: false }));
  }, [links]);

  const markItemRead = useCallback(
    (item: InboxItem) => markNotificationRead(item.macId, { notification: item.seq }),
    [],
  );

  const filtered = filters.categories !== null || filters.macIds !== null;
  const markShownRead = useCallback(() => {
    for (const mac of macs) {
      if (!mac.history) continue;
      const state = readStateOf(mac.id, mac.history.log);
      if (!filtered) {
        saveRead(mac.id, markAllRead(state, mac.history.cursor));
        continue;
      }
      const seqs = items.filter((item) => item.macId === mac.id).map((item) => item.seq);
      if (seqs.length) saveRead(mac.id, markRead(state, seqs, mac.history.entries.at(-1)?.seq ?? 0));
    }
  }, [macs, items, filtered]);

  return { supported, items, unread, refreshing, refresh, markRead: markItemRead, markAllRead: markShownRead };
}
