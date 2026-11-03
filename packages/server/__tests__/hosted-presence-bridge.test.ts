import type { HostConnections, Upstream } from '../src/hosted-relay.ts';
import { HostedPresenceBridge } from '../src/hosted-presence-bridge.ts';

type Route = Parameters<Upstream['route']>[1];

function fixture(features: string[] = ['hosted-presence'], reply: unknown = { result: { subscription: 'up' } }) {
  const routes = new Map<string, Route>();
  const requests: { method: string; params: unknown }[] = [];
  const released = vi.fn<() => void>();
  let acquires = 0;
  const connection = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return method === 'device-host.presence.subscribe' ? reply : { result: {} };
    },
    route: (name: string, route: Route) => {
      routes.set(name, route);
      return () => routes.delete(name);
    },
    supports: (feature: string) => features.includes(feature),
  } as unknown as Upstream;
  const hosts = {
    acquire: async () => {
      acquires++;
      return { connection, release: released };
    },
  } as unknown as Pick<HostConnections, 'acquire'>;
  const agent = vi.fn<(key: string, command: string, phase: string, gesture?: unknown) => void>();
  const bridge = new HostedPresenceBridge(hosts, { agent: agent as never });
  return { bridge, routes, requests, released, agent, acquires: () => acquires };
}

const host = { machine: 'mini', session: 'host-session' };
const agent = { id: 'a1', kind: 'agent', name: 'Agent · press', color: 1 };
const gesture = { kind: 'tap', from: { x: 0.5, y: 0.5 }, durationMs: 0 };

test("puts the agent actions the host publishes into the hub under the device's key, once for all followers", async () => {
  const f = fixture();
  const stopFirst = f.bridge.follow('key', host);
  const stopSecond = f.bridge.follow('key', host);
  await vi.waitFor(() => expect(f.routes.has('s:up')).toBe(true));
  expect(f.requests).toEqual([{ method: 'device-host.presence.subscribe', params: { session: 'host-session' } }]);
  expect(f.acquires()).toBe(1);
  f.routes.get('s:up')!.event({ event: 'presence', subscription: 'up', participants: [{ ...agent, gesture }] });
  f.routes.get('s:up')!.event({ event: 'presence', subscription: 'up', participants: [{ ...agent, kind: 'host' }] });
  expect(f.agent.mock.calls).toEqual([['key', 'press', 'end', gesture]]);

  stopFirst();
  expect(f.routes.has('s:up')).toBe(true);
  stopSecond();
  expect(f.routes.has('s:up')).toBe(false);
  await vi.waitFor(() => expect(f.released).toHaveBeenCalledTimes(1));
  expect(f.requests.at(-1)).toEqual({ method: 'device-host.unsubscribe', params: { subscription: 'up' } });
});

test('asks a host that does not list hosted-presence for nothing, and gives up quietly when the host refuses', async () => {
  const old = fixture(['presence']);
  old.bridge.follow('key', host);
  await vi.waitFor(() => expect(old.released).toHaveBeenCalledTimes(1));
  expect(old.requests).toEqual([]);

  const refused = fixture(['hosted-presence'], { error: { code: 'unknown-session', message: 'No such session.' } });
  refused.bridge.follow('key', host);
  await vi.waitFor(() => expect(refused.released).toHaveBeenCalledTimes(1));
  expect(refused.routes.size).toBe(0);
});

test('lets go of the host when it was stopped before the subscription opened', async () => {
  const f = fixture();
  f.bridge.follow('key', host)();
  await vi.waitFor(() => expect(f.released).toHaveBeenCalledTimes(1));
  expect(f.requests).toEqual([]);
});

test('opens a new host subscription for a later follower once the host connection was lost', async () => {
  const f = fixture();
  f.bridge.follow('key', host);
  await vi.waitFor(() => expect(f.routes.has('s:up')).toBe(true));
  f.routes.get('s:up')?.closed(new Error('the host connection closed'));
  f.bridge.follow('key', host);
  await vi.waitFor(() =>
    expect(f.requests.filter((r) => r.method === 'device-host.presence.subscribe')).toHaveLength(2),
  );
});
