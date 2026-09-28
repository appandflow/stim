import {
  applyList,
  applyLive,
  byDay,
  inboxItems,
  itemData,
  markAllRead,
  markRead,
  notificationSeqs,
  parseReadState,
  type MacHistory,
} from '@/lib/inbox';
import type { NotificationEntry } from '@/protocol/types';

const NOON = new Date(2026, 8, 28, 12, 0).getTime();
const HOUR = 3_600_000;

const entry = (seq: number, at: number, extra: Partial<NotificationEntry> = {}): NotificationEntry => ({
  seq,
  at: new Date(at).toISOString(),
  id: `stuck:/w${seq}`,
  category: 'stuck',
  title: `w${seq}`,
  body: 'No agent activity for 15 min; iPhone 17 Pro 26.0 still up',
  quiet: false,
  target: { kind: 'workspace', path: `/w${seq}` },
  ...extra,
});

const history = (log: string, ...entries: NotificationEntry[]): MacHistory => ({
  log,
  cursor: Math.max(0, ...entries.map((e) => e.seq)),
  entries,
});

describe('a Mac history', () => {
  it('adds what a later list returns after its cursor, and starts over for a new log or a lower cursor', () => {
    const first = applyList(null, { log: 'L', cursor: 2, notifications: [entry(2, NOON), entry(1, NOON - HOUR)] });
    const later = applyList(first, { log: 'L', cursor: 4, notifications: [entry(4, NOON + 2), entry(3, NOON + 1)] });
    expect(later.entries.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(later.cursor).toBe(4);

    expect(applyList(later, { log: 'M', cursor: 1, notifications: [entry(1, NOON)] }).entries).toHaveLength(1);
    expect(applyList(later, { log: 'L', cursor: 1, notifications: [entry(1, NOON)] }).cursor).toBe(1);
  });

  it('adds a live entry once, and a live entry of another log replaces the history', () => {
    const known = history('L', entry(1, NOON));
    const live = applyLive(applyLive(known, 'L', entry(2, NOON + 1)), 'L', entry(2, NOON + 1));
    expect(live).toMatchObject({ cursor: 2, entries: [{ seq: 2 }, { seq: 1 }] });
    expect(applyLive(live, 'M', entry(1, NOON + 2))).toMatchObject({ log: 'M', cursor: 1, entries: [{ seq: 1 }] });
  });
});

describe('read state', () => {
  it('keeps what was read for the same log only, and marks all read up to the cursor', () => {
    const state = markRead(parseReadState(undefined, 'L'), [3]);
    const saved = JSON.stringify(state);
    expect(parseReadState(saved, 'L')).toEqual({ log: 'L', readUpTo: 0, read: [3] });
    expect(parseReadState(saved, 'M')).toEqual({ log: 'M', readUpTo: 0, read: [] });
    expect(parseReadState('not json', 'L')).toEqual({ log: 'L', readUpTo: 0, read: [] });
    expect(markAllRead(state, 5)).toEqual({ log: 'L', readUpTo: 5, read: [] });
    expect(markRead(state, [9], 4)).toEqual({ log: 'L', readUpTo: 0, read: [9] });
  });

  it('finds the entry a tapped push or local notification reported', () => {
    const known = history('L', entry(5, NOON, { id: 'stuck:/a' }), entry(2, NOON - HOUR, { id: 'stuck:/a' }));
    expect(notificationSeqs(known, { notification: 2 })).toEqual([2]);
    expect(notificationSeqs(known, { key: 'stuck:/a' })).toEqual([5]);
    expect(notificationSeqs(known, { key: 'stuck:/b' })).toEqual([]);
    expect(notificationSeqs(null, { notification: 2 })).toEqual([]);
  });
});

describe('the inbox', () => {
  const macs = [
    {
      id: 'a',
      name: 'MacBook Pro',
      history: history('L', entry(2, NOON), entry(1, NOON - 26 * HOUR)),
      read: { log: 'L', readUpTo: 1, read: [] },
    },
    {
      id: 'b',
      name: 'Mac mini',
      history: history('M', entry(7, NOON - HOUR, { category: 'finished' })),
      read: null,
    },
    { id: 'c', name: 'Old Mac', history: null, read: null },
  ];

  it('merges every Mac newest first, with read state, and filters by category and Mac', () => {
    const all = inboxItems(macs, { categories: null, macIds: null });
    expect(all.map((item) => [item.macName, item.seq, item.read])).toEqual([
      ['MacBook Pro', 2, false],
      ['Mac mini', 7, false],
      ['MacBook Pro', 1, true],
    ]);
    expect(inboxItems(macs, { categories: ['finished'], macIds: null }).map((i) => i.seq)).toEqual([7]);
    expect(inboxItems(macs, { categories: null, macIds: ['a'] }).map((i) => i.seq)).toEqual([2, 1]);
  });

  it('groups by local day and opens what the push opens', () => {
    const items = inboxItems(macs, { categories: null, macIds: null });
    expect(byDay(items, NOON + HOUR).map((s) => [s.title, s.data.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ]);
    expect(itemData(items[1]!)).toEqual({ ref: 'b', target: 'workspace', path: '/w7' });
  });
});
