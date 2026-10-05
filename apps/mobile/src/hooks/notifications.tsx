import { t } from '@lingui/core/macro';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { create } from 'zustand';

import { useAppForeground } from '@/hooks/app-foreground';
import { markNotificationRead } from '@/hooks/inbox';
import { toAttentionMachine, useMacs } from '@/hooks/machines';
import { RequestError, type StimConnection } from '@/lib/connection';
import { NOTIFY_STATE_KEY } from '@/lib/derived-data';
import {
  DEFAULT_PREFS,
  localNotifications,
  notifiedCategories,
  notificationRoute,
  parsePrefs,
  type NotificationPrefs,
  type NotifyState,
} from '@/lib/notifications';
import type { PushRegisterParams } from '@/protocol/types';
import { notificationStorage as storage } from '@/storage';

const PREFS_KEY = 'prefs';
const HANDLED_KEY = 'handledResponse';
const CHANNEL = 'attention';
const QUIET_CHANNEL = 'updates';
const TICK_MS = 30_000;
/** Stim Dev has no APNs credentials, so it notifies only locally unless Metro starts with STIM_DEV_PUSH=1. */
const PUSH_ENABLED = Platform.OS === 'ios' && Constants.expoConfig?.extra?.push === true;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const { content } = notification.request;
    const quiet = 'interruptionLevel' in content && content.interruptionLevel === 'passive';
    const { sound } = content;
    return {
      shouldShowBanner: !quiet,
      shouldShowList: true,
      shouldPlaySound: !quiet && !!sound,
      shouldSetBadge: false,
    };
  },
});

async function createChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: t`Alerts`,
    importance: AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync(QUIET_CHANNEL, {
    name: t`Silent`,
    importance: AndroidImportance.LOW,
  });
}

const localMinuteOfDay = (now: number) => {
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
};

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
    return JSON.parse(storage.getString(NOTIFY_STATE_KEY) ?? '{}') as NotifyState;
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
    await createChannels();
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        t`Notifications are off for Stim`,
        t`Allow them in Settings to get notified when something needs attention.`,
        [
          { text: t`Not now`, style: 'cancel' },
          { text: t`Open Settings`, onPress: () => void Linking.openSettings() },
        ],
      );
      return;
    }
    storage.remove(NOTIFY_STATE_KEY);
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

const PUSHED_PREFIX = 'pushed:';
const TOKEN_KEY = 'pushToken';

interface PushState {
  /** The Macs that accepted a registration, starting from the ones that did before so a relaunch does not notify what they push. */
  pushed: readonly string[];
  /** Per Mac, the connection state and registration last sent, so each is sent once per connection. */
  sent: Readonly<Record<string, { state: unknown; key: string }>>;
  forgotten: readonly string[];
}

const pushStore = create<PushState>(() => ({
  pushed: PUSH_ENABLED
    ? storage
        .getAllKeys()
        .filter((key) => key.startsWith(PUSHED_PREFIX))
        .map((key) => key.slice(PUSHED_PREFIX.length))
    : [],
  sent: {},
  forgotten: [],
}));

const setPushed = (id: string, pushed: boolean) =>
  pushStore.setState((state) =>
    state.pushed.includes(id) === pushed
      ? state
      : { pushed: pushed ? [...state.pushed, id] : state.pushed.filter((other) => other !== id) },
  );

const setSent = (id: string, sent: { state: unknown; key: string } | undefined) =>
  pushStore.setState((state) => {
    const { [id]: _previous, ...rest } = state.sent;
    return { sent: sent ? { ...rest, [id]: sent } : rest };
  });

/** The machines that push this phone's notifications, as a comma-joined list that changes with the set. */
const usePushedMacs = (): string => pushStore((state) => state.pushed.join(','));

function LocalNotifier({ prefs }: { prefs: NotificationPrefs }) {
  const { connections } = useMacs();
  const pushed = usePushedMacs();
  const [tick, setTick] = useState(0);
  const awakeSince = useRef(0);
  useEffect(() => {
    void createChannels().catch(() => {});
    awakeSince.current = Date.now();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') awakeSince.current = Date.now();
    });
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => {
      listener.remove();
      clearInterval(timer);
    };
  }, []);

  const active = useAppForeground();

  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    const { state, notifications, wakeAt } = localNotifications(
      readState(),
      connections.map((c) => {
        const mac = toAttentionMachine(c);
        return {
          mac,
          live: mac.state.kind === 'open' && mac.status !== null,
          pushed: pushed.split(',').includes(mac.id),
        };
      }),
      prefs,
      now,
      localMinuteOfDay(now),
      awakeSince.current,
    );
    storage.set(NOTIFY_STATE_KEY, JSON.stringify(state));
    for (const { id, title, subtitle, body, quiet, thread, data } of notifications) {
      void Notifications.scheduleNotificationAsync({
        identifier: id,
        content: {
          title,
          ...(subtitle ? { subtitle } : {}),
          body,
          data: { ...data },
          sound: quiet ? false : 'default',
          interruptionLevel: quiet ? 'passive' : 'active',
          ...(thread ? { threadIdentifier: thread } : {}),
        },
        trigger: Platform.OS === 'android' ? { channelId: quiet ? QUIET_CHANNEL : CHANNEL } : null,
      }).catch(() => {});
    }
    if (wakeAt === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, wakeAt - now));
    return () => clearTimeout(timer);
  }, [connections, prefs, pushed, active, tick]);

  return null;
}

/** Asks the Mac to stop pushing to this phone, before this phone forgets it. */
export function unregisterPush(connection: StimConnection | null, macId: string): void {
  pushStore.setState((state) => ({ forgotten: [...state.forgotten, macId] }));
  setPushed(macId, false);
  setSent(macId, undefined);
  storage.remove(`${PUSHED_PREFIX}${macId}`);
  connection?.request('push.unregister', {}).catch(() => {});
}

function PushRegistration({ prefs }: { prefs: NotificationPrefs }) {
  const { connections } = useMacs();
  const [token, setToken] = useState<string | null>(() => storage.getString(TOKEN_KEY) ?? null);
  const events = prefs.enabled ? notifiedCategories(prefs) : [];
  const pushWanted = PUSH_ENABLED && events.length > 0;
  const { stuckMinutes, quietHours } = prefs;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wanted =
    pushWanted && token !== null
      ? JSON.stringify({
          token,
          events,
          levels: Object.fromEntries(events.map((event) => [event, prefs.levels[event]])),
          stuckMinutes,
          ...(quietHours ? { quietHours: { ...quietHours, timeZone } } : {}),
        })
      : null;
  const anyOpen = connections.some((c) => c.state.kind === 'open');

  const fetched = useRef(false);

  useEffect(() => {
    if (!pushWanted) return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const save = (next: string) => {
      storage.set(TOKEN_KEY, next);
      setToken(next);
    };
    const listener = Notifications.addPushTokenListener((devicePushToken) => {
      Notifications.getExpoPushTokenAsync({ projectId, devicePushToken }).then(
        (result) => save(result.data),
        () => {},
      );
    });
    if (anyOpen && !fetched.current) {
      fetched.current = true;
      Notifications.getExpoPushTokenAsync({ projectId }).then(
        (result) => save(result.data),
        () => {
          fetched.current = false;
        },
      );
    }
    return () => listener.remove();
  }, [pushWanted, anyOpen]);

  useEffect(() => {
    for (const { mac, state, connection } of connections) {
      if (state.kind !== 'open' || !connection || pushStore.getState().forgotten.includes(mac.id)) continue;
      if (pushWanted && wanted === null) continue;
      const key = `${wanted}`;
      const last = pushStore.getState().sent[mac.id];
      if (last && last.state === state && last.key === key) continue;
      setSent(mac.id, { state, key });
      const current = () =>
        !pushStore.getState().forgotten.includes(mac.id) && pushStore.getState().sent[mac.id]?.key === key;
      if (wanted === null) {
        const registered = storage.contains(`${PUSHED_PREFIX}${mac.id}`);
        setPushed(mac.id, false);
        if (!registered) continue;
        connection.request('push.unregister', {}).then(
          () => current() && storage.remove(`${PUSHED_PREFIX}${mac.id}`),
          () => {},
        );
        continue;
      }
      const params = JSON.parse(wanted) as Omit<PushRegisterParams, 'ref'>;
      connection.request('push.register', { ...params, ref: mac.id }).then(
        () => {
          if (!current()) return;
          storage.set(`${PUSHED_PREFIX}${mac.id}`, true);
          setPushed(mac.id, true);
        },
        (cause: Error) => {
          if (!current() || !(cause instanceof RequestError)) return;
          storage.remove(`${PUSHED_PREFIX}${mac.id}`);
          setPushed(mac.id, false);
          if (cause.error.code === 'bad-request') connection.request('push.unregister', {}).catch(() => {});
        },
      );
    }
  }, [connections, wanted, pushWanted]);

  return null;
}

function NotificationTaps() {
  const router = useRouter();
  const { macs } = useMacs();
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!response || macs === null) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = `${response.notification.request.identifier}@${response.notification.date}`;
    if (storage.getString(HANDLED_KEY) === id) return;
    storage.set(HANDLED_KEY, id);
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    const route = notificationRoute(
      data,
      macs.map((mac) => mac.id),
    );
    if (typeof data.ref === 'string') markNotificationRead(data.ref, data);
    if ('url' in route) void Linking.openURL(route.url);
    else if (route.pathname === '/') router.navigate('/');
    else router.push(route);
  }, [response, macs, router]);

  return null;
}
