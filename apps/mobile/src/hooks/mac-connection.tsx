import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { createMMKV } from 'react-native-mmkv';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { RequestError, StimConnection } from '@/lib/connection';
import type { HomeItem } from '@/lib/home';
import { createMachineStore, IDLE_LINK, type MachineLink, type MachinesState } from '@/lib/machine-store';
import { listMacs, macToken, type PairedMac } from '@/lib/macs';
import { PlanChecks, type PlanSnapshot, type PlanState } from '@/lib/plan-checks';
import { StatusCache } from '@/lib/status-cache';
import type {
  ActionName,
  ActionParams,
  DevicePosture,
  FrameEvent,
  InputButton,
  LogFilter,
  LogRecord,
  MachineUsage,
  Methods,
  Platform,
  RotateDirection,
  StatusPayload,
  TouchPhase,
} from '@/protocol/types';

export const CLIENT = { name: 'stim-mobile', version: Constants.expoConfig?.version ?? '0.0.0' };

const USAGE_INTERVAL_MS = 15_000;
const SNAPSHOT_EDGE = 640;
const MAX_INPUT_TEXT = 256;

const machines = createMachineStore({ cache: new StatusCache(createMMKV({ id: 'stim.status' })) });
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
      if (event.event === 'status') machines.receiveStatus(mac.id, event.payload);
    });
  }, [connection, mac.id]);

  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    const poll = () =>
      connection.request('machine.get', {}).then(
        (usage) => !cancelled && machines.setUsage(mac.id, usage),
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
  }, [connection, open, mac.id]);

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

export function useMachineLink(macId: string): MachineLink {
  return useMachines((state) => state.links[macId] ?? IDLE_LINK);
}

export interface MachinePresence {
  online: boolean;
  /** Whether the machine's status is the cached one, not yet replaced by a live status. */
  cached: boolean;
  /** When the machine was last known connected: the drop, or the cached status's time. */
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
        lastSeenAt: link?.disconnectedAt ?? cachedSeenAt,
      };
    }),
  );
}

/** Every workspace of every machine, in home's order, from the pairings or, before they load, the cache. */
export function useWorkspaceItems(): HomeItem[] {
  return useMachines((state) => state.workspaces);
}

/** One workspace's item, undefined while its machine has no status or no longer lists it. */
export function useWorkspace(macId: string, path: string): HomeItem | undefined {
  const key = `${macId}\n${path}`;
  return useMachines((state) => state.workspaces.find((item) => item.key === key));
}

export function useHasStatus(macId: string): boolean {
  return useMachines((state) => macId in state.snapshots);
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

/** `hint` asks for up to `fps` frames a second, scaled to fit `maxEdge` pixels; the server defaults to 5 and 1280. */
export function useFrame(
  workspace: string,
  platform: 'ios' | 'android',
  slot: string,
  enabled: boolean,
  hint: { fps?: number; maxEdge?: number } = {},
): { frame: FrameEvent | null; error: string | null; delayed: boolean } {
  const { connection } = useMacConnection();
  const [latest, setLatest] = useState<FrameState | null>(null);
  const { fps, maxEdge } = hint;
  const key = connection && enabled ? `${workspace}\n${platform}\n${slot}\n${fps}\n${maxEdge}` : null;
  useEffect(() => {
    if (!connection || key === null) return;
    const params = { workspace, platform, slot, ...(fps ? { fps } : {}), ...(maxEdge ? { maxEdge } : {}) };
    return connection.subscribe('frames.subscribe', params, (event) => {
      setLatest((prev) => {
        const base = prev && prev.key === key ? prev : { key, ...EMPTY_FRAME_STATE };
        if (event.event === 'frame') return { key, frame: event, error: null, delayed: false };
        if (event.event === 'frame-delayed') return { ...base, key, delayed: event.delayed };
        if (event.event === 'error') return { key, frame: null, error: event.error.message, delayed: false };
        return base;
      });
    });
  }, [connection, key, workspace, platform, slot, fps, maxEdge]);
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
        if (cause instanceof RequestError && cause.error.code === 'forbidden') connection.reconnect();
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
      unsubscribe = connection.subscribe(
        'frames.subscribe',
        { workspace, platform, slot, maxEdge: SNAPSHOT_EDGE },
        (event) => {
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
        },
      );
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

const planChecks = new WeakMap<StimConnection, PlanChecks>();
const NO_PLANS: PlanSnapshot = new Map();
const noSubscription = () => () => {};

/**
 * `build.plan` for each platform in `builds` (platform to `planKey` of its last build), checked while the
 * calling screen is mounted and no build runs. It builds nothing, so a read-only pairing may ask.
 */
export function useBuildPlans(
  workspace: string,
  builds: Partial<Record<Platform, string>>,
  building: boolean,
): (platform: Platform) => PlanState | undefined {
  const { checks, snapshot } = usePlanChecks();
  const open = useMacConnection().state.kind === 'open';
  const wanted = JSON.stringify(builds);
  useEffect(() => {
    if (!checks) return;
    if (building) checks.cancel(workspace);
    else checks.check(workspace, JSON.parse(wanted) as Partial<Record<Platform, string>>);
  }, [checks, workspace, wanted, building, open]);
  useEffect(() => () => checks?.cancel(workspace), [checks, workspace]);
  return (platform) => PlanChecks.state(snapshot, workspace, platform);
}

/**
 * The last `build.plan` result for `workspace` and `platform` and when it settled, without asking for one.
 * `recheck` asks again for the build `buildKey`, the `planKey` of the platform's last build.
 */
export function useBuildPlan(
  workspace: string,
  platform: Platform,
  buildKey: string,
  building: boolean,
): { plan: PlanState | undefined; checkedAt: number | null; recheck: (() => void) | null } {
  const { checks, snapshot } = usePlanChecks();
  const recheck = useCallback(
    () => checks?.check(workspace, { [platform]: buildKey }, true),
    [checks, workspace, platform, buildKey],
  );
  return {
    plan: PlanChecks.state(snapshot, workspace, platform),
    checkedAt: PlanChecks.checkedAt(snapshot, workspace, platform),
    recheck: checks && !building ? recheck : null,
  };
}

function usePlanChecks(): { checks: PlanChecks | null; snapshot: PlanSnapshot } {
  const { connection } = useMacConnection();
  const checks = useMemo(() => {
    if (!connection) return null;
    let found = planChecks.get(connection);
    if (!found) {
      found = new PlanChecks((path, platform) => connection.request('build.plan', { workspace: path, platform }));
      planChecks.set(connection, found);
    }
    return found;
  }, [connection]);
  const snapshot = useSyncExternalStore(checks?.subscribe ?? noSubscription, checks?.snapshot ?? (() => NO_PLANS));
  return { checks, snapshot };
}

export type ControlState =
  | { kind: 'off'; ended?: string }
  | { kind: 'starting' }
  | { kind: 'on'; session: string; leaseSince: string | null; postures: DevicePosture[] }
  | { kind: 'busy'; message: string }
  | { kind: 'failed'; message: string };

export interface DeviceControl {
  /** Whether this pairing may control devices: null while not connected. */
  allowed: boolean | null;
  state: ControlState;
  begin: (takeOver?: boolean) => void;
  end: () => void;
  touch: (phase: TouchPhase, x: number, y: number) => void;
  text: (text: string) => void;
  button: (button: InputButton) => void;
  rotate: (direction: RotateDirection) => void;
  /** Rejects with the server's reason; a Duo fold takes a few seconds to settle. */
  posture: (posture: DevicePosture) => Promise<void>;
}

type HeldState =
  | ControlState
  | { kind: 'on'; session: string; leaseSince: string | null; postures: DevicePosture[]; link: unknown };

/**
 * A control session on one device. It ends when the screen unmounts, when the connection drops (the server
 * ends a disconnected client's sessions), and when the server ends it; input sent while no session is on is
 * dropped.
 */
export function useDeviceControl(workspace: string, platform: Platform, slot: string): DeviceControl {
  const { connection, state: link } = useMacConnection();
  const allowed = link.kind === 'open' ? link.capabilities.includes('control') : null;
  const [held, setHeld] = useState<HeldState>({ kind: 'off' });
  const state: ControlState =
    held.kind === 'on' && 'link' in held && held.link !== link
      ? { kind: 'off', ended: 'The connection dropped.' }
      : held;
  const session = state.kind === 'on' ? state.session : null;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!connection || !session) return;
    const stop = connection.onControlEnded((event) => {
      if (event.session !== session) return;
      setHeld({ kind: 'off', ended: event.message });
      if (event.reason === 'forbidden') connection.reconnect();
    });
    return () => {
      stop();
      connection.request('control.end', { session }).catch(() => {});
    };
  }, [connection, session]);

  const begin = useCallback(
    (takeOver = false) => {
      if (!connection) return;
      setHeld({ kind: 'starting' });
      connection.request('control.begin', { workspace, platform, slot, ...(takeOver ? { takeOver } : {}) }).then(
        (result) =>
          setHeld({
            kind: 'on',
            session: result.session,
            leaseSince: result.lease?.grantedAt ?? null,
            postures: result.postures,
            link,
          }),
        (cause: Error) => {
          const code = cause instanceof RequestError ? cause.error.code : null;
          if (code === 'device-busy') return setHeld({ kind: 'busy', message: cause.message });
          if (code !== 'forbidden') return setHeld({ kind: 'failed', message: cause.message });
          setHeld({ kind: 'off' });
          connection.reconnect();
        },
      );
    },
    [connection, link, workspace, platform, slot],
  );
  const end = useCallback(() => setHeld({ kind: 'off' }), []);
  const send = useCallback(
    <M extends 'input.touch' | 'input.text' | 'input.button' | 'input.rotate'>(
      method: M,
      params: Omit<Methods[M]['params'], 'session'>,
    ) => {
      if (!connection || !session) return;
      connection.request(method, { session, ...params } as Methods[M]['params']).catch(() => {});
    },
    [connection, session],
  );
  const touch = useCallback((phase: TouchPhase, x: number, y: number) => send('input.touch', { phase, x, y }), [send]);
  const text = useCallback(
    (value: string) => {
      for (let at = 0; at < value.length; at += MAX_INPUT_TEXT) {
        send('input.text', { text: value.slice(at, at + MAX_INPUT_TEXT) });
      }
    },
    [send],
  );
  const button = useCallback((value: InputButton) => send('input.button', { button: value }), [send]);
  const rotate = useCallback((direction: RotateDirection) => send('input.rotate', { direction }), [send]);
  const posture = useCallback(
    async (value: DevicePosture) => {
      if (!connection || !session) return;
      await connection.request('input.posture', { session, posture: value });
    },
    [connection, session],
  );
  return { allowed, state, begin, end, touch, text, button, rotate, posture };
}
