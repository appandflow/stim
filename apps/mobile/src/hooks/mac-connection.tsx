import Constants from 'expo-constants';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { StimConnection, type ConnectionState } from '@/lib/connection';
import { listMacs, macToken, type PairedMac } from '@/lib/macs';
import type { FrameEvent, LogFilter, LogRecord, StatusPayload } from '@/protocol/types';

export const CLIENT = { name: 'stim-mobile', version: Constants.expoConfig?.version ?? '0.0.0' };

interface MacConnection {
  mac: PairedMac | null;
  connection: StimConnection | null;
  state: ConnectionState;
  missing: boolean;
  status: StatusPayload | null;
}

const Context = createContext<MacConnection>({
  mac: null,
  connection: null,
  state: { kind: 'connecting' },
  missing: false,
  status: null,
});

interface Entry {
  id: string;
  mac: PairedMac | null;
  connection: StimConnection | null;
  state: ConnectionState;
  missing: boolean;
}

/** Holds one connection for the Mac the current route names; `id` null closes it. */
export function MacConnectionProvider({ id, children }: { id: string | null; children: ReactNode }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [status, setStatus] = useState<{ connection: StimConnection; payload: StatusPayload } | null>(null);

  useEffect(() => {
    if (id === null) return;
    let connection: StimConnection | null = null;
    let cancelled = false;
    (async () => {
      const mac = (await listMacs()).find((m) => m.id === id) ?? null;
      const token = mac ? await macToken(mac.id) : null;
      if (cancelled) return;
      if (!mac || !token) {
        setEntry({ id, mac, connection: null, state: { kind: 'closed' }, missing: true });
        return;
      }
      const created = new StimConnection({
        endpoint: mac.endpoint,
        auth: { deviceToken: token },
        client: CLIENT,
        onState: (state) => setEntry((e) => (e?.connection === created ? { ...e, state } : e)),
      });
      connection = created;
      setEntry({ id, mac, connection: created, state: { kind: 'connecting' }, missing: false });
      created.start();
    })();
    return () => {
      cancelled = true;
      connection?.close();
    };
  }, [id]);

  const current = entry && entry.id === id ? entry : null;
  const connection = current?.connection ?? null;
  useEffect(() => {
    if (!connection) return;
    return connection.subscribe('status.subscribe', {}, (event) => {
      if (event.event === 'status') setStatus({ connection, payload: event.payload });
    });
  }, [connection]);

  const value: MacConnection = {
    mac: current?.mac ?? null,
    connection,
    state: current?.state ?? { kind: id ? 'connecting' : 'closed' },
    missing: current?.missing ?? false,
    status: status && status.connection === connection ? status.payload : null,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMacConnection(): MacConnection {
  return useContext(Context);
}

export function useStatus(): StatusPayload | null {
  return useContext(Context).status;
}

export function useLogs(filter: LogFilter | null, append: (records: LogRecord[], reset: boolean) => void): void {
  const { connection } = useMacConnection();
  const key = filter ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (!connection || !key) return;
    append([], true);
    return connection.subscribe('logs.subscribe', JSON.parse(key) as LogFilter, (event) => {
      if (event.event === 'logs') append(event.records, false);
    });
  }, [connection, key, append]);
}

export function useFrame(workspace: string, platform: 'ios' | 'android', slot: string, enabled: boolean) {
  const { connection } = useMacConnection();
  const [frame, setFrame] = useState<FrameEvent | null>(null);
  useEffect(() => {
    if (!connection || !enabled) return;
    return connection.subscribe('frames.subscribe', { workspace, platform, slot }, (event) => {
      if (event.event === 'frame') setFrame(event);
    });
  }, [connection, workspace, platform, slot, enabled]);
  return frame;
}
