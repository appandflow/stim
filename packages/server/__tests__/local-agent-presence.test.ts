import type { AgentSnapshotTree, NdjsonRecord } from '@stim-cli/core/state';
import { LocalAgentPresence } from '../src/local-agent-presence.ts';
import { PresenceHub, presenceKey } from '../src/presence.ts';
import type { PresenceGesture, PresenceParticipant } from '../src/protocol.ts';

const WORKSPACE = '/work/app';
const KEY = presenceKey(WORKSPACE, 'ios', 'default', false);
const SCREEN = { width: 400, height: 800 };
const NOW = 1_000_000;

const scroll = (ts: number, extra: Partial<NdjsonRecord> = {}): NdjsonRecord => ({
  ts,
  src: 'agent',
  level: 'info',
  msg: '',
  event: 'agent_action',
  command: 'scroll',
  session: 'bot',
  platform: 'ios',
  deviceId: 'UDID',
  details: { x1: 200, y1: 600, x2: 200, y2: 200, durationMs: 400 },
  ...extra,
});

function fixture(
  tree?: () => AgentSnapshotTree,
  measure?: (call: number) => Promise<{ width: number; height: number } | null>,
) {
  const hub = new PresenceHub();
  const follows: { workspace: string; emit: (record: NdjsonRecord) => void; signal: AbortSignal }[] = [];
  const screens: string[] = [];
  const agents = new LocalAgentPresence({
    hub,
    follow: async (workspace, emit, signal) => {
      follows.push({ workspace, emit, signal });
      return () => {};
    },
    screen: async (platform, device) => {
      screens.push(`${platform}:${device}`);
      return measure ? measure(screens.length) : SCREEN;
    },
    tree,
    now: () => NOW,
  });
  const gestures: (PresenceGesture | undefined)[] = [];
  const subscribe = (key = KEY) =>
    agents.subscribe(key, (participants: PresenceParticipant[]) => {
      for (const participant of participants) if (participant.kind === 'agent') gestures.push(participant.gesture);
    });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const follow = () => {
    const found = follows[0];
    if (!found) throw new Error('nothing follows');
    return found;
  };
  return { agents, follows, follow, screens, gestures, subscribe, settle };
}

beforeEach(() => vi.useFakeTimers({ now: NOW }));

test("shows an agent-device action no wrapper ran as the agent's gesture, measured in the device's screen", async () => {
  const f = fixture();
  f.subscribe();
  f.follow().emit(scroll(NOW - 700));
  await f.settle();
  expect(f.gestures).toEqual([{ kind: 'swipe', from: { x: 0.5, y: 0.75 }, to: { x: 0.5, y: 0.25 }, durationMs: 400 }]);
  expect(f.screens).toEqual(['ios:UDID']);
  f.follow().emit(scroll(NOW - 100));
  await f.settle();
  expect(f.gestures).toHaveLength(2);
  expect(f.screens).toHaveLength(1);
});

test("measures an action in its session's snapshot viewport without asking the device", async () => {
  const f = fixture(() => ({ viewport: { width: 200, height: 400 }, nodes: [] }));
  f.subscribe();
  f.follow().emit(scroll(NOW - 100, { details: { x: 100, y: 100 } }));
  await f.settle();
  expect(f.gestures).toEqual([{ kind: 'tap', from: { x: 0.5, y: 0.25 }, durationMs: 0 }]);
  expect(f.screens).toEqual([]);
});

test('follows a workspace once for all its devices, and only while one of them has a subscriber', () => {
  const f = fixture();
  const first = f.subscribe();
  const second = f.subscribe();
  const other = f.subscribe(presenceKey(WORKSPACE, 'android', 'default', false));
  expect(f.follows.map((follow) => follow.workspace)).toEqual([WORKSPACE]);
  first();
  second();
  expect(f.follow().signal.aborted).toBe(false);
  other();
  expect(f.follow().signal.aborted).toBe(true);
  f.subscribe();
  expect(f.follows).toHaveLength(2);
});

test('ignores history, actions on devices nobody watches and the records of a leased phone', async () => {
  const f = fixture();
  f.subscribe();
  f.subscribe(presenceKey(WORKSPACE, 'android', 'default', true));
  const { emit } = f.follow();
  emit(scroll(NOW - 60_000));
  emit(scroll(NOW - 100, { platform: 'android' }));
  emit(scroll(NOW - 100, { slot: 'two' }));
  emit(scroll(NOW - 100, { event: 'agent_failed' }));
  await f.settle();
  expect(f.gestures).toEqual([]);
  expect(f.follows).toHaveLength(1);
});

describe('a gesture shown by both `stim agent-device` and the records', () => {
  const swipe: PresenceGesture = {
    kind: 'swipe',
    from: { x: 0.5, y: 0.75 },
    to: { x: 0.5, y: 0.25 },
    durationMs: 400,
  };

  test('draws once whichever comes first, and a repeat of the same action still draws', async () => {
    const f = fixture();
    f.subscribe();
    const { emit } = f.follow();
    f.agents.published(KEY, 'scroll', 'end', swipe);
    emit(scroll(NOW - 100));
    await f.settle();
    expect(f.gestures).toEqual([swipe]);
    emit(scroll(NOW - 50));
    await f.settle();
    expect(f.gestures).toEqual([swipe, swipe]);
    f.agents.published(KEY, 'scroll', 'end', swipe);
    expect(f.gestures).toEqual([swipe, swipe, undefined]);
  });
});

test('measures the device again at the next action when measuring failed', async () => {
  const f = fixture(undefined, async (call) => {
    if (call === 1) throw new Error('simctl is busy');
    return SCREEN;
  });
  f.subscribe();
  f.follow().emit(scroll(NOW - 200));
  await f.settle();
  expect(f.gestures).toEqual([undefined]);
  f.follow().emit(scroll(NOW - 100));
  await f.settle();
  expect(f.gestures.at(-1)).toMatchObject({ kind: 'swipe' });
});

test('a gesture from `stim agent-device` on a device nobody follows does not wait for a copy from the records', async () => {
  const f = fixture();
  const swipe: PresenceGesture = { kind: 'swipe', from: { x: 0.5, y: 0.75 }, to: { x: 0.5, y: 0.25 }, durationMs: 400 };
  f.agents.published(KEY, 'scroll', 'end', swipe);
  f.subscribe();
  f.follow().emit(scroll(NOW - 100));
  await f.settle();
  expect(f.gestures).toEqual([undefined, swipe]);
});
