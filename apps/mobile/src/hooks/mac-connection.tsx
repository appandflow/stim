import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { RequestError, StimConnection, type ConnectionState } from '@/lib/connection';
import { listMacs, macToken, type PairedMac } from '@/lib/macs';
import type {
  ActionName,
  ActionParams,
  FrameEvent,
  LogFilter,
  LogRecord,
  MachineUsage,
  Platform,
  StatusPayload,
} from '@/protocol/types';

export const CLIENT = { name: 'stim-mobile', version: Constants.expoConfig?.version ?? '0.0.0' };

const USAGE_INTERVAL_MS = 15_000;

export interface MacConnection {
  mac: PairedMac | null;
  connection: StimConnection | null;
  state: ConnectionState;
  missing: boolean;
  status: StatusPayload | null;
  usage: MachineUsage | null;
  /** The Mac's home folder, from `hello`; null until connected or from an older server. */
  home: string | null;
}

interface Live {
  connection: StimConnection | null;
  state: ConnectionState;
  missing: boolean;
  status: StatusPayload | null;
  usage: MachineUsage | null;
  home: string | null;
}

const IDLE: Live = {
  connection: null,
  state: { kind: 'connecting' },
  missing: false,
  status: null,
  usage: null,
  home: null,
};

interface Pool {
  macs: PairedMac[] | null;
  live: Record<string, Live>;
  reload: () => void;
}

const Context = createContext<Pool>({ macs: null, live: {}, reload: () => {} });

type Update = (id: string, patch: Partial<Live> | null) => void;

function MacLink({ mac, update }: { mac: PairedMac; update: Update }) {
  const [connection, setConnection] = useState<StimConnection | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let created: StimConnection | null = null;
    let cancelled = false;
    (async () => {
      const token = await macToken(mac.id);
      if (cancelled) return;
      if (!token) {
        update(mac.id, { missing: true, state: { kind: 'closed' } });
        return;
      }
      const next = new StimConnection({
        endpoint: mac.endpoint,
        auth: { deviceToken: token },
        client: CLIENT,
        onState: (state) => {
          if (cancelled) return;
          setOpen(state.kind === 'open');
          update(mac.id, state.kind === 'open' ? { state, home: state.server.home ?? null } : { state });
        },
      });
      created = next;
      setConnection(next);
      update(mac.id, { connection: next, missing: false, state: { kind: 'connecting' } });
      next.start();
    })();
    return () => {
      cancelled = true;
      created?.close();
      update(mac.id, null);
    };
  }, [mac.id, mac.endpoint, update]);

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
      if (event.event === 'status') update(mac.id, { status: event.payload });
    });
  }, [connection, mac.id, update]);

  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    const poll = () =>
      connection.request('machine.get', {}).then(
        (usage) => !cancelled && update(mac.id, { usage }),
        (error: Error) => {
          if (error instanceof RequestError && error.error.code === 'unknown-method') clearInterval(timer);
        },
      );
    const timer = setInterval(poll, USAGE_INTERVAL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, open, mac.id, update]);

  return null;
}

export function MacsProvider({ children }: { children: ReactNode }) {
  const [macs, setMacs] = useState<PairedMac[] | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});

  const reload = useCallback(() => {
    listMacs().then(setMacs, () => setMacs([]));
  }, []);
  useEffect(reload, [reload]);

  const update = useCallback<Update>((id, patch) => {
    setLive((all) => {
      if (patch) return { ...all, [id]: { ...(all[id] ?? IDLE), ...patch } };
      const { [id]: _removed, ...rest } = all;
      return rest;
    });
  }, []);

  const value = useMemo(() => ({ macs, live, reload }), [macs, live, reload]);
  return (
    <Context.Provider value={value}>
      {(macs ?? []).map((mac) => (
        <MacLink key={`${mac.id}\n${mac.endpoint}\n${mac.pairedAt}`} mac={mac} update={update} />
      ))}
      {children}
    </Context.Provider>
  );
}

export type PairedConnection = MacConnection & { mac: PairedMac };

export function useMacs(): { macs: PairedMac[] | null; reload: () => void; connections: PairedConnection[] } {
  const { macs, live, reload } = useContext(Context);
  const connections = useMemo(() => (macs ?? []).map((mac) => ({ mac, ...(live[mac.id] ?? IDLE) })), [macs, live]);
  return { macs, reload, connections };
}

export function useMacById(id: string | undefined): MacConnection {
  const { macs, live } = useContext(Context);
  const mac = macs?.find((m) => m.id === id) ?? null;
  if (!mac) return { ...IDLE, mac: null, missing: macs !== null, state: { kind: macs ? 'closed' : 'connecting' } };
  return { mac, ...(live[mac.id] ?? IDLE) };
}

/** The Mac the current `/mac/[id]/...` route names. */
export function useMacConnection(): MacConnection {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return useMacById(id);
}

export function useStatus(): StatusPayload | null {
  return useMacConnection().status;
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

export interface WorkspaceActions {
  /** The actions this Mac lets this phone run: empty for a read-only pairing, null while not connected or from a server that predates actions. */
  available: ActionName[] | null;
  pending: ActionName | null;
  /** Resolves null when the action succeeded, and the error message when it failed. */
  run: (action: ActionName, options?: { platform?: Platform }) => Promise<string | null>;
}

export function useAction(workspace: string): WorkspaceActions {
  const { connection, state } = useMacConnection();
  const [pending, setPending] = useState<ActionName | null>(null);
  const run = useCallback(
    async (action: ActionName, options: { platform?: Platform } = {}) => {
      if (!connection) return 'Not connected.';
      const params: ActionParams =
        action === 'reload'
          ? { action, workspace, ...(options.platform ? { platform: options.platform } : {}) }
          : { action, workspace };
      setPending(action);
      try {
        await connection.request('action', params);
        return null;
      } catch (cause) {
        return (cause as Error).message;
      } finally {
        setPending(null);
      }
    },
    [connection, workspace],
  );
  return { available: state.kind === 'open' ? state.actions : null, pending, run };
}

/**
 * A device's latest frame, refreshed `intervalMs` after the previous one arrives: it subscribes until one frame
 * arrives, then unsubscribes, so the server's capture loop runs only briefly for each refresh. After an error
 * the delay doubles, up to a minute, until a frame arrives again.
 */
export function useFrameSnapshot(
  connection: StimConnection | null,
  workspace: string,
  platform: 'ios' | 'android',
  slot: string,
  enabled: boolean,
  intervalMs: number,
): { frame: FrameEvent | null; error: string | null } {
  const [latest, setLatest] = useState<{ key: string; frame: FrameEvent | null; error: string | null } | null>(null);
  const key = connection && enabled ? `${workspace}\n${platform}\n${slot}` : null;
  useEffect(() => {
    if (!connection || key === null) return;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let delay = intervalMs;
    const refresh = () => {
      unsubscribe = connection.subscribe('frames.subscribe', { workspace, platform, slot }, (event) => {
        if (event.event !== 'frame' && event.event !== 'error') return;
        if (event.event === 'frame') {
          setLatest({ key, frame: event, error: null });
          delay = intervalMs;
        } else {
          setLatest((prev) => ({ key, frame: prev?.key === key ? prev.frame : null, error: event.error.message }));
          delay = Math.min(delay * 2, 60_000);
        }
        unsubscribe?.();
        unsubscribe = null;
        if (!stopped) timer = setTimeout(refresh, delay);
      });
    };
    refresh();
    return () => {
      stopped = true;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
    };
  }, [connection, key, workspace, platform, slot, intervalMs]);
  return latest && latest.key === key ? latest : { frame: null, error: null };
}
