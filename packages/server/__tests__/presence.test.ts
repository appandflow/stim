import { AGENT_LINGER_MS, MOVE_FLUSH_MS, parseHostedAgent, PresenceHub } from '../src/presence.ts';

test('a late subscriber gets the agent at once, and the agent leaves the roster after its last command ended', () => {
  vi.useFakeTimers();
  const hub = new PresenceHub();
  const key = 'device';
  hub.agent(key, 'press', 'start');
  const seen: unknown[] = [];
  const unsubscribe = hub.subscribe(key, (participants) => seen.push(participants));
  hub.agent(key, 'press', 'end');
  vi.advanceTimersByTime(AGENT_LINGER_MS - 1);
  hub.agent(key, 'scroll', 'start');
  hub.agent(key, 'scroll', 'end');
  vi.advanceTimersByTime(AGENT_LINGER_MS);
  const agent = { id: 'a1', kind: 'agent', color: 1 };
  expect(seen).toEqual([
    [{ ...agent, name: 'Agent \u00b7 press' }],
    [{ ...agent, name: 'Agent \u00b7 press' }],
    [{ ...agent, name: 'Agent \u00b7 scroll' }],
    [{ ...agent, name: 'Agent \u00b7 scroll' }],
    [{ ...agent, name: 'Agent \u00b7 scroll', touch: null }],
  ]);
  unsubscribe();
  hub.close();
});

describe('human presence', () => {
  const ann = { id: 'v1', kind: 'viewer' as const, name: 'Ann', color: 2 };
  const at = (phase: 'down' | 'move' | 'up', x: number) => ({ phase, x, y: 0.5, at: 1 });

  test('moves reach subscribers once per tick with the latest point, while down and up go at once and in order', () => {
    vi.useFakeTimers();
    const hub = new PresenceHub();
    const seen: { id: string; phase?: string; x?: number }[][] = [];
    hub.subscribe('d', (participants) =>
      seen.push(participants.map((p) => ({ id: p.id, ...(p.touch ? { phase: p.touch.phase, x: p.touch.x } : {}) }))),
    );
    hub.touch('d', ann, at('down', 0.1));
    for (const x of [0.2, 0.3, 0.4]) hub.touch('d', ann, at('move', x));
    expect(seen).toEqual([[], [{ id: 'v1', phase: 'down', x: 0.1 }]]);
    vi.advanceTimersByTime(MOVE_FLUSH_MS);
    hub.touch('d', ann, at('move', 0.5));
    hub.touch('d', ann, at('up', 0.6));
    expect(seen.slice(2)).toEqual([
      [{ id: 'v1', phase: 'move', x: 0.4 }],
      [{ id: 'v1', phase: 'move', x: 0.5 }],
      [{ id: 'v1', phase: 'up', x: 0.6 }],
    ]);
    hub.close();
  });

  test('a participant stays on the roster for a late subscriber until it leaves', () => {
    const hub = new PresenceHub();
    hub.join('d', ann);
    const seen: unknown[] = [];
    hub.subscribe('d', (participants) => seen.push(participants));
    hub.leave('d', 'v1');
    hub.leave('d', 'v1');
    expect(seen).toEqual([[ann], [{ ...ann, touch: null }]]);
    hub.close();
  });
});

describe('agent actions another machine published', () => {
  const agent = { id: 'a1', kind: 'agent', name: 'Agent · press', color: 1 };
  const gesture = {
    kind: 'tap',
    from: { x: 0.5, y: 0.5 },
    durationMs: 0,
    target: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  };

  test('takes the agent with its command and gesture, and nothing else a host Mac could put in the event', () => {
    expect(parseHostedAgent([{ ...agent, gesture }, agent, { ...agent, touch: null }])).toEqual([
      { command: 'press', gesture },
      { command: 'press' },
    ]);
    expect(
      parseHostedAgent([
        { id: 'v1', kind: 'viewer', name: 'Agent · press', color: 2 },
        { ...agent, name: 'Ann' },
        { ...agent, name: 'Agent · Press; rm' },
        { ...agent, gesture: { kind: 'tap', from: { x: 'left', y: 0 }, durationMs: 0 } },
        null,
      ]),
    ).toEqual([]);
    expect(parseHostedAgent({ participants: [agent] })).toEqual([]);
  });
});
