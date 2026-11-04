import type { DataChannel, PeerConnection } from 'node-datachannel';
import { FRAME_RETRY_MS } from './frame-delivery.ts';
import { videoPacket, VideoGate, type AccessUnit } from './video.ts';

/**
 * Prototype: sends a device's H.264 access units to one browser over a WebRTC data channel the browser opened
 * (unordered, no retransmits), so the media goes from the machine that owns the device to the viewer by whichever ICE
 * path works. Signaling is one SDP offer and one answer on the viewer's authenticated share WebSocket.
 */

type NodeDataChannel = typeof import('node-datachannel');

const STUN = (process.env.STIM_WEBRTC_STUN ?? 'stun:stun.l.google.com:19302').split(',').filter(Boolean);
/** Data waiting in the SCTP send queue above which a viewer's video drops until its next keyframe. */
const QUEUE_BYTES = Number(process.env.STIM_WEBRTC_QUEUE_KB ?? 96) * 1024;
/**
 * usrsctp's send buffer. Its 1 MB default holds seconds of video behind a slow link where `bufferedAmount` cannot see
 * it, and delays the control channel, which shares the association.
 */
const SEND_BUFFER_BYTES = 128 * 1024;
const GATHER_MS = 3000;
const CONNECT_MS = 15_000;
const STATS_MS = 1000;
const KEYFRAME_MIN_MS = 250;
const MAX_MESSAGE_BYTES = 256 * 1024;
const PORT_RANGE = process.env.STIM_WEBRTC_PORTS?.split('-').map(Number);
const SUBSCRIPTION = 'share';

export interface RtcFeed {
  /** Starts the device's video when the viewer's channel opens; the returned function stops it. */
  subscribe: (video: (unit: AccessUnit) => void, failed: (message: string) => void) => () => void;
  keyframe: () => void;
  congested: () => void;
}

export interface RtcSession {
  /** The SDP answer for the viewer's offer. */
  answer: string;
  close: () => void;
}

let loading: Promise<NodeDataChannel> | null = null;

function load(): Promise<NodeDataChannel> {
  loading ??= import('node-datachannel').then((module) => {
    const loaded = (module as unknown as { default?: NodeDataChannel }).default ?? module;
    (loaded as NodeDataChannel).setSctpSettings({
      sendBufferSize: SEND_BUFFER_BYTES,
      ...(process.env.STIM_WEBRTC_SCTP ? JSON.parse(process.env.STIM_WEBRTC_SCTP) : {}),
    });
    return loaded as NodeDataChannel;
  });
  return loading;
}

/** Releases the native WebRTC threads so the process can exit; a no-op when no session ever opened. */
export async function cleanupRtc(): Promise<void> {
  if (!loading) return;
  try {
    (await loading).cleanup();
  } catch {
    // the addon was never usable
  }
}

function describe(pair: ReturnType<PeerConnection['getSelectedCandidatePair']>) {
  if (!pair) return null;
  return {
    local: { type: pair.local.type, address: pair.local.address, port: pair.local.port },
    remote: { type: pair.remote.type, address: pair.remote.address, port: pair.remote.port },
  };
}

/**
 * Answers `offer` and returns once the answer carries the peer's candidates. The device's video is sent only after the
 * viewer's `video` channel opens, and everything stops when the connection fails or `close` is called.
 */
export async function openRtc(offer: string, feed: RtcFeed, closed: (reason: string) => void): Promise<RtcSession> {
  const rtc = await load();
  const pc = new rtc.PeerConnection('stim-share', {
    iceServers: STUN,
    maxMessageSize: MAX_MESSAGE_BYTES,
    ...(PORT_RANGE?.length === 2 ? { portRangeBegin: PORT_RANGE[0]!, portRangeEnd: PORT_RANGE[1]! } : {}),
  });
  const gate = new VideoGate(QUEUE_BYTES);
  let video: DataChannel | null = null;
  let control: DataChannel | null = null;
  let stop: (() => void) | null = null;
  let sequence = 0;
  let sent = 0;
  let sentBytes = 0;
  let dropped = 0;
  let oversize = 0;
  let draining: NodeJS.Timeout | null = null;
  let statsTimer: NodeJS.Timeout | null = null;
  let keyframeAt = 0;
  let ended = false;

  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    if (draining) clearTimeout(draining);
    if (statsTimer) clearInterval(statsTimer);
    clearTimeout(connectTimer);
    stop?.();
    stop = null;
    try {
      pc.close();
    } catch {
      // already closed
    }
    closed(reason);
  };

  const drain = () => {
    draining = null;
    if (ended || !video) return;
    if (video.bufferedAmount() <= QUEUE_BYTES) return feed.keyframe();
    feed.congested();
    draining = setTimeout(drain, FRAME_RETRY_MS);
  };

  const deliver = (unit: AccessUnit) => {
    if (ended || !video?.isOpen()) return;
    const verdict = gate.admit(unit, video.bufferedAmount());
    if (verdict === 'send') {
      const packet = videoPacket(SUBSCRIPTION, sequence++, unit);
      try {
        if (!video.sendMessageBinary(packet)) dropped++;
        else {
          sent++;
          sentBytes += packet.length;
        }
      } catch {
        oversize++;
      }
    } else {
      dropped++;
      if (verdict === 'congested' && !draining) drain();
    }
  };

  const reply = (message: Record<string, unknown>) => {
    if (control?.isOpen()) control.sendMessage(JSON.stringify(message));
  };

  const onControl = (raw: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.t === 'keyframe') {
      if (Date.now() - keyframeAt < KEYFRAME_MIN_MS) return;
      keyframeAt = Date.now();
      gate.reset();
      feed.keyframe();
    } else if (message.t === 'ping') {
      reply({ t: 'pong', c: message.c, s: Date.now() });
    }
  };

  pc.onDataChannel((channel) => {
    const label = channel.getLabel();
    if (label === 'ctl') {
      control = channel;
      channel.onMessage((data) => {
        if (typeof data === 'string') onControl(data);
      });
    } else if (label === 'video') {
      video = channel;
      channel.onClosed(() => end('the viewer closed the video channel'));
      channel.onOpen(() => {
        clearTimeout(connectTimer);
        gate.reset();
        stop = feed.subscribe(deliver, (message) => end(message));
        feed.keyframe();
        statsTimer = setInterval(() => {
          reply({
            t: 'stats',
            rtt: pc.rtt(),
            queued: video?.bufferedAmount() ?? 0,
            sent,
            sentBytes,
            dropped,
            oversize,
            pair: describe(pc.getSelectedCandidatePair()),
          });
        }, STATS_MS);
        statsTimer.unref();
      });
    }
  });
  pc.onStateChange((state) => {
    if (state === 'failed' || state === 'closed' || state === 'disconnected') end(`WebRTC ${state}`);
  });

  const connectTimer = setTimeout(() => end('WebRTC did not connect'), CONNECT_MS);
  connectTimer.unref();

  const gathered = new Promise<void>((resolve) => {
    pc.onGatheringStateChange((state) => {
      if (state === 'complete') resolve();
    });
    setTimeout(resolve, GATHER_MS).unref();
  });
  pc.setRemoteDescription(offer, 'offer');
  await gathered;
  const description = pc.localDescription();
  if (!description) {
    end('WebRTC produced no answer');
    throw new Error('WebRTC produced no answer.');
  }
  return { answer: description.sdp, close: () => end('closed') };
}
