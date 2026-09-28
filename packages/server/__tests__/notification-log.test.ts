import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationLog, type NewEntry } from '../src/notification-log.ts';

const T0 = Date.parse('2026-09-28T12:00:00Z');
const DAY = 24 * 60 * 60_000;

let dir: string;
let file: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-notification-log-'));
  file = join(dir, 'server', 'notifications.json');
  now = T0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (body: string, extra: Partial<NewEntry> = {}): NewEntry => ({
  id: `stuck:/w/${body}`,
  category: 'stuck',
  title: 'feat/login',
  body,
  quiet: false,
  target: { kind: 'workspace', path: '/w' },
  ...extra,
});

const open = () => new NotificationLog(file, () => now);
const bodies = (log: NotificationLog, since?: number) => log.list('d1', since).notifications.map((n) => n.body);

describe('NotificationLog', () => {
  it('lists newest first after a cursor, and a restart continues the same log', () => {
    const log = open();
    expect(log.list('d1')).toEqual({ log: expect.any(String), cursor: 0, notifications: [] });
    log.append([entry('a'), entry('b')]);
    now += 1000;
    log.append([entry('c')]);
    const first = log.list('d1');
    expect(first.notifications.map((n) => [n.seq, n.body, n.at])).toEqual([
      [3, 'c', new Date(T0 + 1000).toISOString()],
      [2, 'b', new Date(T0).toISOString()],
      [1, 'a', new Date(T0).toISOString()],
    ]);
    expect(first.cursor).toBe(3);
    expect(bodies(log, 2)).toEqual(['c']);
    expect(bodies(log, 3)).toEqual([]);

    const restarted = open();
    restarted.append([entry('d')]);
    expect(restarted.list('d1', first.cursor)).toEqual({
      log: first.log,
      cursor: 4,
      notifications: [expect.objectContaining({ seq: 4, body: 'd' })],
    });
  });

  it('keeps the last 200 entries and none older than 7 days', () => {
    const log = open();
    log.append(Array.from({ length: 150 }, (_, i) => entry(`old${i}`)));
    now += DAY;
    log.append(Array.from({ length: 100 }, (_, i) => entry(`new${i}`)));
    expect(bodies(log)).toHaveLength(200);
    expect(bodies(log).at(-1)).toBe('old50');
    expect(log.list('d1').cursor).toBe(250);

    now = T0 + 7 * DAY + 1;
    expect(bodies(log)).toHaveLength(100);
    log.append([entry('latest')]);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] };
    expect(stored.entries).toHaveLength(101);
  });

  it('shows a control conflict only to its device, and records why no phone got an entry', () => {
    const log = open();
    log.append([
      entry('muted', { suppressed: 'muted' }),
      entry('held', { category: 'looping', suppressed: 'quiet-hours' }),
      entry('taken over', { id: 'control:/w:ios:default', category: 'control', device: 'd2' }),
    ]);
    expect(log.list('d1').notifications.map((n) => [n.body, n.suppressed])).toEqual([
      ['held', 'quiet-hours'],
      ['muted', 'muted'],
    ]);
    expect(log.list('d2').notifications.map((n) => n.body)).toEqual(['taken over', 'held', 'muted']);
    expect(log.list('d2').notifications[0]).not.toHaveProperty('device');
    expect(log.latest('control:/w:ios:default', 'd1')).toBeNull();
    expect(log.latest('control:/w:ios:default', 'd2')).toBe(3);
  });
});
