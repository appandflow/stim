import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { frameTarget } from '@/hooks/frame-target';
import { useMacConnection } from '@/hooks/machines';
import { SeekQueue, type Seek } from '@/lib/replay-seek';
import { VideoMeter } from '@/lib/video';
import { supportsFrame } from '@/lib/device-frame';

import type { DeviceFrameArtwork, DevicePlatform, FrameEvent, MacosWindowsEvent, ReplayRate } from '@/protocol/types';
import { pushAccessUnit, supportsFrameOrientation } from '../../modules/stim-video/src';

export interface DeviceStream {
  /** The id the `StimVideoView` showing this stream must carry. */
  streamId: string;
  /** The latest JPEG frame, while the server sends images instead of video. */
  frame: FrameEvent | null;
  /** The size of the latest video frame, and an iPhone Duo's posture, once the first H.264 keyframe arrives. */
  video: { width: number; height: number; posture?: 'folded' | 'unfolded'; artworkTurns?: number } | null;
  artwork: DeviceFrameArtwork | null;
  windows: Omit<MacosWindowsEvent, 'event' | 'subscription'> | null;
  displayedDuoRevision: string | null;
  frameDisplayed: (revision: string) => void;
  error: string | null;
  delayed: boolean;
  /** Why frames stopped, such as a locked iPhone, when the server says. */
  delayedReason: string | null;
  meter: VideoMeter;
  /** Asks the server for a keyframe, after the decoder lost its state. */
  requestKeyframe: () => void;
  orientationCleared: (event: { nativeEvent: { generation: number } }) => void;
  /** Null while the stream shows the live screen; otherwise how the recording plays. */
  replay: Replay | null;
  /** The recorded frame shown, which moves several times a second during playback; read it with `useReplayAt`. */
  playhead: ReplayPlayhead;
  /** Shows the recorded frame at `at` and plays on at `rate`; 0 pauses. */
  seek: (at: number, rate: ReplayRate) => void;
  /** Returns to the live screen. */
  live: () => void;
  /** Whether the server sends this subscription H.264 and so can `seek`; null until it answers. */
  replayable: boolean | null;
  /** A seek is out or waiting, so `playhead` is not yet the frame last asked for. */
  seeking: boolean;
}

export interface Replay {
  rate: ReplayRate;
  /** Playback reached the newest recorded frame and paused there. */
  ended: boolean;
}

interface StreamState {
  key: string;
  frame: FrameEvent | null;
  video: { width: number; height: number; posture?: 'folded' | 'unfolded'; artworkTurns?: number } | null;
  artwork: DeviceFrameArtwork | null;
  windows: Omit<MacosWindowsEvent, 'event' | 'subscription'> | null;
  displayedDuoRevision: string | null;
  error: string | null;
  delayed: boolean;
  replay: Replay | null;
  replayable: boolean | null;
  delayedReason: string | null;
  seeking: boolean;
}

const EMPTY: Omit<StreamState, 'key'> = {
  frame: null,
  video: null,
  artwork: null,
  windows: null,
  displayedDuoRevision: null,
  error: null,
  delayed: false,
  replay: null,
  replayable: null,
  delayedReason: null,
  seeking: false,
};
const POSITION_MS = 200;
let nextOrientationGeneration = 0;
function orientationGeneration(): number {
  nextOrientationGeneration += 1;
  return nextOrientationGeneration;
}

type Shown = Replay & { at: number | null };
type Update = Partial<Omit<StreamState, 'key' | 'replay'>> & { replay?: Shown | null };

/** The capture time of the replay frame shown, epoch ms on the Mac's clock; null until the first one arrives. */
export type ReplayPlayhead = StoreApi<{ at: number | null }>;

const unsubscribed = () => () => {};

/** The replay frame `playhead` shows, re-rendering on each move; null for a null `playhead`. */
export function useReplayAt(playhead: ReplayPlayhead | null): number | null {
  return useSyncExternalStore(playhead?.subscribe ?? unsubscribed, () => playhead?.getState().at ?? null);
}

/**
 * Subscribes to a device's frames, asking for the given codecs. Video goes straight to the `StimVideoView` with
 * the returned `streamId`, which must be mounted before the first keyframe arrives; JPEG frames (when `video` is
 * empty, or the server has no H.264 to offer) come back as `frame`. A video stream can `seek` into the device's
 * recording and go back `live`. `startAt` opens the stream on the recording instead, for a device that is not
 * running.
 */
export function useDeviceStream(
  target: { workspace: string; platform: DevicePlatform; slot: string; physical?: boolean },
  options: {
    enabled: boolean;
    fps: number;
    maxEdge: number;
    video: 'h264'[];
    startAt?: number | null;
    deviceFrame?: boolean;
    duoFrame?: boolean;
  },
): DeviceStream {
  const { connection } = useMacConnection();
  const streamId = useId();
  const { workspace, platform, slot, physical } = target;
  const { fps, maxEdge, video } = options;
  const deviceFrame = options.deviceFrame === true;
  const duoFrame = options.duoFrame === true;
  const startAt = options.startAt ?? null;
  const [latest, setLatest] = useState<StreamState | null>(null);
  const subscription = useRef<string | null>(null);
  const replaying = useRef<(Shown & { timer: ReturnType<typeof setTimeout> | null }) | null>(null);
  const updateRef = useRef<((patch: Update) => void) | null>(null);
  const requestedDuo = useRef<string | null>(null);
  const frameDisplayed = useCallback((revision: string) => {
    if (requestedDuo.current === revision) updateRef.current?.({ displayedDuoRevision: revision });
  }, []);
  const seeks = useRef(new SeekQueue());
  const orientation = useRef<{ generation: number; video: NonNullable<DeviceStream['video']> } | null>(null);
  const orientationCleared = useCallback(({ nativeEvent }: { nativeEvent: { generation: number } }) => {
    const current = orientation.current;
    if (current?.generation === nativeEvent.generation) updateRef.current?.({ video: current.video });
  }, []);
  const key =
    connection && options.enabled
      ? frameTarget({ workspace, platform, slot, physical }, { fps, maxEdge, video, startAt, deviceFrame, duoFrame })
          .key
      : null;
  const [meter] = useState(() => new VideoMeter());
  const [playhead] = useState<ReplayPlayhead>(() => createStore(() => ({ at: null })));
  /**
   * Sends the waiting seek when `seeks` lets it go out, or schedules it. Only the answer to the latest seek moves
   * `playhead`; a refused latest seek leaves the stream as it was before it, and an answer for a subscription that
   * has since been replaced is dropped.
   */
  const pumpSeeks = (on: NonNullable<typeof connection>) =>
    seeks.current.pump(
      () => subscription.current,
      (current, seek) => sendSeek(on, current, seek),
    );
  const sendSeek = (on: NonNullable<typeof connection>, current: string, seek: Seek) => {
    const { at, rate } = seek;
    const previous = replaying.current;
    const before = previous ? { at: previous.at, rate: previous.rate, ended: previous.ended } : null;
    if (!replaying.current) replaying.current = { at: null, rate, ended: false, timer: null };
    updateRef.current?.({ replay: { at: replaying.current.at, rate, ended: false } });
    const answered = (replay: Shown | null) => {
      if (subscription.current !== current) return;
      if (seeks.current.finish(seek)) {
        if (replay) {
          if (replaying.current) Object.assign(replaying.current, replay);
        } else {
          replaying.current = null;
        }
        updateRef.current?.({ replay, seeking: false });
      }
      pumpSeeks(on);
    };
    on.request('frames.seek', { subscription: current, at, rate }).then(
      (result) => answered({ at: result.at, rate, ended: false }),
      () => answered(before),
    );
  };
  useEffect(() => {
    if (!connection || key === null) return;
    let size = '';
    orientation.current = null;
    requestedDuo.current = null;
    const queue = seeks.current;
    subscription.current = null;
    const update = ({ replay, ...patch }: Update) => {
      if (replay !== undefined) playhead.setState({ at: replay?.at ?? null });
      const next =
        replay === undefined ? patch : { ...patch, replay: replay && { rate: replay.rate, ended: replay.ended } };
      setLatest((prev) => ({ ...(prev && prev.key === key ? prev : { key, ...EMPTY }), ...next, key }));
    };
    updateRef.current = update;
    const unsubscribe = connection.subscribe(
      'frames.subscribe',
      {
        ...frameTarget({ workspace, platform, slot, physical }).params,
        fps,
        maxEdge,
        video,
        ...(deviceFrame ? { deviceFrame: true } : {}),
        ...(duoFrame ? { duoFrame: true } : {}),
        ...(startAt !== null ? { at: startAt, rate: 0 as const } : {}),
      },
      (event) => {
        if (event.event === 'frame') {
          if (!supportsFrame(event, platform)) return;
          size = '';
          orientation.current = null;
          const revision = event.duo?.revision ?? null;
          const changed = requestedDuo.current !== revision;
          requestedDuo.current = revision;
          update({
            frame: event,
            video: null,
            error: null,
            delayed: false,
            delayedReason: null,
            ...(changed ? { displayedDuoRevision: null } : {}),
          });
        } else if (event.event === 'macos-windows') {
          update({ windows: { current: event.current, windows: event.windows, pinned: event.pinned ?? false } });
        } else if (event.event === 'device-frame') {
          update({ artwork: event.artwork });
        } else if (event.event === 'frame-delayed') {
          update({ delayed: event.delayed, delayedReason: event.delayed ? (event.reason ?? null) : null });
        } else if (event.event === 'replay-ended') {
          if (replaying.current) Object.assign(replaying.current, { at: event.at, rate: 0, ended: true });
          update({ replay: { at: event.at, rate: 0, ended: true } });
        } else if (event.event === 'error') {
          size = '';
          orientation.current = null;
          requestedDuo.current = null;
          update({
            frame: null,
            video: null,
            displayedDuoRevision: null,
            error: event.error.message,
            delayed: false,
            delayedReason: null,
          });
        }
      },
      (result) => {
        subscription.current = result.video && result.video !== 'h264' ? null : result.subscription;
        queue.interrupt();
        size = '';
        orientation.current = null;
        requestedDuo.current = null;
        replaying.current = startAt !== null ? { at: null, rate: 0, ended: false, timer: null } : null;
        update({
          frame: null,
          video: null,
          displayedDuoRevision: null,
          replay: startAt !== null ? { at: null, rate: 0, ended: false } : null,
          windows: null,
          replayable: result.video === 'h264',
          seeking: !queue.settled,
        });
        pumpSeeks(connection);
      },
      (packet) => {
        if (subscription.current === null) return;
        meter.add(packet, Date.now());
        const shown = replaying.current;
        if (shown && queue.settled) {
          shown.at = packet.capturedAt;
          if (!shown.timer) {
            shown.timer = setTimeout(() => {
              shown.timer = null;
              if (replaying.current === shown) playhead.setState({ at: shown.at });
            }, POSITION_MS);
          }
        }
        const push = () =>
          pushAccessUnit(streamId, packet.accessUnit, packet.width, packet.height, orientation.current?.generation);
        if (!size && !packet.keyframe) return push();
        const next = `${packet.width}x${packet.height} ${packet.posture ?? ''} ${packet.artworkTurns ?? ''}`;
        if (next === size) return push();
        size = next;
        const { width, height, posture, artworkTurns } = packet;
        const video = { width, height, ...(posture ? { posture } : {}) };
        orientation.current =
          deviceFrame && supportsFrameOrientation && artworkTurns !== undefined
            ? { generation: orientationGeneration(), video: { ...video, artworkTurns } }
            : null;
        update({ frame: null, video, error: null });
        push();
      },
    );
    return () => {
      subscription.current = null;
      if (replaying.current?.timer) clearTimeout(replaying.current.timer);
      replaying.current = null;
      updateRef.current = null;
      orientation.current = null;
      requestedDuo.current = null;
      queue.clear();
      unsubscribe();
    };
  }, [
    connection,
    key,
    streamId,
    workspace,
    platform,
    slot,
    physical,
    fps,
    maxEdge,
    video,
    meter,
    playhead,
    startAt,
    deviceFrame,
    duoFrame,
  ]);
  const requestKeyframe = useCallback(() => {
    const current = subscription.current;
    if (connection && current) connection.request('frames.keyframe', { subscription: current }).catch(() => {});
  }, [connection]);
  const seek = (at: number, rate: ReplayRate) => {
    if (!connection) return;
    seeks.current.ask({ at, rate });
    updateRef.current?.({ seeking: true });
    pumpSeeks(connection);
  };
  const live = useCallback(() => {
    const current = subscription.current;
    if (!connection || !current) return;
    seeks.current.clear();
    updateRef.current?.({ seeking: false });
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
  return { ...state, streamId, meter, playhead, requestKeyframe, orientationCleared, frameDisplayed, seek, live };
}
