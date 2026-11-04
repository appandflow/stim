import { PassThrough, Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { NdjsonRecord } from '@stim-cli/core/state';
import { HostedPresence } from '../src/hosted-presence.ts';
import type { PresenceParticipant } from '../src/protocol.ts';

const A = '4f88400a-48eb-4a07-ba6a-734c42768b2a';
const B = '5a88400a-48eb-4a07-ba6a-734c42768b2b';
const POLL_MS = 250;

const action = (command: string, details: Record<string, unknown>): NdjsonRecord => ({
  ts: 1,
  src: 'agent',
  level: 'info',
  msg: '',
  event: 'agent_action',
  command,
  session: `stim.${A}:default`,
  details,
});

const snapshot = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    ok: true,
    data: {
      nodes: [{ ref: 'e19', rect: { x: 100, y: 760, width: 200, height: 80 } }],
      viewport: { width: 400, height: 800 },
    },
  },
};

function fixture() {
  const records: Record<string, NdjsonRecord[]> = { [A]: [], [B]: [] };
  const since: Record<string, number> = {};
  const presence = new HostedPresence({
    pollMs: POLL_MS,
    now: () => 1000,
    read: (session, from) => {
      since[session] = from;
      return () => records[session]!.splice(0);
    },
  });
  const seen = (session: string, screen?: () => Promise<{ width: number; height: number } | null>) => {
    const events: PresenceParticipant[][] = [];
    const stop = presence.subscribe(session, (participants) => events.push(participants), screen);
    return { events, stop };
  };
  const answer = async (session: string, body: unknown) => {
    const response = new PassThrough() as unknown as ServerResponse;
    presence.watch(session, response);
    const done = new Promise((resolve) => (response as unknown as PassThrough).once('finish', resolve));
    Readable.from([Buffer.from(JSON.stringify(body))]).pipe(response as unknown as PassThrough);
    await done;
  };
  return { presence, records, since, seen, answer };
}

beforeEach(() => vi.useFakeTimers());

test("publishes a session's agent actions, with the outline of a ref from the latest snapshot its route answered", async () => {
  const f = fixture();
  const { events } = f.seen(A);
  await f.answer(A, snapshot);
  f.records[A]!.push(action('press', { ref: 'e19', positionals: ['@e19'], x: 200, y: 800 }));
  vi.advanceTimersByTime(POLL_MS);
  expect(events.at(-1)).toEqual([
    {
      id: 'a1',
      kind: 'agent',
      name: 'Agent · press',
      color: 1,
      gesture: {
        kind: 'tap',
        from: { x: 0.5, y: 1 },
        durationMs: 0,
        target: { x: 0.25, y: 0.95, width: 0.5, height: 0.1 },
      },
    },
  ]);
  f.records[A]!.push(
    action('scroll', { positionals: ['<arg>'], x1: 200, y1: 720, x2: 200, y2: 160, durationMs: 400 }),
    action('press', { positionals: ['<arg>', '<arg>'], targetLabel: '(200, 800)', x: 200, y: 800 }),
  );
  vi.advanceTimersByTime(POLL_MS);
  expect(events.slice(-2).map(([agent]) => agent?.gesture)).toEqual([
    { kind: 'swipe', from: { x: 0.5, y: 0.9 }, to: { x: 0.5, y: 0.2 }, durationMs: 400 },
    { kind: 'tap', from: { x: 0.5, y: 1 }, durationMs: 0 },
  ]);
});

test('shows only the label for an action without a snapshot or a point, and ignores records that are not actions', () => {
  const f = fixture();
  const { events } = f.seen(A);
  f.records[A]!.push(
    action('press', { x: 200, y: 800 }),
    action('snapshot', {}),
    { ...action('press', {}), event: 'agent_failed' },
    action('Bad Command', {}),
  );
  vi.advanceTimersByTime(POLL_MS);
  expect(events.map((participants) => participants.map((agent) => [agent.name, agent.gesture]))).toEqual([
    [],
    [['Agent · press', undefined]],
    [['Agent · snapshot', undefined]],
  ]);
});

test("publishes a session's actions to its own subscribers only, and follows it only from when it was subscribed", () => {
  const f = fixture();
  const a = f.seen(A);
  const b = f.seen(B);
  expect(f.since).toEqual({ [A]: 1000, [B]: 1000 });
  f.records[A]!.push(action('press', {}));
  f.records[B]!.push(action('scroll', {}));
  vi.advanceTimersByTime(POLL_MS);
  expect(a.events.flat().map((agent) => agent.name)).toEqual(['Agent · press']);
  expect(b.events.flat().map((agent) => agent.name)).toEqual(['Agent · scroll']);
});

test('stops reading a session when its last subscriber leaves, and forgets its snapshot when it ends', async () => {
  const f = fixture();
  const first = f.seen(A);
  const second = f.seen(A);
  first.stop();
  f.records[A]!.push(action('press', {}));
  vi.advanceTimersByTime(POLL_MS);
  expect(second.events.flat()).toHaveLength(1);
  second.stop();
  f.records[A]!.push(action('press', {}));
  vi.advanceTimersByTime(POLL_MS * 4);
  expect(f.records[A]).toHaveLength(1);

  await f.answer(A, snapshot);
  f.presence.forget(A);
  const next = f.seen(A);
  f.records[A]!.splice(0);
  f.records[A]!.push(action('press', { ref: 'e19', positionals: ['@e19'], x: 200, y: 800 }));
  vi.advanceTimersByTime(POLL_MS);
  expect(next.events.flat().at(-1)?.gesture).toBeUndefined();
});

test("measures an action that came before any snapshot in the session's device screen, and a snapshot's viewport wins", async () => {
  const f = fixture();
  const { events } = f.seen(A, async () => ({ width: 200, height: 400 }));
  await vi.advanceTimersByTimeAsync(0);
  f.records[A]?.push(action('press', { x: 100, y: 100 }));
  vi.advanceTimersByTime(POLL_MS);
  expect(events.at(-1)?.[0]?.gesture).toEqual({ kind: 'tap', from: { x: 0.5, y: 0.25 }, durationMs: 0 });
  await f.answer(A, snapshot);
  f.records[A]?.push(action('press', { x: 100, y: 100 }));
  vi.advanceTimersByTime(POLL_MS);
  expect(events.at(-1)?.[0]?.gesture).toEqual({ kind: 'tap', from: { x: 0.25, y: 0.125 }, durationMs: 0 });
});

test('measures the device again at the next action when the first measuring failed', async () => {
  const f = fixture();
  let tries = 0;
  const { events } = f.seen(A, async () => {
    if (++tries === 1) throw new Error('an install is running');
    return { width: 200, height: 400 };
  });
  await vi.advanceTimersByTimeAsync(0);
  f.records[A]?.push(action('press', { x: 100, y: 100 }));
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(events.at(-1)?.[0]?.gesture).toBeUndefined();
  f.records[A]?.push(action('press', { x: 100, y: 100 }));
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(events.at(-1)?.[0]?.gesture).toEqual({ kind: 'tap', from: { x: 0.5, y: 0.25 }, durationMs: 0 });
});
