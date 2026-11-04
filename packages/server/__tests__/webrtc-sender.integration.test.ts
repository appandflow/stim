import { PeerConnection, cleanup } from 'node-datachannel';
import { afterAll, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.STIM_WEBRTC_STUN = '';
});
import { accessUnitOf, type AccessUnit } from '../src/video.ts';
import { privateAddress } from '../src/webrtc-candidates.ts';
import { cleanupRtc, openRtc } from '../src/webrtc-sender.ts';

afterAll(async () => {
  await cleanupRtc();
  cleanup();
});

function unit(keyframe: boolean, capturedAt: number): AccessUnit {
  return { keyframe, capturedAt, width: 590, height: 1280, data: Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41]) };
}

/** A browser stand-in: offers the `video` and `ctl` channels the share viewer opens, with its candidates in the SDP. */
async function viewer() {
  const pc = new PeerConnection('viewer', { iceServers: [] });
  const gathered = new Promise<string>((resolve) => {
    pc.onGatheringStateChange((state) => {
      if (state === 'complete') resolve(pc.localDescription()!.sdp);
    });
  });
  pc.onLocalDescription(() => {});
  const video = pc.createDataChannel('video', { unordered: true, maxRetransmits: 0 });
  const control = pc.createDataChannel('ctl');
  const packets: Buffer[] = [];
  const replies: Record<string, unknown>[] = [];
  video.onMessage((data) => packets.push(Buffer.from(data as Buffer)));
  control.onMessage((data) => replies.push(JSON.parse(String(data)) as Record<string, unknown>));
  const opened = new Promise<void>((resolve) => video.onOpen(resolve));
  return { pc, control, packets, replies, offer: await gathered, opened };
}

it('sends access units over the viewer data channel and takes keyframe requests and clock pings on its control channel', async () => {
  const keyframes = vi.fn<() => void>();
  let video: (unit: AccessUnit) => void = () => {};
  const stopped = vi.fn<() => void>();
  const browser = await viewer();
  const session = await openRtc(
    browser.offer,
    {
      subscribe: (listener) => {
        video = listener;
        return stopped;
      },
      keyframe: keyframes,
      congested: () => {},
    },
    () => {},
  );
  browser.pc.setRemoteDescription(session.answer, 'answer');
  await browser.opened;
  await vi.waitFor(() => expect(keyframes).toHaveBeenCalledTimes(1));

  video(unit(true, 1));
  video(unit(false, 2));
  await vi.waitFor(() => expect(browser.packets).toHaveLength(2));
  expect(browser.packets.map((packet) => accessUnitOf(packet))).toEqual([unit(true, 1), unit(false, 2)]);
  expect(browser.packets.map((packet) => packet.readUInt32BE(4))).toEqual([0, 1]);

  await vi.waitFor(() => expect(browser.control.isOpen()).toBe(true));
  browser.control.sendMessage(JSON.stringify({ t: 'keyframe' }));
  await vi.waitFor(() => expect(keyframes).toHaveBeenCalledTimes(2));
  browser.control.sendMessage(JSON.stringify({ t: 'ping', c: 7 }));
  await vi.waitFor(() => expect(browser.replies).toContainEqual(expect.objectContaining({ t: 'pong', c: 7 })));

  session.close();
  expect(stopped).toHaveBeenCalledTimes(1);
  browser.pc.close();
}, 20_000);

it('reports the peer closed once when the viewer goes away', async () => {
  const closed = vi.fn<(reason: string) => void>();
  const browser = await viewer();
  const session = await openRtc(
    browser.offer,
    { subscribe: () => () => {}, keyframe: () => {}, congested: () => {} },
    closed,
  );
  browser.pc.setRemoteDescription(session.answer, 'answer');
  await browser.opened;
  browser.pc.close();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1), { timeout: 15_000 });
  session.close();
  expect(closed).toHaveBeenCalledTimes(1);
}, 30_000);

it('answers with local addresses only, and refuses a viewer that offers none', async () => {
  const feed = { subscribe: () => () => {}, keyframe: () => {}, congested: () => {} };
  const browser = await viewer();
  const session = await openRtc(browser.offer, feed, () => {});
  const candidates = session.answer.split('\r\n').filter((line) => line.startsWith('a=candidate:'));
  expect(candidates.length).toBeGreaterThan(0);
  for (const line of candidates) expect(privateAddress(line.split(' ')[4] ?? '')).toBe(true);
  session.close();
  browser.pc.close();

  const publicOnly = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 1677729535 198.51.100.7 5000 typ srflx raddr 0.0.0.0 rport 0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:0123456789abcdefghijklmn',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    '',
  ].join('\r\n');
  await expect(openRtc(publicOnly, feed, () => {})).rejects.toThrow(/no address on a local network or tailnet/);
});
