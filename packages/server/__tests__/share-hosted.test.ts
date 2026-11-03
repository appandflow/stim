import type { AuditRecord } from '../src/actions.ts';
import type { Controller } from '../src/control.ts';
import type { HostConnections, Upstream } from '../src/hosted-relay.ts';
import { HostedShareSource } from '../src/share-hosted.ts';
import { videoPacket } from '../src/video.ts';

type Route = Parameters<Upstream['route']>[1];

function fixture(replies: Record<string, unknown> = {}, features: string[] = []) {
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
  );
  return { source, routes, requests, released, audit, acquires: () => acquires };
}

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
      await f.source.input(owner, 'hc1', 'input.touch', { phase: 'down', x: 0.5, y: 0.5 }, {} as never),
    ).toBeNull();
    expect(f.requests.at(-1)).toEqual({
      method: 'device-host.input.touch',
      params: { phase: 'down', x: 0.5, y: 0.5, session: 'hc1' },
    });
    expect(await f.source.input(owner, 'stale', 'input.touch', {}, {} as never)).toMatchObject({
      code: 'action-failed',
    });

    f.source.endFor(owner, 'The last viewer left.');
    expect(f.requests.at(-1)).toEqual({ method: 'device-host.control.end', params: { session: 'hc1' } });
    expect(f.audit.map((record) => [record.action, record.ok])).toEqual([
      ['control.begin', true],
      ['control.end', true],
    ]);
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
