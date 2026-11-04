import { PeerConnection, cleanup } from 'node-datachannel';
import { afterAll, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.STIM_WEBRTC_STUN = '';
});
import { accessUnitOf, type AccessUnit } from '../src/video.ts';
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
