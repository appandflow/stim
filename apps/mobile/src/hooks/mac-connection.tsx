import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { StimConnection, type ConnectionState } from '@/lib/connection';
import { listMacs, macToken, type PairedMac } from '@/lib/macs';
import type {
  ActionName,
  ActionParams,
  FrameEvent,
  LogFilter,
  LogRecord,
  Platform,
  StatusPayload,
} from '@/protocol/types';

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
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') connection.retryNow();
    });
    return () => listener.remove();
  }, [connection]);

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

export type LogsChange =
  | { kind: 'reset' }
  | { kind: 'records'; records: LogRecord[] }
  | { kind: 'error'; message: string };

export function useLogs(filter: LogFilter | null, onChange: (change: LogsChange) => void): void {
  const { connection } = useMacConnection();
  const key = filter ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (!connection || !key) return;
    onChange({ kind: 'reset' });
    return connection.subscribe(
      'logs.subscribe',
      JSON.parse(key) as LogFilter,
      (event) => {
        if (event.event === 'logs') onChange({ kind: 'records', records: event.records });
        if (event.event === 'error') onChange({ kind: 'error', message: event.error.message });
      },
      () => onChange({ kind: 'reset' }),
    );
  }, [connection, key, onChange]);
}

interface FrameState {
  key: string;
  frame: FrameEvent | null;
  error: string | null;
  delayed: boolean;
}

const EMPTY_FRAME_STATE: Omit<FrameState, 'key'> = { frame: null, error: null, delayed: false };

export function useFrame(
  workspace: string,
  platform: 'ios' | 'android',
  slot: string,
  enabled: boolean,
): { frame: FrameEvent | null; error: string | null; delayed: boolean } {
  const { connection } = useMacConnection();
  const [latest, setLatest] = useState<FrameState | null>(null);
  const key = connection && enabled ? `${workspace}\n${platform}\n${slot}` : null;
  useEffect(() => {
    if (!connection || key === null) return;
    return connection.subscribe('frames.subscribe', { workspace, platform, slot }, (event) => {
      setLatest((prev) => {
        const base = prev && prev.key === key ? prev : { key, ...EMPTY_FRAME_STATE };
        if (event.event === 'frame') return { key, frame: event, error: null, delayed: false };
        if (event.event === 'frame-delayed') return { ...base, key, delayed: event.delayed };
        if (event.event === 'error') return { key, frame: null, error: event.error.message, delayed: false };
        return base;
      });
    });
  }, [connection, key, workspace, platform, slot]);
  return latest && latest.key === key ? latest : EMPTY_FRAME_STATE;
}

const NO_ACTIONS: ActionName[] = [];

export interface WorkspaceActions {
  /** The actions this Mac lets this phone run; empty for a read-only pairing. */
  available: ActionName[];
  pending: ActionName | null;
  error: string | null;
  /** Resolves true when the action succeeded; a failure sets `error`. */
  run: (action: ActionName, options?: { platform?: Platform }) => Promise<boolean>;
}

export function useAction(workspace: string): WorkspaceActions {
  const { connection, state } = useMacConnection();
  const [pending, setPending] = useState<ActionName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: ActionName, options: { platform?: Platform } = {}) => {
      if (!connection) {
        setError('Not connected.');
        return false;
      }
      const params: ActionParams =
        action === 'reload'
          ? { action, workspace, ...(options.platform ? { platform: options.platform } : {}) }
          : { action, workspace };
      setPending(action);
      setError(null);
      try {
        await connection.request('action', params);
        return true;
      } catch (cause) {
        setError((cause as Error).message);
        return false;
      } finally {
        setPending(null);
      }
    },
    [connection, workspace],
  );
  return { available: state.kind === 'open' ? state.actions : NO_ACTIONS, pending, error, run };
}
