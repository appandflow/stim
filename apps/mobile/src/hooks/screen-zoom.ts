import { useEffect, useMemo, useState } from 'react';
import { usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from 'react-native-gesture-handler';
import { useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { clampOffset, zoomOffset, type Rect } from '@/lib/zoom';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const RESET_MS = 200;

/**
 * A zoom as the scale of the fitted screen and its offset as fractions of the fitted size. `fit` is the fitted
 * screen's rect, which the owner of the screen's layout keeps current.
 */
export interface ScreenLens {
  scale: SharedValue<number>;
  x: SharedValue<number>;
  y: SharedValue<number>;
  fit: SharedValue<Rect>;
}

/**
 * Pinch to zoom, drag to pan and double-tap to zoom in or back to fit, for a screen fitted at `lens.fit` in the
 * coordinates of the view that gets the gesture, which must not move with the zoom. It works only while
 * `enabled`, and goes back to fit when disabled. The caller applies the lens to the screen's own frame.
 */
export function useScreenZoom(enabled: boolean) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pinchStart = useSharedValue({ scale: 1, pinch: 1, x: 0, y: 0, focalX: 0, focalY: 0 });
  const panStart = useSharedValue({ x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const box = useSharedValue<Rect>([0, 0, 0, 0]);

  useEffect(() => {
    if (enabled) return;
    scale.set(1);
    x.set(0);
    y.set(0);
  }, [enabled, scale, x, y]);
  if (!enabled && zoomed) setZoomed(false);

  const settle = () => {
    'worklet';
    const fitted = scale.get() <= 1.01;
    if (fitted) {
      scale.set(withTiming(1, { duration: RESET_MS }));
      x.set(withTiming(0, { duration: RESET_MS }));
      y.set(withTiming(0, { duration: RESET_MS }));
    }
    scheduleOnRN(setZoomed, !fitted);
  };

  const pinch = usePinchGesture({
    enabled,
    onActivate: (event) => {
      'worklet';
      pinchStart.set({
        scale: scale.get(),
        pinch: event.scale || 1,
        x: x.get(),
        y: y.get(),
        focalX: event.focalX,
        focalY: event.focalY,
      });
    },
    onUpdate: (event) => {
      'worklet';
      const [left, top, width, height] = box.get();
      if (width <= 0 || height <= 0) return;
      const from = pinchStart.get();
      const next = Math.min(Math.max((from.scale * event.scale) / from.pinch, 1), MAX_SCALE);
      x.set(zoomOffset(from.scale, from.x, next, (from.focalX - left) / width, (event.focalX - left) / width));
      y.set(zoomOffset(from.scale, from.y, next, (from.focalY - top) / height, (event.focalY - top) / height));
      scale.set(next);
    },
    onDeactivate: settle,
  });

  const pan = usePanGesture({
    enabled: enabled && zoomed,
    maxPointers: 1,
    onBegin: () => {
      'worklet';
      panStart.set({ x: x.get(), y: y.get() });
    },
    onUpdate: (event) => {
      'worklet';
      const [, , width, height] = box.get();
      if (width <= 0 || height <= 0) return;
      const from = panStart.get();
      x.set(clampOffset(from.x + event.translationX / width, scale.get()));
      y.set(clampOffset(from.y + event.translationY / height, scale.get()));
    },
  });

  const doubleTap = useTapGesture({
    enabled,
    numberOfTaps: 2,
    onActivate: (event) => {
      'worklet';
      if (scale.get() > 1) {
        scale.set(withTiming(1, { duration: RESET_MS }));
        x.set(withTiming(0, { duration: RESET_MS }));
        y.set(withTiming(0, { duration: RESET_MS }));
        scheduleOnRN(setZoomed, false);
        return;
      }
      const [left, top, width, height] = box.get();
      if (width <= 0 || height <= 0) return;
      x.set(withTiming(zoomOffset(1, 0, DOUBLE_TAP_SCALE, (event.x - left) / width), { duration: RESET_MS }));
      y.set(withTiming(zoomOffset(1, 0, DOUBLE_TAP_SCALE, (event.y - top) / height), { duration: RESET_MS }));
      scale.set(withTiming(DOUBLE_TAP_SCALE, { duration: RESET_MS }));
      scheduleOnRN(setZoomed, true);
    },
  });

  const gesture = useSimultaneousGestures(pinch, pan, doubleTap);
  const lens = useMemo<ScreenLens>(() => ({ scale, x, y, fit: box }), [scale, x, y, box]);
  return { gesture, lens, zoomed };
}
