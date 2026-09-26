import type { HomeAttentionItem, NotifyEvent } from '@/lib/attention';
import { diffAttention, type NotifyEntries } from '@/lib/notify';
import type { PushEvent } from '@/protocol/types';

export const NOTIFY_EVENTS: readonly NotifyEvent[] = [
  'build-failed',
  'log-errors',
  'disk',
  'offline',
  'app-stopped',
  'slow-build',
];

export const PUSH_EVENTS: readonly PushEvent[] = ['build-failed', 'log-errors', 'disk', 'app-stopped', 'slow-build'];

export interface NotificationPrefs {
  enabled: boolean;
  events: NotifyEvent[];
  agentOnly: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = { enabled: false, events: [...NOTIFY_EVENTS], agentOnly: false };

export function parsePrefs(raw: string | undefined): NotificationPrefs {
  try {
    const value = JSON.parse(raw ?? '') as Partial<NotificationPrefs>;
    return {
      enabled: value.enabled === true,
      events: Array.isArray(value.events) ? NOTIFY_EVENTS.filter((e) => value.events!.includes(e)) : [...NOTIFY_EVENTS],
      agentOnly: value.agentOnly === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** What a notification opens, local or pushed; `ref` is the paired machine's id on this phone. */
export interface NotificationData {
  ref: string;
  target: 'home' | 'machine' | 'workspace' | 'logs';
  path?: string;
}

export interface LocalNotification {
  title: string;
  subtitle?: string;
  body: string;
  data: NotificationData;
}

/** Each machine's entries, under `link:<id>` for its connection and `status:<id>` for what its status reports. */
export type NotifyState = Record<string, NotifyEntries>;

export interface NotifyMachine {
  id: string;
  /** Whether `homeAttention` saw this machine's live status, so its absent items are really gone. */
  live: boolean;
  /** Whether the machine pushes this phone's notifications, so the phone stays quiet about what it pushes. */
  pushed: boolean;
}

const SUMMARIZE_ABOVE = 3;

/**
 * The local notifications `items`, home's attention items, owe since `state`. A machine's connection problems
 * are checked always; its status items only while its status is live. A machine whose server pushes records
 * the pushed events without notifying, so it does not notify them again if pushing stops.
 */
export function localNotifications(
  state: NotifyState,
  items: HomeAttentionItem[],
  machines: NotifyMachine[],
  prefs: NotificationPrefs,
  now: number,
  awakeSince: number,
): { state: NotifyState; notifications: LocalNotification[]; wakeAt: number | null } {
  const next: NotifyState = {};
  const due: HomeAttentionItem[] = [];
  let wakeAt: number | null = null;
  const run = (scope: string, candidates: HomeAttentionItem[], events: readonly string[]) => {
    const diff = diffAttention(
      state[scope] ?? null,
      candidates.map((item) => ({ ...item, event: item.event! })),
      { events, agentOnly: prefs.agentOnly },
      now,
      awakeSince,
    );
    next[scope] = diff.entries;
    due.push(...diff.notify);
    if (diff.wakeAt !== null) wakeAt = wakeAt === null ? diff.wakeAt : Math.min(wakeAt, diff.wakeAt);
  };
  for (const mac of machines) {
    const own = items.filter((item) => item.target.macId === mac.id && item.event !== null);
    run(
      `link:${mac.id}`,
      own.filter((item) => item.event === 'offline'),
      prefs.events,
    );
    const status = `status:${mac.id}`;
    if (!mac.live) {
      if (state[status]) next[status] = state[status];
      continue;
    }
    const events = mac.pushed
      ? prefs.events.filter((e) => !(PUSH_EVENTS as readonly string[]).includes(e))
      : prefs.events;
    run(
      status,
      own.filter((item) => item.event !== 'offline'),
      events,
    );
  }
  if (due.length > SUMMARIZE_ABOVE) {
    return {
      state: next,
      notifications: [
        { title: 'Stim', body: `${due.length} problems need attention`, data: { ref: '', target: 'home' } },
      ],
      wakeAt,
    };
  }
  return { state: next, notifications: due.map(notificationOf), wakeAt };
}

function notificationOf(item: HomeAttentionItem): LocalNotification {
  const { target } = item;
  if (target.kind === 'machine') {
    return { title: item.title, body: item.reason, data: { ref: target.macId, target: 'machine' } };
  }
  return {
    title: item.title,
    subtitle: item.macName,
    body: item.reason,
    data: { ref: target.macId, target: target.kind, path: target.path },
  };
}

export type NotificationRoute =
  | { pathname: '/' }
  | { pathname: '/mac/[id]'; params: { id: string } }
  | { pathname: '/mac/[id]/workspace'; params: { id: string; path: string } }
  | { pathname: '/mac/[id]/logs'; params: { id: string; path: string; errors: '1' } };

/** The screen a tapped notification opens: home, or the machine sheet, workspace or its errors of a paired machine. */
export function notificationRoute(data: unknown, macIds: readonly string[]): NotificationRoute {
  const value = (data ?? {}) as Partial<NotificationData>;
  if (typeof value.ref !== 'string' || !macIds.includes(value.ref)) return { pathname: '/' };
  const id = value.ref;
  if (value.target === 'machine') return { pathname: '/mac/[id]', params: { id } };
  if (typeof value.path !== 'string') return { pathname: '/' };
  if (value.target === 'workspace') return { pathname: '/mac/[id]/workspace', params: { id, path: value.path } };
  if (value.target === 'logs') return { pathname: '/mac/[id]/logs', params: { id, path: value.path, errors: '1' } };
  return { pathname: '/' };
}
