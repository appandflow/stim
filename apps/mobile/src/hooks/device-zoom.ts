import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { BackHandler, useWindowDimensions, type ViewInstance } from 'react-native';
import { usePanGesture } from 'react-native-gesture-handler';
import {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { aspectOf, fitRect, zoomRect, type Rect } from '@/lib/zoom';
import type { FrameEvent, Platform } from '@/protocol/types';

export interface DeviceTarget {
  macId: string;
  workspace: string;
  platform: Platform;
  slot: string;
}

/** Where the viewer grows from: the thumbnail's rect in window coordinates and the frame it showed. */
export interface ZoomOrigin {
  key: string;
  rect: Rect;
  frame: FrameEvent | null;
  thumbnail: ViewInstance;
}

const OPEN_MS = 420;
const CLOSE_MS = 340;
const RETARGET_MS = 250;
const DISMISS_DRAG = 120;
const DISMISS_VELOCITY = 900;
const STAGE_MARGIN = 8;
const REMEASURE_MS = 150;
const EASING = Easing.bezier(0.2, 0.9, 0.1, 1);

let current: ZoomOrigin | null = null;
let opening = false;
const listeners = new Set<() => void>();

function set(next: ZoomOrigin | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function zoomKey({ macId, workspace, platform, slot }: DeviceTarget): string {
  return `${macId}\n${workspace}\n${platform}\n${slot}`;
}

/** Opens the device viewer, growing it out of `thumbnail`, which hides until the viewer closes. */
export function openDeviceViewer(thumbnail: ViewInstance | null, target: DeviceTarget, frame: FrameEvent | null) {
  const push = () =>
    router.push({
      pathname: '/mac/[id]/device',
      params: { id: target.macId, path: target.workspace, platform: target.platform, slot: target.slot },
    });
  if (!thumbnail) return push();
  if (opening) return;
  opening = true;
  thumbnail.measureInWindow((x, y, width, height) => {
    opening = false;
    set(width > 0 && height > 0 ? { key: zoomKey(target), rect: [x, y, width, height], frame, thumbnail } : null);
    push();
  });
}

/** Whether the viewer currently covers the thumbnail for `key`. */
export function useZoomedAway(key: string): boolean {
  return useSyncExternalStore(subscribe, () => current?.key === key);
}

/**
 * The viewer's side of the zoom: the screen grows from the thumbnail it opened from (or from slightly smaller
 * than its place when there is none) into the fitted stage, the rest fades in, and closing, the back button or
 * a swipe down while not controlling shrinks it back before the route pops.
 */
export function useDeviceZoom(
  key: string,
  liveAspect: number | null,
  fallbackAspect: number,
  dragEnabled: boolean,
  root: RefObject<ViewInstance | null>,
  stageRef: RefObject<ViewInstance | null>,
) {
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const [origin] = useState(() => (current?.key === key ? current : null));
  const aspect = liveAspect ?? aspectOf(origin?.frame) ?? fallbackAspect;
  const [landed, setLanded] = useState(false);
  const [stage, setStage] = useState<Rect | null>(null);
  const [offset, setOffset] = useState<[number, number] | null>(null);
  const from = useSharedValue<Rect | null>(null);
  const to = useSharedValue<Rect | null>(null);
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const closing = useRef(false);
  const closingOnUI = useSharedValue(false);

  useEffect(
    () => () => {
      if (current?.key === key) set(null);
    },
    [key],
  );

  const measure = useCallback(() => {
    root.current?.measureInWindow((rx, ry) => {
      setOffset([rx, ry]);
      stageRef.current?.measureInWindow((x, y, width, height) =>
        setStage([
          x - rx + STAGE_MARGIN,
          y - ry + STAGE_MARGIN,
          Math.max(width - STAGE_MARGIN * 2, 0),
          Math.max(height - STAGE_MARGIN * 2, 0),
        ]),
      );
    });
  }, [root, stageRef]);

  useEffect(() => {
    if (!stage || !offset || closing.current) return;
    const target = fitRect(aspect, stage);
    if (to.get() === null) {
      to.set(target);
      from.set(
        origin
          ? [origin.rect[0] - offset[0], origin.rect[1] - offset[1], origin.rect[2], origin.rect[3]]
          : [target[0] + target[2] * 0.04, target[1] + target[3] * 0.04, target[2] * 0.92, target[3] * 0.92],
      );
      progress.set(
        withTiming(1, { duration: reduced ? 0 : OPEN_MS, easing: EASING }, (finished) => {
          if (finished) scheduleOnRN(setLanded, true);
        }),
      );
    } else {
      to.set(withTiming(target, { duration: reduced ? 0 : RETARGET_MS }));
    }
  }, [stage, offset, aspect, origin, reduced, from, to, progress]);

  const pop = useCallback(() => router.back(), []);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    closingOnUI.set(true);
    let collapsed = false;
    const collapse = () => {
      if (collapsed) return;
      collapsed = true;
      const duration = reduced ? 0 : CLOSE_MS;
      drag.set(withTiming(0, { duration, easing: EASING }));
      progress.set(withTiming(0, { duration, easing: EASING }, () => scheduleOnRN(pop)));
    };
    const { thumbnail } = origin ?? {};
    if (!thumbnail || !offset) return collapse();
    setTimeout(collapse, REMEASURE_MS);
    thumbnail.measureInWindow((x, y, width, height) => {
      if (!collapsed && width > 0 && height > 0) from.set([x - offset[0], y - offset[1], width, height]);
      collapse();
    });
  }, [drag, progress, from, closingOnUI, origin, offset, pop, reduced]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const hasOrigin = origin !== null;
  const fitted = stage ? fitRect(aspect, stage) : null;
  const dismissDistance = window.height / 2;
  const screenStyle = useAnimatedStyle(() => {
    const target = to.get();
    if (!target) return { opacity: 0, left: 0, top: 0, width: 0, height: 0 };
    const [left, top, width, height] = zoomRect(
      from.get() ?? target,
      target,
      progress.get(),
      drag.get(),
      dismissDistance,
    );
    return { left, top, width, height, opacity: hasOrigin ? 1 : progress.get(), borderRadius: 6 + 2 * progress.get() };
  });
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: progress.get() * (1 - Math.min(Math.max(drag.get(), 0) / dismissDistance, 1)),
  }));

  const pan = usePanGesture({
    enabled: dragEnabled,
    activeOffsetY: 12,
    failOffsetX: [-24, 24],
    onUpdate: (event) => {
      'worklet';
      if (!closingOnUI.get()) drag.set(event.translationY);
    },
    onDeactivate: (event) => {
      'worklet';
      if (closingOnUI.get()) return;
      const dismiss = event.translationY > DISMISS_DRAG || event.velocityY > DISMISS_VELOCITY;
      if (dismiss && !event.canceled) scheduleOnRN(close);
      else drag.set(withSpring(0, { damping: 20, stiffness: 220 }));
    },
  });

  return {
    measure,
    screenStyle,
    fadeStyle,
    pan,
    close,
    snapshot: origin?.frame ?? null,
    screenSize: fitted ? { width: fitted[2], height: fitted[3] } : null,
    landed,
  };
}
