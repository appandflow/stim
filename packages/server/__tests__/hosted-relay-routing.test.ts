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
  expect(messages.at(-1)).toMatchObject({
    event: 'error',
    subscription: 'local',
    platform,
    slot,
    error: { code: 'frames-failed' },
  });
  expect(dropped).toEqual(['local']);
  expect(release).toHaveBeenCalledTimes(2);
  relay.close();
});
