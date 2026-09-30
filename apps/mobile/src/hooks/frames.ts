import { useEffect, useState } from 'react';

import type { StimConnection } from '@/lib/connection';
import type { DevicePlatform, FrameEvent } from '@/protocol/types';

import { frameTarget } from './frame-target';
import { useMacConnection } from './machines';

const SNAPSHOT_EDGE = 640;

interface FrameState {
  key: string;
  frame: FrameEvent | null;
  error: string | null;
  delayed: boolean;
  delayedReason: string | null;
}

const EMPTY_FRAME_STATE: Omit<FrameState, 'key'> = { frame: null, error: null, delayed: false, delayedReason: null };

/**
 * `hint` asks for up to `fps` frames a second, scaled to fit `maxEdge` pixels; the server defaults to 5 and 1280.
 * `physical` asks for the physical device the workspace leases in `slot`.
 */
export function useFrame(
  workspace: string,
  platform: DevicePlatform,
  slot: string,
  enabled: boolean,
  hint: { fps?: number; maxEdge?: number; physical?: boolean } = {},
): Omit<FrameState, 'key'> {
  const { connection } = useMacConnection();
  const [latest, setLatest] = useState<FrameState | null>(null);
  const { fps, maxEdge, physical } = hint;
  const key = connection && enabled ? frameTarget({ workspace, platform, slot, physical }, { fps, maxEdge }).key : null;
  useEffect(() => {
    if (!connection || key === null) return;
    const params = {
      ...frameTarget({ workspace, platform, slot, physical }).params,
      ...(fps ? { fps } : {}),
      ...(maxEdge ? { maxEdge } : {}),
    };
    return connection.subscribe('frames.subscribe', params, (event) => {
      setLatest((prev) => {
        const base = prev && prev.key === key ? prev : { key, ...EMPTY_FRAME_STATE };
        if (event.event === 'frame') return { key, ...EMPTY_FRAME_STATE, frame: event };
        if (event.event === 'frame-delayed') {
          return { ...base, key, delayed: event.delayed, delayedReason: event.delayed ? (event.reason ?? null) : null };
        }
        if (event.event === 'error') return { key, ...EMPTY_FRAME_STATE, error: event.error.message };
        return base;
      });
    });
  }, [connection, key, workspace, platform, slot, fps, maxEdge, physical]);
  return latest && latest.key === key ? latest : EMPTY_FRAME_STATE;
}

/**
 * A device's latest frame, refreshed `intervalMs` after the previous one arrives: it subscribes until one frame
 * arrives, then unsubscribes, so the server's capture loop runs only briefly for each refresh. After an error
 * the delay doubles, up to a minute, until a frame arrives again.
 */
export function useFrameSnapshot(
  connection: StimConnection | null,
  workspace: string,
  platform: DevicePlatform,
  slot: string,
  enabled: boolean,
  intervalMs: number,
  physical = false,
): { frame: FrameEvent | null; error: string | null } {
  const [latest, setLatest] = useState<{ key: string; frame: FrameEvent | null; error: string | null } | null>(null);
  const key = connection && enabled ? frameTarget({ workspace, platform, slot, physical }).key : null;
  useEffect(() => {
    if (!connection || key === null) return;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let delay = intervalMs;
    const refresh = () => {
      unsubscribe = connection.subscribe(
        'frames.subscribe',
        { ...frameTarget({ workspace, platform, slot, physical }).params, maxEdge: SNAPSHOT_EDGE },
        (event) => {
          if (event.event !== 'frame' && event.event !== 'error') return;
          if (event.event === 'frame') {
            setLatest({ key, frame: event, error: null });
            delay = intervalMs;
          } else {
            setLatest((prev) => ({ key, frame: prev?.key === key ? prev.frame : null, error: event.error.message }));
            delay = Math.min(delay * 2, 60_000);
          }
          unsubscribe?.();
          unsubscribe = null;
          if (!stopped) timer = setTimeout(refresh, delay);
        },
      );
    };
    refresh();
    return () => {
      stopped = true;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
    };
  }, [connection, key, workspace, platform, slot, intervalMs, physical]);
  return latest && latest.key === key ? latest : { frame: null, error: null };
}
