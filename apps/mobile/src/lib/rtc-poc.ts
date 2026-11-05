import { RTCPeerConnection } from 'react-native-webrtc';

import type { StimConnection } from '@/lib/connection';
import type { VideoStream } from '@/lib/socket';
import type { VideoProgress } from 'react-native-stim-session';

const HARNESS = 'http://127.0.0.1:7790';
const TTL_MS = 100;
const KEYFRAME_MIN_MS = 250;

export const poc: { transport: 'ws' | 'rtc'; run: string } = { transport: 'ws', run: 'none' };

if (__DEV__) {
  const poll = () =>
    fetch(`${HARNESS}/mode`)
      .then((r) => r.json())
      .then((mode) => Object.assign(poc, mode))
      .catch(() => {})
      .finally(() => setTimeout(poll, 1000));
  poll();
}

let pending: unknown[] = [];
let flushedAt = 0;

export function record(progress: VideoProgress, stream: VideoStream): void {
  if (!__DEV__ || poc.run === 'none') return;
  pending.push({ t: Date.now(), f: progress.frames, b: progress.bytes, l: progress.latencyMs, c: progress.capturedAt });
  const now = Date.now();
  if (now - flushedAt < 1000) return;
  flushedAt = now;
  const batch = pending;
  pending = [];
  const timing = stream.timing();
  fetch(`${HARNESS}/stat`, {
    // oxlint-disable-next-line lingui/no-unlocalized-strings -- proof of concept, development builds only
    method: 'POST',
    body: JSON.stringify({ transport: poc.transport, run: poc.run, timing, progress: batch, rtc }),
  }).catch(() => {});
}

export const rtc: Record<string, unknown> = {
  server: null,
  messages: 0,
  bytes: 0,
  gaps: 0,
  dropped: 0,
  keyframeRequests: 0,
  jsDecodeMs: 0,
  pushMs: 0,
};

/** Opens the data channel for a subscription and pushes what it receives into the native stream. */
export async function startRtc(connection: StimConnection, subscription: string, stream: VideoStream) {
  Object.assign(rtc, {
    server: null,
    messages: 0,
    bytes: 0,
    gaps: 0,
    dropped: 0,
    keyframeRequests: 0,
    jsDecodeMs: 0,
    pushMs: 0,
  });
  const pc = new RTCPeerConnection({ iceServers: [] });
  const video = pc.createDataChannel('video', { ordered: false, maxPacketLifeTime: TTL_MS });
  const ctl = pc.createDataChannel('ctl');
  (video as unknown as { binaryType: string }).binaryType = 'arraybuffer';
  (ctl as any).addEventListener('message', (event: { data: string }) => {
    try {
      const message = JSON.parse(event.data);
      if (message.t === 'stats') rtc.server = message;
    } catch {}
  });
  let expected: number | null = null;
  let waiting = true;
  let keyframeAt = 0;
  const askKeyframe = () => {
    if (Date.now() - keyframeAt < KEYFRAME_MIN_MS) return;
    keyframeAt = Date.now();
    (rtc.keyframeRequests as number)++;
    try {
      ctl.send(JSON.stringify({ t: 'keyframe' }));
    } catch {}
  };
  (video as any).addEventListener('message', (event: { data: ArrayBuffer }) => {
    const started = performance.now();
    const buffer = event.data;
    (rtc.messages as number)++;
    (rtc.bytes as number) += buffer.byteLength;
    const view = new DataView(buffer);
    const keyframe = (view.getUint8(1) & 1) !== 0;
    const sequence = view.getUint32(4);
    if (expected !== null && sequence !== expected) {
      (rtc.gaps as number)++;
      waiting = true;
    }
    expected = (sequence + 1) >>> 0;
    if (keyframe) waiting = false;
    if (waiting) {
      (rtc.dropped as number)++;
      askKeyframe();
      return;
    }
    try {
      stream.push(buffer);
    } catch {
      pc.close();
    }
    (rtc.pushMs as number) += performance.now() - started;
  });
  const gathered = new Promise<void>((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
    setTimeout(resolve, 2500);
  });
  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);
  await gathered;
  const answer = await connection.rtcOffer(subscription, pc.localDescription!.sdp);
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp } as never);
  return () => pc.close();
}
