import { HostConnections, HostedRelay, type Upstream } from '../src/hosted-relay.ts';
import { parseInput } from '../src/control.ts';
import type { AuditRecord } from '../src/actions.ts';
import type { ServerMessage } from '../src/protocol.ts';
import { videoPacket, videoSubscription } from '../src/video.ts';

it.each([
  ['ios', 'default'],
  ['ios', 'tablet'],
  ['android', 'default'],
  ['android', 'tablet'],
] as const)('preserves the hosted %s target and frame metadata for slot %s without sockets', async (platform, slot) => {
  const messages: (ServerMessage | Buffer)[] = [];
  const audit: AuditRecord[] = [];
  const routes = new Map<
    string,
    { event: (event: Record<string, unknown> | Buffer) => void; closed: (error: Error) => void }
  >();
  const release = vi.fn<() => void>();
  const request = vi.fn<(method: string, params: unknown) => Promise<{ result: Record<string, unknown> }>>(
    async (method) => ({
      result:
        method === 'device-host.frames.subscribe'
          ? { subscription: 'upstream', video: 'h264' }
          : method === 'device-host.control.begin'
            ? { session: 'host-control', postures: ['folded', 'unfolded'] }
            : method === 'device-host.attach'
              ? { state: 'stopped' }
              : {},
    }),
  );
  const connection = {
    request,
    supports: () => false,
    route: (name: string, route: Parameters<Upstream['route']>[1]) => {
      routes.set(name, route);
      return () => {
        routes.delete(name);
      };
    },
  } as unknown as Upstream;
  const hosts = { acquire: async () => ({ connection, release }) } as unknown as HostConnections;
  const dropped: string[] = [];
  const relay = new HostedRelay(
    hosts,
    (message) => messages.push(message),
    () => 0,
    () => 'local',
    (id) => dropped.push(id),
    (record) => audit.push(record),
  );
  const host = { machine: 'mini', session: 'host-session' };
  await relay.subscribe(1, host, { platform, slot, deviceFrame: platform === 'ios' ? true : undefined }, () => {});
  expect(request).toHaveBeenCalledWith('device-host.frames.subscribe', {
    session: 'host-session',
    fps: undefined,
    maxEdge: undefined,
    video: undefined,
    deviceFrame: platform === 'ios' ? true : undefined,
  });
  const frames = routes.get('s:upstream')!;
  frames.event({
    event: 'frame',
    subscription: 'upstream',
    platform,
    slot: 'private',
    data: 'jpeg',
    artworkTurns: 3,
    posture: 'folded',
  });
  if (platform === 'ios')
    frames.event({ event: 'device-frame', subscription: 'upstream', artwork: { foreground: 'image' } });
  frames.event({ event: 'frame-delayed', subscription: 'upstream', delayed: true });
  const packet = videoPacket('upstream', 7, {
    keyframe: true,
    width: 400,
    height: 800,
    artworkTurns: 3,
    posture: 'folded',
    capturedAt: 123,
    data: Buffer.from([1, 2, 3]),
  });
  frames.event(packet);
  const count = platform === 'ios' ? 3 : 2;
  expect(messages.slice(0, count)).toEqual([
    {
      event: 'frame',
      subscription: 'local',
      platform,
      slot,
      data: 'jpeg',
      artworkTurns: 3,
      posture: 'folded',
    },
    ...(platform === 'ios'
      ? [{ event: 'device-frame', subscription: 'local', platform, slot, artwork: { foreground: 'image' } }]
      : []),
    { event: 'frame-delayed', subscription: 'local', platform, slot, delayed: true },
  ]);
  const video = messages[count] as Buffer;
  expect(videoSubscription(video)).toBe('local');
  expect(video[1]).toBe(packet[1]);
  expect(video.subarray(26)).toEqual(Buffer.from([1, 2, 3]));
  expect(relay.keyframe(2, 'local')).toBe(true);
  expect(request).toHaveBeenCalledWith('device-host.frames.keyframe', { subscription: 'upstream' });
  await relay.begin(3, host, false, () => true, {
    workspace: '/w',
    device: { id: 'viewer', name: 'Desktop' },
    platform,
    slot,
  });
  expect(relay.targetOf('h1')).toEqual({ platform, slot, postures: ['folded', 'unfolded'] });
  const targetOf = (session: string) => relay.targetOf(session);
  expect(parseInput('input.posture', { session: 'h1', posture: 'folded' }, targetOf)).toHaveProperty('value');
  expect(parseInput('input.window', { session: 'h1', window: 1 }, targetOf)).toHaveProperty('code', 'bad-request');
  relay.control(4, 'input.touch', { session: 'h1', phase: 'down', x: 0.2, y: 0.7 });
  expect(request).toHaveBeenCalledWith('device-host.input.touch', {
    session: 'host-control',
    phase: 'down',
    x: 0.2,
    y: 0.7,
  });
  routes
    .get('c:host-control')!
    .event({ event: 'control-ended', session: 'host-control', reason: 'device-gone', message: 'stopped' });
  expect(messages).toContainEqual({
    event: 'control-ended',
    session: 'h1',
    platform,
    slot,
    reason: 'device-gone',
    message: 'stopped',
  });
  expect(relay.targetOf('h1')).toBeNull();
  expect(audit).toEqual([
    expect.objectContaining({ platform, slot, action: 'control.begin' }),
    expect.objectContaining({ platform, slot, action: 'control.end' }),
  ]);
  frames.closed(new Error('host offline'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(messages.at(-1)).toMatchObject({
    event: 'error',
    subscription: 'local',
    platform,
    slot,
    error: { code: 'frames-failed' },
  });
  expect(dropped).toEqual(['local']);
  expect(release).toHaveBeenCalled();
  relay.close();
});

async function clipboardCalls(supported: boolean) {
  const messages: (ServerMessage | Buffer)[] = [];
  const request = vi.fn<(method: string, params: unknown) => Promise<{ result: Record<string, unknown> }>>(
    async (method) => ({
      result:
        method === 'device-host.control.begin'
          ? { session: 'host-control', postures: [] }
          : method === 'device-host.input.clipboard.get'
            ? { text: 'from the host' }
            : {},
    }),
  );
  const connection = {
    request,
    supports: (feature: string) => supported && (feature === 'device-clipboard' || feature === 'device-keyboard'),
    route: () => () => {},
  } as unknown as Upstream;
  const hosts = { acquire: async () => ({ connection, release: () => {} }) } as unknown as HostConnections;
  const relay = new HostedRelay(
    hosts,
    (message) => messages.push(message),
    () => 0,
    () => 'local',
    () => {},
    () => {},
  );
  await relay.begin(1, { machine: 'mini', session: 'host-session' }, false, () => true, {
    workspace: '/w',
    device: { id: 'viewer', name: 'Desktop' },
    platform: 'ios',
    slot: 'default',
  });
  const begun = request.mock.calls.length;
  relay.control(2, 'input.clipboard.set', { session: 'h1', text: 'abc', paste: true });
  relay.control(3, 'input.clipboard.get', { session: 'h1' });
  relay.control(4, 'input.key', { session: 'h1', key: 'a', modifiers: ['command'] });
  relay.control(5, 'input.key', { session: 'h1', key: 'left', modifiers: [] });
  const answers = () =>
    messages.filter((message) => 'id' in message && typeof message.id === 'number' && message.id >= 2);
  await vi.waitFor(() => expect(answers()).toHaveLength(4));
  return { sent: request.mock.calls.slice(begun), answers: answers() };
}

it('forwards the clipboard calls to a hosted session whose host advertises device-clipboard', async () => {
  const { sent, answers } = await clipboardCalls(true);
  expect(sent).toEqual([
    ['device-host.input.clipboard.set', { session: 'host-control', text: 'abc', paste: true }],
    ['device-host.input.clipboard.get', { session: 'host-control' }],
    ['device-host.input.key', { session: 'host-control', key: 'a', modifiers: ['command'] }],
    ['device-host.input.key', { session: 'host-control', key: 'left', modifiers: [] }],
  ]);
  expect(answers).toEqual([
    { id: 2, result: {} },
    { id: 3, result: { text: 'from the host' } },
    { id: 4, result: {} },
    { id: 5, result: {} },
  ]);
});

it('refuses the clipboard calls and key chords for a host without the feature, sending only the bare arrow', async () => {
  const { sent, answers } = await clipboardCalls(false);
  expect(sent).toEqual([['device-host.input.key', { session: 'host-control', key: 'left', modifiers: [] }]]);
  expect(answers).toEqual([
    { id: 2, error: { code: 'action-failed', message: expect.stringContaining('update its Stim') } },
    { id: 3, error: { code: 'action-failed', message: expect.stringContaining('update its Stim') } },
    { id: 4, error: { code: 'action-failed', message: expect.stringContaining('update its Stim') } },
    { id: 5, result: {} },
  ]);
});

describe('presence of a hosted device on the relay', () => {
  function relayOf() {
    const routes = new Map<string, Parameters<Upstream['route']>[1]>();
    const connection = {
      request: async (method: string) => ({
        result:
          method === 'device-host.frames.subscribe'
            ? { subscription: 'upstream' }
            : method === 'device-host.attach'
              ? { state: 'stopped' }
              : { session: 'host-control' },
      }),
      supports: () => false,
      route: (name: string, route: Parameters<Upstream['route']>[1]) => {
        routes.set(name, route);
        return () => routes.delete(name);
      },
    } as unknown as Upstream;
    const touch = vi.fn<(key: string, who: unknown, touch: unknown) => void>();
    const leave = vi.fn<(key: string, id: string) => void>();
    const relay = new HostedRelay(
      { acquire: async () => ({ connection, release: () => {} }) } as unknown as HostConnections,
      () => {},
      () => 0,
      () => 'local',
      () => {},
      () => {},
      { touch, leave },
    );
    return { relay, routes, touch, leave };
  }
  const host = { machine: 'mini', session: 'host-session' };

  it("shows the connection's own touches on a hosted device as the host's and takes them off when control ends", async () => {
    const f = relayOf();
    await f.relay.begin(1, host, false, () => true, {
      workspace: '/w',
      device: { id: 'viewer', name: 'Desktop' },
      platform: 'ios',
      slot: 'tablet',
    });
    f.relay.control(2, 'input.touch', { session: 'h1', phase: 'down', x: 0.2, y: 0.7 });
    f.relay.control(3, 'input.touch', { session: 'h1', phase: 'up', x: 0.3, y: 0.8, x2: 0.4, y2: 0.9 });
    f.relay.control(4, 'input.touch', { session: 'h1', phase: 'sideways', x: 0.2, y: 0.7 });
    const key = JSON.stringify(['/w', 'ios', 'tablet', false]);
    const who = { id: 'h1', kind: 'host', name: 'Host', color: 0 };
    expect(f.touch.mock.calls).toEqual([
      [key, who, { phase: 'down', x: 0.2, y: 0.7, at: expect.any(Number) }],
      [key, who, { phase: 'up', x: 0.3, y: 0.8, second: { x: 0.4, y: 0.9 }, at: expect.any(Number) }],
    ]);
    f.relay.control(5, 'control.end', { session: 'h1' });
    expect(f.leave).toHaveBeenCalledWith(key, 'h1');
  });

  it('starts presence for a subscription once it has its local id, and stops it when the subscription ends', async () => {
    const f = relayOf();
    const stop = vi.fn<() => void>();
    const presence = vi.fn<(subscription: string) => () => void>(() => stop);
    await f.relay.subscribe(1, host, { platform: 'ios', slot: 'default' }, () => {}, presence);
    expect(presence).toHaveBeenCalledWith('local');
    f.routes.get('s:upstream')!.closed(new Error('host offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('a hosted frame subscription whose host connection drops', () => {
  type Route = Parameters<Upstream['route']>[1];
  const isError = (message: ServerMessage | Buffer) =>
    !Buffer.isBuffer(message) && 'event' in message && message.event === 'error';
  const host = { machine: 'mini', session: 'host-session' };

  function routeOf(routes: Map<string, Route>[], generation: number, name: string): Route {
    const found = routes[generation]?.get(name);
    if (!found) throw new Error(`no route ${name} on connection ${generation}`);
    return found;
  }

  function setup(
    attach: () => { state: string } | { error: { code: string; message: string } } | Promise<never>,
    videoOf: (generation: number) => 'h264' | undefined = () => undefined,
  ) {
    const messages: (ServerMessage | Buffer)[] = [];
    const dropped: string[] = [];
    const subscribes: unknown[] = [];
    const routes: Map<string, Route>[] = [];
    let generation = 0;
    const acquire = vi.fn<HostConnections['acquire']>(async () => {
      const mine = generation++;
      const own = new Map<string, Route>();
      routes[mine] = own;
      const connection = {
        request: async (method: string, params: unknown) => {
          if (method === 'device-host.attach') {
            const answer = await attach();
            return 'error' in answer ? answer : { result: answer };
          }
          if (method === 'device-host.frames.subscribe') {
            subscribes.push(params);
            return { result: { subscription: `upstream-${mine}`, ...(videoOf(mine) ? { video: videoOf(mine) } : {}) } };
          }
          return { result: {} };
        },
        supports: () => false,
        route: (name: string, route: Route) => {
          own.set(name, route);
          return () => own.delete(name);
        },
      } as unknown as Upstream;
      return { connection, release: () => {} };
    });
    const relay = new HostedRelay(
      { acquire } as unknown as HostConnections,
      (message) => messages.push(message),
      () => 0,
      () => 'local',
      (id) => dropped.push(id),
      () => {},
    );
    return { relay, messages, dropped, subscribes, routes, acquire };
  }

  it('subscribes again with the same parameters and keeps the local subscription and its viewer', async () => {
    const f = setup(() => ({ state: 'ready' }));
    await f.relay.subscribe(1, host, { platform: 'ios', slot: 'default', fps: 5 }, () => {});
    routeOf(f.routes, 0, 's:upstream-0').closed(new Error('the host connection closed'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(f.subscribes).toHaveLength(2);
    expect(f.subscribes[1]).toEqual(f.subscribes[0]);
    routeOf(f.routes, 1, 's:upstream-1').event({ event: 'frame', subscription: 'upstream-1', data: 'jpeg' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.messages).toContainEqual(expect.objectContaining({ event: 'frame', subscription: 'local' }));
    expect(f.messages.some(isError)).toBe(false);
    expect(f.dropped).toEqual([]);
    expect(f.relay.keyframe(2, 'local')).toBe(true);
  });

  it('waits while the host session is not ready and gives up when it stopped', async () => {
    const states = ['unknown', 'unknown', 'stopped'];
    const f = setup(() => ({ state: states.shift() ?? 'stopped' }));
    await f.relay.subscribe(1, host, { platform: 'ios', slot: 'default' }, () => {});
    routeOf(f.routes, 0, 's:upstream-0').closed(new Error('the host connection closed'));
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    expect(f.subscribes).toHaveLength(1);
    expect(f.messages.at(-1)).toMatchObject({
      event: 'error',
      subscription: 'local',
      error: { code: 'frames-failed', message: expect.stringContaining('the hosted session stopped') },
    });
    expect(f.dropped).toEqual(['local']);
  });

  it('fails the subscription once the host has not come back for three minutes', async () => {
    const f = setup(() => Promise.reject(new Error('the host did not connect in time')));
    await f.relay.subscribe(1, host, { platform: 'ios', slot: 'default' }, () => {});
    routeOf(f.routes, 0, 's:upstream-0').closed(new Error('the host connection closed'));
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(f.messages.at(-1)).toMatchObject({
      event: 'error',
      subscription: 'local',
      error: { code: 'frames-failed', message: expect.stringContaining('the host did not connect in time') },
    });
    expect(f.acquire.mock.calls.length).toBeGreaterThan(3);
  });

  it('fails at once when the host refuses this machine, and when it now streams another video format', async () => {
    const revoked = setup(() => ({ error: { code: 'forbidden', message: 'This machine lost device-host access.' } }));
    await revoked.relay.subscribe(1, host, { platform: 'ios', slot: 'default' }, () => {});
    routeOf(revoked.routes, 0, 's:upstream-0').closed(new Error('the host connection closed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoked.messages.at(-1)).toMatchObject({
      event: 'error',
      error: { message: expect.stringContaining('lost device-host access') },
    });

    const reformatted = setup(
      () => ({ state: 'ready' }),
      (generation) => (generation === 0 ? 'h264' : undefined),
    );
    await reformatted.relay.subscribe(1, host, { platform: 'ios', slot: 'default', video: ['h264'] }, () => {});
    routeOf(reformatted.routes, 0, 's:upstream-0').closed(new Error('the host connection closed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reformatted.messages.at(-1)).toMatchObject({
      event: 'error',
      error: { message: expect.stringContaining('another video format') },
    });
  });

  it('does not subscribe again once the viewer stopped while it waited', async () => {
    const f = setup(() => ({ state: 'ready' }));
    const stops: (() => void)[] = [];
    await f.relay.subscribe(1, host, { platform: 'ios', slot: 'default' }, (_id, stopper) => stops.push(stopper));
    routeOf(f.routes, 0, 's:upstream-0').closed(new Error('the host connection closed'));
    stops.forEach((stop) => stop());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(f.subscribes).toHaveLength(1);
    expect(f.messages.some(isError)).toBe(false);
  });
});
