import { plural, t } from '@lingui/core/macro';

import type { AttentionMachine } from '@/lib/attention';
import {
  DEFAULT_STUCK_MINUTES,
  inQuietHours,
  OVERSIGHT_CATEGORIES,
  oversee,
  type OversightCategory,
  type OversightNotification,
  type OversightState,
} from '@stim-cli/core/oversight';
import type { DevicePlatform } from '@/protocol/types';

export const NOTIFY_CATEGORIES: readonly OversightCategory[] = OVERSIGHT_CATEGORIES;

/** Minutes after local midnight; an `end` before `start` spans midnight. */
export interface QuietHours {
  start: number;
  end: number;
}

/** How a category is delivered: `alert` with a banner and sound, `silent` to the notification list only, or `off`. */
export type NotifyLevel = 'alert' | 'silent' | 'off';

const NOTIFY_LEVELS: readonly NotifyLevel[] = ['alert', 'silent', 'off'];

export const DEFAULT_LEVELS: Record<OversightCategory, NotifyLevel> = {
  started: 'silent',
  stuck: 'silent',
  looping: 'silent',
  finished: 'silent',
  machine: 'silent',
  control: 'silent',
  attention: 'silent',
};

export interface NotificationPrefs {
  enabled: boolean;
  levels: Record<OversightCategory, NotifyLevel>;
  stuckMinutes: number;
  quietHours: QuietHours | null;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  levels: DEFAULT_LEVELS,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  quietHours: null,
};

/** The categories that notify at all. */
export const notifiedCategories = (prefs: NotificationPrefs): OversightCategory[] =>
  NOTIFY_CATEGORIES.filter((category) => prefs.levels[category] !== 'off');

const minute = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1440;

/** The categories that existed when preferences stored them as on/off `categories`. */
const ON_OFF_CATEGORIES: readonly OversightCategory[] = [
  'started',
  'stuck',
  'looping',
  'finished',
  'machine',
  'control',
];

/**
 * Each category's stored level. Preferences saved with on/off `categories` give a category that was on its default
 * level and keep one that was off off, and a category added since its default level; ones saved before categories
 * give every category its default level.
 */
function parseLevels(levels: unknown, categories: unknown): Record<OversightCategory, NotifyLevel> {
  const stored = (levels ?? {}) as Partial<Record<string, unknown>>;
  return Object.fromEntries(
    NOTIFY_CATEGORIES.map((category) => {
      const level = stored[category];
      if (typeof level === 'string' && (NOTIFY_LEVELS as readonly string[]).includes(level)) return [category, level];
      if (Array.isArray(categories) && ON_OFF_CATEGORIES.includes(category) && !categories.includes(category)) {
        return [category, 'off'];
      }
      return [category, DEFAULT_LEVELS[category]];
    }),
  ) as Record<OversightCategory, NotifyLevel>;
}

/** Stored preferences, with older on/off categories read as levels. */
export function parsePrefs(raw: string | undefined): NotificationPrefs {
  try {
    const value = JSON.parse(raw ?? '') as Partial<Record<keyof NotificationPrefs | 'categories', unknown>>;
    const quiet = value.quietHours as Partial<QuietHours> | null | undefined;
    const stuck = value.stuckMinutes;
    return {
      enabled: value.enabled === true,
      levels: parseLevels(value.levels, value.levels === undefined ? value.categories : undefined),
      stuckMinutes:
        Number.isInteger(stuck) && (stuck as number) >= 1 && (stuck as number) <= 240
          ? (stuck as number)
          : DEFAULT_STUCK_MINUTES,
      quietHours: quiet && minute(quiet.start) && minute(quiet.end) ? { start: quiet.start!, end: quiet.end! } : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** What a notification opens, local or pushed; `ref` is the paired machine's id on this phone. */
export interface NotificationData {
  ref: string;
  target: 'home' | 'machine' | 'workspace' | 'logs' | 'device' | 'build' | 'url';
  path?: string;
  platform?: DevicePlatform;
  slot?: string;
  url?: string;
  /** The Mac's notification history entry a push reports. */
  notification?: number;
  /** The rules' notification id a local notification reports, shared by every episode of it. */
  key?: string;
}

export interface LocalNotification {
  /** Replaces an earlier notification with the same id, so one episode updates in place. */
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  quiet: boolean;
  thread: string | null;
  data: NotificationData;
}

/** Each machine's rule state, under `link:<id>` for its connection and `status:<id>` for what its status reports. */
export type NotifyState = Record<string, OversightState>;

export interface NotifyMachine {
  mac: AttentionMachine;
  /** Whether this phone has the machine's current status, so what it lacks is really gone. */
  live: boolean;
  /** Whether the machine pushes this phone's notifications, so the phone stays quiet about what it pushes. */
  pushed: boolean;
}

const SUMMARIZE_ABOVE = 3;

function link(mac: AttentionMachine): 'open' | 'offline' | 'refused' | 'unpaired' {
  if (mac.missing) return 'unpaired';
  if (mac.state.kind === 'refused') return 'refused';
  if (mac.state.kind === 'open' || (mac.state.kind === 'connecting' && mac.disconnectedAt === null)) return 'open';
  return 'offline';
}

/**
 * The local notifications the machines owe since `state`, from the rules stim-server pushes with. A machine's
 * connection is checked always, and its status only while it is live. For a machine that pushes, the status
 * rules run without notifying, so the phone neither repeats a push nor, if pushing stops, catches up on it.
 * `minuteOfDay` is the local time, for quiet hours.
 */
export function localNotifications(
  state: NotifyState,
  machines: NotifyMachine[],
  prefs: NotificationPrefs,
  now: number,
  minuteOfDay: number,
  awakeSince: number,
): { state: NotifyState; notifications: LocalNotification[]; wakeAt: number | null } {
  const next: NotifyState = {};
  const due: LocalNotification[] = [];
  let wakeAt: number | null = null;
  const quiet = inQuietHours(prefs.quietHours, minuteOfDay);
  const categories = notifiedCategories(prefs);
  const run = (scope: string, mac: AttentionMachine, categories: readonly OversightCategory[], live: boolean) => {
    const result = oversee(
      state[scope] ?? null,
      {
        machine: mac.name,
        status: live ? mac.status : null,
        volumes: live ? (mac.usage?.volumes ?? null) : null,
        memoryPressure: live ? (mac.usage?.memory.pressure ?? null) : null,
        link: live ? null : link(mac),
        pullRequests: {},
        ownLeases: mac.status?.ownLeases ?? [],
      },
      { categories, stuckMinutes: prefs.stuckMinutes, quiet },
      now,
      awakeSince,
    );
    next[scope] = result.state;
    due.push(...result.notifications.map((n) => notificationOf(mac, n, prefs.levels[n.category] === 'silent')));
    if (result.wakeAt !== null) wakeAt = wakeAt === null ? result.wakeAt : Math.min(wakeAt, result.wakeAt);
  };
  for (const { mac, live, pushed } of machines) {
    run(`link:${mac.id}`, mac, categories, false);
    const status = `status:${mac.id}`;
    if (!live) {
      if (state[status]) next[status] = state[status];
      continue;
    }
    run(status, mac, pushed ? [] : categories, true);
  }
  if (due.length > SUMMARIZE_ABOVE) {
    return {
      state: next,
      notifications: [
        {
          id: 'summary',
          title: t`Stim`,
          body: plural(due.length, { one: '# thing needs a look', other: '# things need a look' }),
          quiet: due.every((n) => n.quiet),
          thread: null,
          data: { ref: '', target: 'home' },
        },
      ],
      wakeAt,
    };
  }
  return { state: next, notifications: due, wakeAt };
}

function notificationOf(mac: AttentionMachine, n: OversightNotification, quiet: boolean): LocalNotification {
  const { kind, ...target } = n.target;
  return {
    id: `${mac.id}:${n.id}`,
    title: n.title,
    ...(kind === 'machine' ? {} : { subtitle: mac.name }),
    body: n.body,
    quiet,
    thread: n.thread,
    data: { ref: mac.id, target: kind, key: n.id, ...target },
  };
}

export type NotificationRoute =
  | { pathname: '/' }
  | { pathname: '/mac/[id]'; params: { id: string } }
  | { pathname: '/mac/[id]/workspace'; params: { id: string; path: string } }
  | { pathname: '/mac/[id]/logs'; params: { id: string; path: string; errors: '1' } }
  | { pathname: '/mac/[id]/device'; params: { id: string; path: string; platform: DevicePlatform; slot: string } }
  | { pathname: '/mac/[id]/build'; params: { id: string; path: string; platform: 'ios' | 'android' } }
  | { url: string };

const GITHUB_PULL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

/**
 * What a tapped notification opens: home; a paired machine's sheet, workspace, errors, device viewer or build
 * details; or a GitHub pull request in the browser. Anything else about a workspace opens the workspace.
 */
export function notificationRoute(data: unknown, macIds: readonly string[]): NotificationRoute {
  const value = (data ?? {}) as Partial<NotificationData>;
  if (typeof value.ref !== 'string' || !macIds.includes(value.ref)) return { pathname: '/' };
  const id = value.ref;
  if (value.target === 'machine') return { pathname: '/mac/[id]', params: { id } };
  if (typeof value.path !== 'string') return { pathname: '/' };
  const path = value.path;
  const platform =
    value.platform === 'ios' || value.platform === 'android' || value.platform === 'web' ? value.platform : null;
  if (value.target === 'url' && typeof value.url === 'string' && GITHUB_PULL.test(value.url)) return { url: value.url };
  if (value.target === 'device' && platform) {
    const slot = typeof value.slot === 'string' ? value.slot : 'default';
    return { pathname: '/mac/[id]/device', params: { id, path, platform, slot } };
  }
  if (value.target === 'build' && platform && platform !== 'web') {
    return { pathname: '/mac/[id]/build', params: { id, path, platform } };
  }
  if (value.target === 'logs') return { pathname: '/mac/[id]/logs', params: { id, path, errors: '1' } };
  return { pathname: '/mac/[id]/workspace', params: { id, path } };
}
