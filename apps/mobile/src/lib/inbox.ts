import { t } from '@lingui/core/macro';

import { formatDateTime } from '@/intl/format';
import type { NotificationData } from '@/lib/notifications';
import type { OversightCategory } from '@stim-cli/core/oversight';
import type { NotificationEntry, NotificationsListResult } from '@/protocol/types';

/** One Mac's notification history as this phone holds it: newest first, for the Mac's current `log`. */
export interface MacHistory {
  log: string;
  cursor: number;
  entries: NotificationEntry[];
}

/** Which entries of a Mac's `log` this phone has read: every `seq` up to `readUpTo`, and each in `read`. */
export interface ReadState {
  log: string;
  readUpTo: number;
  read: number[];
}

export interface InboxItem extends NotificationEntry {
  macId: string;
  macName: string;
  read: boolean;
}

export interface InboxFilters {
  categories: OversightCategory[] | null;
  macIds: string[] | null;
}

const HISTORY_LIMIT = 200;

/** `history` after a `notifications.list` answered `result`; a new `log` replaces it. */
export function applyList(history: MacHistory | null, result: NotificationsListResult): MacHistory {
  if (!history || history.log !== result.log || result.cursor < history.cursor) {
    return { log: result.log, cursor: result.cursor, entries: result.notifications.slice(0, HISTORY_LIMIT) };
  }
  return {
    log: result.log,
    cursor: Math.max(history.cursor, result.cursor),
    entries: mergeEntries(history.entries, result.notifications),
  };
}

/** `history` with one live entry added; an entry of another `log` means the Mac's history started over. */
export function applyLive(history: MacHistory | null, log: string, entry: NotificationEntry): MacHistory {
  if (!history || history.log !== log) return { log, cursor: entry.seq, entries: [entry] };
  return { log, cursor: Math.max(history.cursor, entry.seq), entries: mergeEntries(history.entries, [entry]) };
}

function mergeEntries(current: NotificationEntry[], incoming: NotificationEntry[]): NotificationEntry[] {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, HISTORY_LIMIT);
}

/** Stored read state, or a fresh one when it is unreadable or kept for another `log`. */
export function parseReadState(raw: string | undefined, log: string): ReadState {
  try {
    const value = JSON.parse(raw ?? '') as Partial<ReadState>;
    if (value.log === log && Number.isInteger(value.readUpTo) && Array.isArray(value.read)) {
      return { log, readUpTo: value.readUpTo!, read: value.read.filter((seq) => Number.isInteger(seq)) };
    }
  } catch {}
  return { log, readUpTo: 0, read: [] };
}

const isRead = (state: ReadState, seq: number) => seq <= state.readUpTo || state.read.includes(seq);

/** `state` with `seqs` read, forgetting the ones below `oldest`, which the Mac no longer lists. */
export function markRead(state: ReadState, seqs: readonly number[], oldest = 0): ReadState {
  const added = seqs.filter((seq) => !isRead(state, seq));
  return { ...state, read: [...state.read, ...added].filter((seq) => seq >= oldest) };
}

export function markAllRead(state: ReadState, cursor: number): ReadState {
  return { log: state.log, readUpTo: Math.max(state.readUpTo, cursor), read: [] };
}

/** The entries a notification the phone showed stands for: its logged `seq`, or else its latest episode `id`. */
export function notificationSeqs(
  history: MacHistory | null,
  data: { notification?: unknown; key?: unknown },
): number[] {
  if (!history) return [];
  if (typeof data.notification === 'number') return [data.notification];
  if (typeof data.key !== 'string') return [];
  const found = history.entries.find((entry) => entry.id === data.key);
  return found ? [found.seq] : [];
}

/** Every Mac's entries, newest first, with its read state and whether the filters keep it. */
export function inboxItems(
  macs: { id: string; name: string; history: MacHistory | null; read: ReadState | null }[],
  filters: InboxFilters,
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const mac of macs) {
    if (!mac.history || (filters.macIds && !filters.macIds.includes(mac.id))) continue;
    for (const entry of mac.history.entries) {
      if (filters.categories && !filters.categories.some((category) => category === entry.category)) continue;
      items.push({ ...entry, macId: mac.id, macName: mac.name, read: mac.read ? isRead(mac.read, entry.seq) : false });
    }
  }
  return [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq);
}

/** `items` in sections by local day: Today, Yesterday, then the date. */
export function byDay(items: InboxItem[], now: number): { title: string; data: InboxItem[] }[] {
  const sections: { title: string; data: InboxItem[] }[] = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (const item of items) {
    const day = new Date(item.at);
    day.setHours(0, 0, 0, 0);
    const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    const title =
      days === 0
        ? t`Today`
        : days === 1
          ? t`Yesterday`
          : formatDateTime(day, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
            });
    const last = sections.at(-1);
    if (last?.title === title) last.data.push(item);
    else sections.push({ title, data: [item] });
  }
  return sections;
}

/** What tapping the item opens, as its push does. */
export function itemData(item: InboxItem): NotificationData {
  const { kind, path, platform, slot, url } = item.target;
  const ref = item.macId;
  if (kind === 'workspace' && path !== undefined) return { ref, target: 'workspace', path };
  if (kind === 'url' && path !== undefined && url !== undefined) return { ref, target: 'url', path, url };
  if (path !== undefined) {
    if (kind === 'build' && (platform === 'ios' || platform === 'android'))
      return { ref, target: 'build', path, platform };
    if (
      kind === 'device' &&
      slot !== undefined &&
      (platform === 'ios' || platform === 'android' || platform === 'web' || platform === 'macos')
    )
      return { ref, target: 'device', path, platform, slot };
  }
  return { ref, target: 'machine' };
}
