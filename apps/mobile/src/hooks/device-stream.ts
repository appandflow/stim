import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useMacConnection } from '@/hooks/mac-connection';
import { VideoMeter } from '@/lib/video';
import type { FrameEvent, Platform } from '@/protocol/types';
import { pushAccessUnit } from '../../modules/stim-video/src';

export interface DeviceStream {
  /** The id the `StimVideoView` showing this stream must carry. */
  streamId: string;
  /** The latest JPEG frame, while the server sends images instead of video. */
  frame: FrameEvent | null;
  /** The size of the latest video frame, once H.264 arrives. */
  video: { width: number; height: number } | null;
  error: string | null;
  delayed: boolean;
  meter: VideoMeter;
  /** Asks the server for a keyframe, after the decoder lost its state. */
  requestKeyframe: () => void;
}

interface StreamState {
  key: string;
  frame: FrameEvent | null;
  video: { width: number; height: number } | null;
  error: string | null;
  delayed: boolean;
}

const EMPTY: Omit<StreamState, 'key'> = { frame: null, video: null, error: null, delayed: false };

/**
 * Subscribes to a device's frames, asking for the given codecs. Video goes straight to the `StimVideoView` with
 * the returned `streamId`, which must be mounted before the first keyframe arrives; JPEG frames (when `video` is
 * empty, or the server has no H.264 to offer) come back as `frame`.
 */
export function useDeviceStream(
  target: { workspace: string; platform: Platform; slot: string },
  options: { enabled: boolean; fps: number; maxEdge: number; video: 'h264'[] },
): DeviceStream {
  const { connection } = useMacConnection();
  const streamId = useId();
  const { workspace, platform, slot } = target;
  const { fps, maxEdge, video } = options;
  const [latest, setLatest] = useState<StreamState | null>(null);
  const subscription = useRef<string | null>(null);
  const key =
    connection && options.enabled ? `${workspace}\n${platform}\n${slot}\n${fps}\n${maxEdge}\n${video.join(',')}` : null;
  const [meter] = useState(() => new VideoMeter());
  useEffect(() => {
    if (!connection || key === null) return;
    let size = '';
    subscription.current = null;
    const update = (patch: Partial<StreamState>) =>
      setLatest((prev) => ({ ...(prev && prev.key === key ? prev : { key, ...EMPTY }), ...patch, key }));
    const unsubscribe = connection.subscribe(
      'frames.subscribe',
      { workspace, platform, slot, fps, maxEdge, video },
      (event) => {
        if (event.event === 'frame') {
          size = '';
          update({ frame: event, video: null, error: null, delayed: false });
        } else if (event.event === 'frame-delayed') update({ delayed: event.delayed });
        else if (event.event === 'error') {
          size = '';
          update({ frame: null, video: null, error: event.error.message, delayed: false });
        }
      },
      (result) => {
        subscription.current = result.subscription;
        size = '';
      },
      (packet) => {
        pushAccessUnit(streamId, packet.accessUnit, packet.width, packet.height);
        meter.add(packet, Date.now());
        const next = `${packet.width}x${packet.height}`;
        if (next === size) return;
        size = next;
        update({ frame: null, video: { width: packet.width, height: packet.height }, error: null });
      },
    );
    return () => {
      subscription.current = null;
      unsubscribe();
    };
  }, [connection, key, streamId, workspace, platform, slot, fps, maxEdge, video, meter]);
  const requestKeyframe = useCallback(() => {
    const current = subscription.current;
    if (connection && current) connection.request('frames.keyframe', { subscription: current }).catch(() => {});
  }, [connection]);
  const state = latest && latest.key === key ? latest : EMPTY;
  return { ...state, streamId, meter, requestKeyframe };
}
