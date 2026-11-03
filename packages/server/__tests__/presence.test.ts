import { AGENT_LINGER_MS, PresenceHub } from '../src/presence.ts';

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
    [{ ...agent, name: 'Agent · press' }],
    [{ ...agent, name: 'Agent · press' }],
    [{ ...agent, name: 'Agent · scroll' }],
    [{ ...agent, name: 'Agent · scroll' }],
    [{ ...agent, name: 'Agent · scroll', touch: null }],
  ]);
  unsubscribe();
  hub.close();
});
