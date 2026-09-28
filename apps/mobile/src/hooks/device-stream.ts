import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useMacConnection } from '@/hooks/mac-connection';
import { VideoMeter } from '@/lib/video';
import type { DevicePlatform, FrameEvent, ReplayRate } from '@/protocol/types';
import { pushAccessUnit } from '../../modules/stim-video/src';

export interface DeviceStream {
  /** The id the `StimVideoView` showing this stream must carry. */
  streamId: string;
  /** The latest JPEG frame, while the server sends images instead of video. */
  frame: FrameEvent | null;
  /** The size of the latest video frame, and an iPhone Duo's posture, once the first H.264 keyframe arrives. */
  video: { width: number; height: number; posture?: 'folded' | 'unfolded' } | null;
  error: string | null;
  delayed: boolean;
  /** Why frames stopped, such as a locked iPhone, when the server says. */
  delayedReason: string | null;
  meter: VideoMeter;
  /** Asks the server for a keyframe, after the decoder lost its state. */
  requestKeyframe: () => void;
  /** Null while the stream shows the live screen; otherwise the recorded frame shown and how it plays. */
  replay: Replay | null;
  /** Shows the recorded frame at `at` and plays on at `rate`; 0 pauses. */
  seek: (at: number, rate: ReplayRate) => void;
  /** Returns to the live screen. */
  live: () => void;
  /** Whether the server sends this subscription H.264 and so can `seek`; null until it answers. */
  replayable: boolean | null;
}

export interface Replay {
  /** The capture time of the frame shown, epoch ms on the Mac's clock; null until the first one arrives. */
  at: number | null;
  rate: ReplayRate;
  /** Playback reached the newest recorded frame and paused there. */
  ended: boolean;
}

interface StreamState {
  key: string;
  frame: FrameEvent | null;
  video: { width: number; height: number; posture?: 'folded' | 'unfolded' } | null;
  error: string | null;
  delayed: boolean;
  replay: Replay | null;
  replayable: boolean | null;
  delayedReason: string | null;
}

const EMPTY: Omit<StreamState, 'key'> = {
  frame: null,
  video: null,
  error: null,
  delayed: false,
  replay: null,
  replayable: null,
  delayedReason: null,
};
const POSITION_MS = 200;

/**
 * Subscribes to a device's frames, asking for the given codecs. Video goes straight to the `StimVideoView` with
 * the returned `streamId`, which must be mounted before the first keyframe arrives; JPEG frames (when `video` is
 * empty, or the server has no H.264 to offer) come back as `frame`. A video stream can `seek` into the device's
 * recording and go back `live`. `startAt` opens the stream on the recording instead, for a device that is not
 * running.
 */
export function useDeviceStream(
  target: { workspace: string; platform: DevicePlatform; slot: string; physical?: boolean },
  options: { enabled: boolean; fps: number; maxEdge: number; video: 'h264'[]; startAt?: number | null },
): DeviceStream {
  const { connection } = useMacConnection();
  const streamId = useId();
  const { workspace, platform, slot, physical } = target;
  const { fps, maxEdge, video } = options;
  const startAt = options.startAt ?? null;
  const [latest, setLatest] = useState<StreamState | null>(null);
  const subscription = useRef<string | null>(null);
  const replaying = useRef<(Replay & { timer: ReturnType<typeof setTimeout> | null }) | null>(null);
  const updateRef = useRef<((patch: Partial<StreamState>) => void) | null>(null);
  const pendingSeek = useRef<{ at: number; rate: ReplayRate } | null>(null);
  const key =
    connection && options.enabled
      ? `${workspace}\n${platform}\n${slot}\n${physical ? 'physical' : ''}\n${fps}\n${maxEdge}\n${video.join(',')}\n${startAt ?? ''}`
      : null;
  const [meter] = useState(() => new VideoMeter());
  /**
   * Shows the frame at `at` and plays on at `rate`. A seek made before the subscription opens waits for it. A seek
   * the server refuses leaves the stream as it was, and an answer for a subscription that has since been replaced
   * is dropped.
   */
  const sendSeek = (on: NonNullable<typeof connection>, current: string, at: number, rate: ReplayRate) => {
    const previous = replaying.current;
    const before = previous ? { at: previous.at, rate: previous.rate, ended: previous.ended } : null;
    if (!replaying.current) replaying.current = { at: null, rate, ended: false, timer: null };
    updateRef.current?.({ replay: { at: replaying.current.at, rate, ended: false } });
    on.request('frames.seek', { subscription: current, at, rate }).then(
      (result) => {
        if (subscription.current !== current) return;
        if (replaying.current) Object.assign(replaying.current, { at: result.at, rate, ended: false });
        updateRef.current?.({ replay: { at: result.at, rate, ended: false } });
      },
      () => {
        if (subscription.current !== current) return;
        if (!before) replaying.current = null;
        updateRef.current?.({ replay: before });
      },
    );
  };
  useEffect(() => {
    if (!connection || key === null) return;
    let size = '';
    subscription.current = null;
    const update = (patch: Partial<StreamState>) =>
      setLatest((prev) => ({ ...(prev && prev.key === key ? prev : { key, ...EMPTY }), ...patch, key }));
    updateRef.current = update;
    const unsubscribe = connection.subscribe(
      'frames.subscribe',
      {
        workspace,
        platform,
        slot,
        ...(physical ? { physical } : {}),
        fps,
        maxEdge,
        video,
        ...(startAt !== null ? { at: startAt, rate: 0 as const } : {}),
      },
      (event) => {
        if (event.event === 'frame') {
          size = '';
          update({ frame: event, video: null, error: null, delayed: false, delayedReason: null });
        } else if (event.event === 'frame-delayed') {
          update({ delayed: event.delayed, delayedReason: event.delayed ? (event.reason ?? null) : null });
        } else if (event.event === 'replay-ended') {
          if (replaying.current) Object.assign(replaying.current, { at: event.at, rate: 0, ended: true });
          update({ replay: { at: event.at, rate: 0, ended: true } });
        } else if (event.event === 'error') {
          size = '';
          update({ frame: null, video: null, error: event.error.message, delayed: false, delayedReason: null });
        }
      },
      (result) => {
        subscription.current = result.subscription;
        size = '';
        replaying.current = startAt !== null ? { at: null, rate: 0, ended: false, timer: null } : null;
        update({
          replay: startAt !== null ? { at: null, rate: 0, ended: false } : null,
          replayable: result.video === 'h264',
        });
        const pending = pendingSeek.current;
        pendingSeek.current = null;
        if (pending) sendSeek(connection, result.subscription, pending.at, pending.rate);
      },
      (packet) => {
        pushAccessUnit(streamId, packet.accessUnit, packet.width, packet.height);
        meter.add(packet, Date.now());
        const position = replaying.current;
        if (position) {
          position.at = packet.capturedAt;
          if (!position.timer) {
            position.timer = setTimeout(() => {
              position.timer = null;
              if (replaying.current === position) {
                setLatest((prev) =>
                  prev && prev.key === key && prev.replay
                    ? { ...prev, replay: { ...prev.replay, at: position.at } }
                    : prev,
                );
              }
            }, POSITION_MS);
          }
        }
        if (!size && !packet.keyframe) return;
        const next = `${packet.width}x${packet.height} ${packet.posture ?? ''}`;
        if (next === size) return;
        size = next;
        const { width, height, posture } = packet;
        update({ frame: null, video: { width, height, ...(posture ? { posture } : {}) }, error: null });
      },
    );
    return () => {
      subscription.current = null;
      if (replaying.current?.timer) clearTimeout(replaying.current.timer);
      replaying.current = null;
      updateRef.current = null;
      pendingSeek.current = null;
      unsubscribe();
    };
  }, [connection, key, streamId, workspace, platform, slot, physical, fps, maxEdge, video, meter, startAt]);
  const requestKeyframe = useCallback(() => {
    const current = subscription.current;
    if (connection && current) connection.request('frames.keyframe', { subscription: current }).catch(() => {});
  }, [connection]);
  const seek = (at: number, rate: ReplayRate) => {
    const current = subscription.current;
    if (!connection) return;
    if (!current) {
      pendingSeek.current = { at, rate };
      return;
    }
    sendSeek(connection, current, at, rate);
  };
  const live = useCallback(() => {
    const current = subscription.current;
    if (!connection || !current) return;
    connection.request('frames.live', { subscription: current }).then(
      () => {
        if (replaying.current?.timer) clearTimeout(replaying.current.timer);
        replaying.current = null;
        updateRef.current?.({ replay: null });
      },
      (cause: Error) => updateRef.current?.({ error: cause.message }),
    );
  }, [connection]);
  const state = latest && latest.key === key ? latest : EMPTY;
  return { ...state, streamId, meter, requestKeyframe, seek, live };
}
