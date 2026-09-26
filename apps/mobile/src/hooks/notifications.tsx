import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { toAttentionMachine, useMacs } from '@/hooks/mac-connection';
import { homeAttention } from '@/lib/attention';
import { RequestError } from '@/lib/connection';
import {
  DEFAULT_PREFS,
  localNotifications,
  notificationRoute,
  parsePrefs,
  PUSH_EVENTS,
  type NotificationPrefs,
  type NotifyState,
} from '@/lib/notifications';
import type { PushEvent } from '@/protocol/types';

const storage = createMMKV({ id: 'stim.notifications' });
const PREFS_KEY = 'prefs';
const STATE_KEY = 'state';
const HANDLED_KEY = 'handledResponse';
const CHANNEL = 'attention';
const TICK_MS = 30_000;
/** Stim Dev has no APNs credentials, so it notifies only locally unless Metro starts with STIM_DEV_PUSH=1. */
const PUSH_ENABLED = Platform.OS === 'ios' && Constants.expoConfig?.extra?.push === true;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

interface NotificationsValue {
  prefs: NotificationPrefs;
  /** Turns notifications on, asking for permission first; stays off when it is refused. */
  enable: () => Promise<void>;
  update: (patch: Partial<Omit<NotificationPrefs, 'enabled'>> & { enabled?: false }) => void;
}

const Context = createContext<NotificationsValue>({
  prefs: DEFAULT_PREFS,
  enable: async () => {},
  update: () => {},
});

function readState(): NotifyState {
  try {
    return JSON.parse(storage.getString(STATE_KEY) ?? '{}') as NotifyState;
  } catch {
    return {};
  }
}

/** Notification settings, local notifications while the app is open, push registration, and notification taps. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState(() => parsePrefs(storage.getString(PREFS_KEY)));

  const save = useCallback((next: NotificationPrefs) => {
    setPrefs(next);
    storage.set(PREFS_KEY, JSON.stringify(next));
  }, []);

  const enable = useCallback(async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Needs attention',
        importance: AndroidImportance.HIGH,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Notifications are off for Stim',
        'Allow them in Settings to get notified when something needs attention.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ],
      );
      return;
    }
    storage.remove(STATE_KEY);
    save({ ...parsePrefs(storage.getString(PREFS_KEY)), enabled: true });
  }, [save]);

  const update = useCallback<NotificationsValue['update']>(
    (patch) => save({ ...parsePrefs(storage.getString(PREFS_KEY)), ...patch }),
    [save],
  );

  const value = useMemo(() => ({ prefs, enable, update }), [prefs, enable, update]);
  return (
    <Context.Provider value={value}>
      {prefs.enabled ? <LocalNotifier prefs={prefs} /> : null}
      <PushRegistration prefs={prefs} />
      <NotificationTaps />
      {children}
    </Context.Provider>
  );
}

export function useNotificationPrefs(): NotificationsValue {
  return useContext(Context);
}

const pushedMacs = new Set<string>();
const pushListeners = new Set<() => void>();
const setPushed = (id: string, pushed: boolean) => {
  if (pushedMacs.has(id) === pushed) return;
  if (pushed) pushedMacs.add(id);
  else pushedMacs.delete(id);
  for (const listener of pushListeners) listener();
};

/** The machines that push this phone's notifications, as a comma-joined list that changes with the set. */
function usePushedMacs(): string {
  const [pushed, setPushedList] = useState(() => [...pushedMacs].join(','));
  useEffect(() => {
    const listener = () => setPushedList([...pushedMacs].join(','));
    pushListeners.add(listener);
    return () => void pushListeners.delete(listener);
  }, []);
  return pushed;
}

function LocalNotifier({ prefs }: { prefs: NotificationPrefs }) {
  const { connections } = useMacs();
  const pushed = usePushedMacs();
  const [tick, setTick] = useState(0);
  const awakeSince = useRef(0);
  const [active, setActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    awakeSince.current = Date.now();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') awakeSince.current = Date.now();
      setActive(state === 'active');
    });
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => {
      listener.remove();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    const machines = connections.map(toAttentionMachine);
    const { state, notifications, wakeAt } = localNotifications(
      readState(),
      homeAttention(machines, now),
      machines.map((mac) => ({
        id: mac.id,
        live: mac.state.kind === 'open' && mac.status !== null,
        pushed: pushed.split(',').includes(mac.id),
      })),
      prefs,
      now,
      awakeSince.current,
    );
    storage.set(STATE_KEY, JSON.stringify(state));
    for (const { title, subtitle, body, data } of notifications) {
      void Notifications.scheduleNotificationAsync({
        content: { title, ...(subtitle ? { subtitle } : {}), body, data: { ...data }, sound: 'default' },
        trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
      }).catch(() => {});
    }
    if (wakeAt === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, wakeAt - now));
    return () => clearTimeout(timer);
  }, [connections, prefs, pushed, active, tick]);

  return null;
}

function PushRegistration({ prefs }: { prefs: NotificationPrefs }) {
  const { connections } = useMacs();
  const [token, setToken] = useState<string | null>(null);
  const sent = useRef(new Map<string, unknown>());
  const events = prefs.enabled
    ? prefs.events.filter((e): e is PushEvent => (PUSH_EVENTS as readonly string[]).includes(e))
    : [];
  const wanted =
    events.length > 0 && token !== null ? JSON.stringify({ token, events, agentOnly: prefs.agentOnly }) : null;

  useEffect(() => {
    if (!PUSH_ENABLED || !prefs.enabled || token) return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    Notifications.getExpoPushTokenAsync({ projectId }).then(
      (result) => setToken(result.data),
      () => {},
    );
  }, [prefs.enabled, token]);

  useEffect(() => {
    for (const { mac, state, connection } of connections) {
      if (state.kind !== 'open' || !connection) continue;
      const key = `${wanted}`;
      const last = sent.current.get(mac.id) as { state: unknown; key: string } | undefined;
      if (last && last.state === state && last.key === key) continue;
      sent.current.set(mac.id, { state, key });
      const registered = storage.getBoolean(`pushed:${mac.id}`) ?? false;
      if (wanted === null) {
        setPushed(mac.id, false);
        if (!registered) continue;
        connection.request('push.unregister', {}).then(
          () => storage.remove(`pushed:${mac.id}`),
          () => {},
        );
        continue;
      }
      const params = JSON.parse(wanted) as { token: string; events: PushEvent[]; agentOnly: boolean };
      connection.request('push.register', { ...params, ref: mac.id }).then(
        () => {
          storage.set(`pushed:${mac.id}`, true);
          setPushed(mac.id, true);
        },
        (cause: Error) => {
          if (cause instanceof RequestError) setPushed(mac.id, false);
        },
      );
    }
  }, [connections, wanted]);

  return null;
}

function NotificationTaps() {
  const router = useRouter();
  const { macs } = useMacs();
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!response || macs === null) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (storage.getString(HANDLED_KEY) === id) return;
    storage.set(HANDLED_KEY, id);
    const route = notificationRoute(
      response.notification.request.content.data,
      macs.map((mac) => mac.id),
    );
    if (route.pathname === '/') router.navigate('/');
    else router.push(route);
  }, [response, macs, router]);

  return null;
}
