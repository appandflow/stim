import type { AuditRecord } from '../src/actions.ts';
import type { Controller } from '../src/control.ts';
import type { PresenceParticipant } from '../src/protocol.ts';
import type { HostConnections, Upstream } from '../src/hosted-relay.ts';
import { HostedShareSource } from '../src/share-hosted.ts';
import { videoPacket } from '../src/video.ts';

type Route = Parameters<Upstream['route']>[1];
type Presence = ConstructorParameters<typeof HostedShareSource>[4];

function fixture(replies: Record<string, unknown> = {}, features: string[] = [], shown?: Presence) {
  const routes = new Map<string, Route>();
  const requests: { method: string; params: unknown }[] = [];
  const released = vi.fn<() => void>();
  let acquires = 0;
  const connection = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      const answer = replies[method];
      const reply = typeof answer === 'function' ? answer() : answer;
      if (reply && typeof reply === 'object' && 'error' in reply) return reply;
      return { result: reply ?? {} };
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
  const audit: AuditRecord[] = [];
  const source = new HostedShareSource(
    hosts,
    { machine: 'mini', session: 'host-session', ready: true },
    { platform: 'ios' },
    (record) => audit.push(record),
    shown,
  );
  return { source, routes, requests, released, audit, acquires: () => acquires };
}

const unusedCommand = {} as never;
const viewer: PresenceParticipant = { id: 's1-v1', kind: 'viewer', name: 'Guest 1', color: 2 };
const hint = { fps: 10, maxEdge: 1280 };
const listener = () => ({
  frame: vi.fn<(frame: unknown) => void>(),
  delayed: vi.fn<(delayed: boolean) => void>(),
  failed: vi.fn<(message: string) => void>(),
});
const frame = { event: 'frame', subscription: 'up', width: 1, height: 1, capturedAt: '', data: 'jpeg' };
const delivered = { width: 1, height: 1, capturedAt: '', data: 'jpeg' };
const owner: Controller = { device: { id: 'share-w1', name: 'Web share' }, send: vi.fn<(message: unknown) => void>() };

describe('a share of a hosted device', () => {
  it('holds one host subscription for all viewers, replays the latest frame to a late one, and releases it with the last', async () => {
    const f = fixture({ 'device-host.frames.subscribe': { subscription: 'up' } });
    const first = listener();
    const stopFirst = f.source.subscribe(first, hint);
    await vi.waitFor(() => expect(f.routes.has('s:up')).toBe(true));
    expect(f.requests).toEqual([
      { method: 'device-host.frames.subscribe', params: { session: 'host-session', fps: 10, maxEdge: 1280 } },
    ]);
    f.routes.get('s:up')!.event(frame);
    expect(first.frame).toHaveBeenCalledWith(delivered);

    const second = listener();
    const stopSecond = f.source.subscribe(second, hint);
    expect(second.frame).toHaveBeenCalledWith(delivered);
    expect(f.acquires()).toBe(1);

    stopFirst();
    expect(f.routes.has('s:up')).toBe(true);
    stopSecond();
    expect(f.routes.has('s:up')).toBe(false);
    await vi.waitFor(() => expect(f.released).toHaveBeenCalledTimes(1));
    expect(f.requests.at(-1)).toEqual({ method: 'device-host.unsubscribe', params: { subscription: 'up' } });
  });

  it('relays a WebRTC offer to the host and ends the peer when the host or the viewer does', async () => {
    const f = fixture({ 'device-host.webrtc.offer': { subscription: 'rtc1', sdp: 'answer-sdp' } }, ['hosted-webrtc']);
    const closed = vi.fn<(reason: string) => void>();
    const peer = await f.source.webrtc!('offer-sdp', closed);
    expect(peer.answer).toBe('answer-sdp');
    expect(f.requests).toEqual([
      { method: 'device-host.webrtc.offer', params: { session: 'host-session', sdp: 'offer-sdp' } },
    ]);
    f.routes.get('s:rtc1')!.event({ event: 'webrtc-closed', subscription: 'rtc1', message: 'WebRTC failed' });
    expect(closed).toHaveBeenCalledWith('WebRTC failed');

    peer.close();
    expect(f.routes.has('s:rtc1')).toBe(false);
    await vi.waitFor(() => expect(f.released).toHaveBeenCalledTimes(1));
    expect(f.requests.at(-1)).toEqual({ method: 'device-host.unsubscribe', params: { subscription: 'rtc1' } });
  });

  it('refuses a WebRTC offer to a host that does not list hosted-webrtc, without holding the connection', async () => {
    const f = fixture();
    await expect(f.source.webrtc!('offer-sdp', () => {})).rejects.toThrow('mini cannot send WebRTC');
    expect(f.requests).toEqual([]);
    expect(f.released).toHaveBeenCalledTimes(1);
  });

  it('asks the host for the device frame only when a viewer wants it, and replays the artwork to a late viewer', async () => {
    const f = fixture({ 'device-host.frames.subscribe': { subscription: 'up' } });
    const art = vi.fn<(artwork: unknown) => void>();
    f.source.subscribe({ ...listener(), artwork: art }, hint);
    await vi.waitFor(() => expect(f.routes.has('s:up')).toBe(true));
    expect(f.requests[0]).toEqual({
      method: 'device-host.frames.subscribe',
      params: { session: 'host-session', fps: 10, maxEdge: 1280, deviceFrame: true },
    });
    const artwork = {
      width: 2,
      height: 4,
      aperture: { x: 0, y: 0, width: 2, height: 4 },
      background: 'a',
      foreground: 'b',
    };
    f.routes.get('s:up')?.event({ event: 'device-frame', subscription: 'up', artwork });
    expect(art).toHaveBeenCalledWith(artwork);
    const late = vi.fn<(artwork: unknown) => void>();
    f.source.subscribe({ ...listener(), artwork: late }, hint);
    expect(late).toHaveBeenCalledWith(artwork);
  });

  it('opens an H.264 host subscription for video viewers beside the JPEG one, and asks it for keyframes and lower bitrate', async () => {
    let next = 0;
    const f = fixture({ 'device-host.frames.subscribe': () => ({ subscription: `up${++next}` }) }, [
      'hosted-congestion',
    ]);
    const jpeg = listener();
    f.source.subscribe(jpeg, hint);
    await vi.waitFor(() => expect(f.routes.has('s:up1')).toBe(true));
    const video = { ...listener(), video: vi.fn<(unit: unknown) => void>() };
    f.source.subscribe(video, { fps: 60, maxEdge: 1280 });
    await vi.waitFor(() => expect(f.routes.has('s:up2')).toBe(true));
    expect(f.requests).toEqual([
      { method: 'device-host.frames.subscribe', params: { session: 'host-session', fps: 10, maxEdge: 1280 } },
      {
        method: 'device-host.frames.subscribe',
        params: { session: 'host-session', fps: 60, maxEdge: 1280, video: ['h264'] },
      },
    ]);

    const unit = { keyframe: true, capturedAt: 5, width: 590, height: 1280, data: Buffer.from([0, 0, 0, 1, 0x65]) };
    f.routes.get('s:up2')!.event(videoPacket('up2', 0, unit));
    expect(video.video).toHaveBeenCalledWith(unit);
    f.routes.get('s:up1')!.event(frame);
    expect(jpeg.frame).toHaveBeenCalledWith(delivered);
    expect(video.frame).not.toHaveBeenCalled();

    f.source.keyframe();
    f.source.congested();
    f.source.congested();
    expect(f.requests.slice(2)).toEqual([
      { method: 'device-host.frames.keyframe', params: { subscription: 'up2' } },
      { method: 'device-host.frames.congested', params: { subscription: 'up2' } },
    ]);
  });

  it('never sends a congestion notice to a host that does not support it', async () => {
    const f = fixture({ 'device-host.frames.subscribe': { subscription: 'up' } });
    f.source.subscribe({ ...listener(), video: vi.fn<(unit: unknown) => void>() }, hint);
    await vi.waitFor(() => expect(f.routes.has('s:up')).toBe(true));
    f.source.congested();
    expect(f.requests.map((entry) => entry.method)).toEqual(['device-host.frames.subscribe']);
  });

  it('fails every viewer, naming the host, when the host refuses or ends the stream', async () => {
    const refused = fixture({
      'device-host.frames.subscribe': {
        error: { code: 'action-failed', message: 'Only a ready session can be viewed.' },
      },
    });
    const one = listener();
    refused.source.subscribe(one, hint);
    await vi.waitFor(() => expect(one.failed).toHaveBeenCalledWith('mini: Only a ready session can be viewed.'));
    expect(refused.released).toHaveBeenCalledTimes(1);

    const f = fixture({ 'device-host.frames.subscribe': { subscription: 'up' } });
    const a = listener();
    const b = listener();
    f.source.subscribe(a, hint);
    f.source.subscribe(b, hint);
    await vi.waitFor(() => expect(f.routes.has('s:up')).toBe(true));
    f.routes.get('s:up')!.closed(new Error('the host connection closed'));
    expect(a.failed).toHaveBeenCalledWith('mini: the host connection closed');
    expect(b.failed).toHaveBeenCalledWith('mini: the host connection closed');
  });

  it('begins control on the host session, forwards validated input to it and audits the session', async () => {
    const f = fixture({ 'device-host.control.begin': { session: 'hc1', postures: [] } });
    const began = await f.source.begin(owner, { workspace: '/w', platform: 'ios' }, '/w', () => true);
    expect(began).toMatchObject({ session: 'hc1' });
    expect(f.requests[0]).toEqual({
      method: 'device-host.control.begin',
      params: { session: 'host-session', takeOver: false },
    });
    expect(f.source.targetOf(owner, 'hc1')).toEqual({ platform: 'ios', slot: 'default', postures: [] });
    expect(f.source.targetOf(owner, 'other')).toBeNull();

    expect(
      await f.source.input(owner, 'hc1', 'input.touch', { phase: 'down', x: 0.5, y: 0.5 }, unusedCommand, viewer),
    ).toBeNull();
    expect(f.requests.at(-1)).toEqual({
      method: 'device-host.input.touch',
      params: { phase: 'down', x: 0.5, y: 0.5, session: 'hc1' },
    });
    expect(await f.source.input(owner, 'stale', 'input.touch', {}, unusedCommand, viewer)).toMatchObject({
      code: 'action-failed',
    });

    f.source.end(owner, 'older', 'The share ended.');
    expect(f.source.targetOf(owner, 'hc1')).not.toBeNull();

    f.source.endFor(owner, 'The last viewer left.');
    expect(f.requests.at(-1)).toEqual({ method: 'device-host.control.end', params: { session: 'hc1' } });
    expect(f.audit.map((record) => [record.action, record.ok])).toEqual([
      ['control.begin', true],
      ['control.end', true],
    ]);
  });

  it('forwards the clipboard calls to a host that advertises device-clipboard and returns the text it read', async () => {
    const f = fixture(
      {
        'device-host.control.begin': { session: 'hc1', postures: [] },
        'device-host.input.clipboard.get': { text: 'host text' },
      },
      ['device-clipboard'],
    );
    await f.source.begin(owner, { workspace: '/w', platform: 'ios' }, '/w', () => true);
    expect(
      await f.source.input(owner, 'hc1', 'input.clipboard.set', { text: 'abc', paste: true }, unusedCommand, viewer),
    ).toBeNull();
    expect(f.requests.at(-1)).toEqual({
      method: 'device-host.input.clipboard.set',
      params: { text: 'abc', paste: true, session: 'hc1' },
    });
    expect(await f.source.input(owner, 'hc1', 'input.clipboard.get', {}, unusedCommand, viewer)).toEqual({
      text: 'host text',
    });
  });

  it('returns only the typed flag of a hosted clipboard set', async () => {
    const f = fixture(
      {
        'device-host.control.begin': { session: 'hc1', postures: [] },
        'device-host.input.clipboard.set': { typed: true, extra: 1 },
      },
      ['device-clipboard'],
    );
    await f.source.begin(owner, { workspace: '/w', platform: 'ios' }, '/w', () => true);
    expect(
      await f.source.input(owner, 'hc1', 'input.clipboard.set', { text: 'abc', paste: true }, unusedCommand, viewer),
    ).toEqual({ typed: true });
  });

  it('refuses the clipboard calls for a host without device-clipboard, without sending them', async () => {
    const f = fixture({ 'device-host.control.begin': { session: 'hc1', postures: [] } });
    await f.source.begin(owner, { workspace: '/w', platform: 'ios' }, '/w', () => true);
    const before = f.requests.length;
    for (const method of ['input.clipboard.set', 'input.clipboard.get']) {
      expect(await f.source.input(owner, 'hc1', method, { text: 'abc' }, unusedCommand, viewer)).toMatchObject({
        code: 'action-failed',
      });
    }
    expect(f.requests).toHaveLength(before);
  });

  it('returns the host refusal when control is refused, and tells the viewer owner when the host ends control', async () => {
    const busy = { error: { code: 'device-busy', message: 'Another client controls this device.' } };
    const refused = fixture({ 'device-host.control.begin': busy });
    expect(await refused.source.begin(owner, { workspace: '/w', platform: 'ios' }, '/w', () => true)).toEqual(
      busy.error,
    );
    expect(refused.released).toHaveBeenCalledTimes(1);
    expect(refused.audit[0]).toMatchObject({ action: 'control.begin', ok: false });

    const f = fixture({ 'device-host.control.begin': { session: 'hc1', postures: [] } });
    const send = vi.fn<(message: unknown) => void>();
    const watcher: Controller = { ...owner, send };
    await f.source.begin(watcher, { workspace: '/w', platform: 'ios' }, '/w', () => true);
    f.routes
      .get('c:hc1')!
      .event({ event: 'control-ended', session: 'hc1', reason: 'taken-over', message: 'Taken over.' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ event: 'control-ended', session: 'hc1' }));
    expect(f.source.targetOf(watcher, 'hc1')).toBeNull();
    expect(f.released).toHaveBeenCalledTimes(1);
  });
});

describe('presence on a share of a hosted device', () => {
  const ann: PresenceParticipant = { id: 's1-v1', kind: 'viewer', name: 'Ann', color: 2 };
  const bob: PresenceParticipant = { id: 's1-v2', kind: 'viewer', name: 'Bob', color: 3 };
  const touch = (phase: 'down' | 'move' | 'up', x = 0.5) => ({ input: 'touch', phase, x, y: 0.25 }) as never;

  async function shared(replies: Record<string, unknown> = {}) {
    const hub = {
      subscribe: vi.fn<(key: string, listener: unknown) => () => void>(() => vi.fn<() => void>()),
      join: vi.fn<(key: string, who: unknown) => void>(),
      leave: vi.fn<(key: string, id: string) => void>(),
      touch: vi.fn<(key: string, who: unknown, touch: unknown) => void>(),
    };
    const unfollow = vi.fn<() => void>();
    const follow = vi.fn<(key: string) => () => void>(() => unfollow);
    const f = fixture({ 'device-host.control.begin': { session: 'hc1', postures: [] }, ...replies }, [], {
      hub,
      key: 'device',
      follow,
    });
    await f.source.begin(owner, { workspace: '/w', platform: 'ios' }, '/w', () => true);
    const send = (who: PresenceParticipant, command: unknown) =>
      f.source.input(owner, 'hc1', 'input.touch', { ...(command as object) }, command as never, who);
    const lifts = () => f.requests.filter((request) => (request.params as { phase?: string }).phase === 'up');
    return { ...f, hub, follow, unfollow, send, lifts };
  }

  it("follows the host's presence for the device while a viewer listens, and lists viewers on the device's roster", async () => {
    const f = await shared();
    const seen = vi.fn<(participants: PresenceParticipant[]) => void>();
    const stop = f.source.presence!.subscribe(seen);
    expect(f.follow).toHaveBeenCalledWith('device');
    expect(f.hub.subscribe).toHaveBeenCalledWith('device', seen);
    f.source.presence!.join(ann);
    f.source.presence!.leave(ann.id);
    expect(f.hub.join).toHaveBeenCalledWith('device', ann);
    expect(f.hub.leave).toHaveBeenCalledWith('device', ann.id);
    stop();
    expect(f.unfollow).toHaveBeenCalledTimes(1);
  });

  it('shows a viewer touch and drops the other viewer touches until the holder lifts, naming the holder', async () => {
    const f = await shared();
    expect(await f.send(ann, touch('down'))).toBeNull();
    expect(await f.send(bob, touch('down', 0.9))).toEqual({
      code: 'device-busy',
      message: 'Ann is using the screen.',
      busy: 'Ann',
    });
    expect(await f.send(bob, touch('move', 0.8))).toBeNull();
    expect(await f.send(ann, touch('move', 0.6))).toBeNull();
    expect(await f.send(ann, touch('up', 0.6))).toBeNull();
    expect(await f.send(bob, touch('down', 0.9))).toBeNull();
    expect(
      f.requests.filter((request) => request.method === 'device-host.input.touch').map((request) => request.params),
    ).toEqual([
      expect.objectContaining({ phase: 'down', x: 0.5 }),
      expect.objectContaining({ phase: 'move', x: 0.6 }),
      expect.objectContaining({ phase: 'up', x: 0.6 }),
      expect.objectContaining({ phase: 'down', x: 0.9 }),
    ]);
    expect(
      f.hub.touch.mock.calls.map(([, who, shown]) => [
        (who as PresenceParticipant).name,
        (shown as { phase: string }).phase,
      ]),
    ).toEqual([
      ['Ann', 'down'],
      ['Ann', 'move'],
      ['Ann', 'up'],
      ['Bob', 'down'],
    ]);
  });

  it("names the host when another client there holds the device's pointer, and frees the share's pointer", async () => {
    const answers = [{ error: { code: 'device-busy', message: 'Host is using the screen.' } }, {}];
    const f = await shared({ 'device-host.input.touch': () => answers.shift() });
    expect(await f.send(ann, touch('down'))).toMatchObject({ code: 'device-busy', busy: 'Host' });
    expect(f.hub.touch.mock.calls.at(-1)?.slice(1)).toEqual([ann, expect.objectContaining({ phase: 'up' })]);
    expect(await f.send(bob, touch('down', 0.9))).toBeNull();
  });

  it('lifts the pointer for a holder that went quiet for 10 s or left, so the device is not stuck pressed', async () => {
    vi.useFakeTimers();
    const f = await shared();
    await f.send(ann, touch('down'));
    await f.send(ann, touch('move', 0.7));
    vi.advanceTimersByTime(9_999);
    expect(f.lifts()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(f.lifts()).toEqual([
      { method: 'device-host.input.touch', params: { session: 'hc1', phase: 'up', x: 0.7, y: 0.25 } },
    ]);
    expect(f.hub.touch.mock.calls.at(-1)?.[2]).toMatchObject({ phase: 'up', x: 0.7 });
    expect(await f.send(bob, touch('down', 0.1))).toBeNull();

    f.source.release(owner, 'hc1', bob);
    expect(f.lifts()).toHaveLength(2);
    f.source.release(owner, 'hc1', bob);
    expect(f.lifts()).toHaveLength(2);
  });
});
