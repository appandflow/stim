import { useCallback, useEffect, useMemo } from 'react';
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

function setHistory(macId: string, history: MacHistory): void {
  inbox.setState((state) => ({
    histories: { ...state.histories, [macId]: history },
    reads: { ...state.reads, [macId]: readStateOf(macId, history.log) },
  }));
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
      (result) => setHistory(macId, applyList(inbox.getState().histories[macId] ?? null, result)),
      () => {},
    );
}

type OpenState = Extract<ConnectionState, { kind: 'open' }>;

function keepsHistory(state: ConnectionState): state is OpenState {
  return state.kind === 'open' && state.features.includes('notifications');
}

/** Marks read what a tapped notification of Mac `macId` reported. */
export function markNotificationRead(macId: string, data: { notification?: unknown; key?: unknown }): void {
  const history = inbox.getState().histories[macId] ?? null;
  const seqs = notificationSeqs(history, data);
  if (!history || seqs.length === 0) return;
  saveRead(macId, markRead(readStateOf(macId, history.log), seqs));
}

/** Forgets a Mac's history and read state, with its pairing. */
export function forgetInbox(macId: string): void {
  storage.remove(`${READ_PREFIX}${macId}`);
  listed.delete(macId);
  inbox.setState((state) => {
    const { [macId]: _history, ...histories } = state.histories;
    const { [macId]: _read, ...reads } = state.reads;
    return { histories, reads };
  });
}

/** Lists each open Mac's notification history, on every connection, and adds the ones it logs while connected. */
export function InboxSync() {
  const { connections } = useMacs();
  useEffect(() => {
    const stops: (() => void)[] = [];
    for (const { mac, state, connection } of connections) {
      if (!keepsHistory(state) || !connection) continue;
      stops.push(
        connection.onNotification((event) =>
          setHistory(mac.id, applyLive(inbox.getState().histories[mac.id] ?? null, event.log, event.notification)),
        ),
      );
      if (listed.get(mac.id) === state) continue;
      listed.set(mac.id, state);
      void list(mac.id, connection);
    }
    return () => stops.forEach((stop) => stop());
  }, [connections]);
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
  const { connections } = useMacs();
  const { histories, reads, refreshing } = inbox(useShallow((state) => state));
  const macs = useMemo(
    () =>
      connections.map((c) => ({
        id: c.mac.id,
        name: c.mac.name,
        history: histories[c.mac.id] ?? null,
        read: reads[c.mac.id] ?? null,
      })),
    [connections, histories, reads],
  );
  const items = useMemo(() => inboxItems(macs, filters), [macs, filters]);
  const unread = useMemo(() => inboxItems(macs, NO_FILTERS).filter((item) => !item.read).length, [macs]);
  const supported = macs.some((mac) => mac.history !== null) || connections.some((c) => keepsHistory(c.state));

  const refresh = useCallback(() => {
    const pending = connections.flatMap(({ mac, state, connection }) =>
      keepsHistory(state) && connection ? [list(mac.id, connection)] : [],
    );
    inbox.setState({ refreshing: true });
    void Promise.all(pending).finally(() => inbox.setState({ refreshing: false }));
  }, [connections]);

  const markItemRead = useCallback(
    (item: InboxItem) => markNotificationRead(item.macId, { notification: item.seq }),
    [],
  );

  const markEverythingRead = useCallback(() => {
    for (const mac of macs) {
      if (mac.history) saveRead(mac.id, markAllRead(readStateOf(mac.id, mac.history.log), mac.history.cursor));
    }
  }, [macs]);

  return { supported, items, unread, refreshing, refresh, markRead: markItemRead, markAllRead: markEverythingRead };
}
