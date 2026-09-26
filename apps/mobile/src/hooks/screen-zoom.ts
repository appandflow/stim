import { useEffect, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from 'react-native-gesture-handler';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { clampOffset, zoomOffset } from '@/lib/zoom';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const RESET_MS = 200;

/**
 * Pinch to zoom, drag to pan and double-tap to zoom in or back to fit, for a picture filling the view that gets
 * `onLayout`. It works only while `enabled`, and goes back to fit when disabled. The style sizes the picture by layout,
 * not a transform, because Android's `SurfaceView` does not follow a scale transform.
 */
export function useScreenZoom(enabled: boolean) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pinchStart = useSharedValue({ scale: 1, pinch: 1, x: 0, y: 0, focalX: 0, focalY: 0 });
  const panStart = useSharedValue({ x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const size = useSharedValue({ width: 0, height: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    size.set({ width, height });
  };

  useEffect(() => {
    if (enabled) return;
    scale.set(1);
    x.set(0);
    y.set(0);
  }, [enabled, scale, x, y]);
  if (!enabled && zoomed) setZoomed(false);

  const settle = () => {
    'worklet';
    const fit = scale.get() <= 1.01;
    if (fit) {
      scale.set(withTiming(1, { duration: RESET_MS }));
      x.set(withTiming(0, { duration: RESET_MS }));
      y.set(withTiming(0, { duration: RESET_MS }));
    }
    scheduleOnRN(setZoomed, !fit);
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
      const { width, height } = size.get();
      if (width <= 0 || height <= 0) return;
      const from = pinchStart.get();
      const next = Math.min(Math.max((from.scale * event.scale) / from.pinch, 1), MAX_SCALE);
      x.set(zoomOffset(from.scale, from.x, next, from.focalX / width, event.focalX / width));
      y.set(zoomOffset(from.scale, from.y, next, from.focalY / height, event.focalY / height));
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
      const { width, height } = size.get();
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
      const { width, height } = size.get();
      if (width <= 0 || height <= 0) return;
      x.set(withTiming(zoomOffset(1, 0, DOUBLE_TAP_SCALE, event.x / width), { duration: RESET_MS }));
      y.set(withTiming(zoomOffset(1, 0, DOUBLE_TAP_SCALE, event.y / height), { duration: RESET_MS }));
      scale.set(withTiming(DOUBLE_TAP_SCALE, { duration: RESET_MS }));
      scheduleOnRN(setZoomed, true);
    },
  });

  const gesture = useSimultaneousGestures(pinch, pan, doubleTap);
  const style = useAnimatedStyle(() => {
    const s = scale.get();
    return {
      position: 'absolute',
      left: `${((1 - s) / 2 + x.get()) * 100}%`,
      top: `${((1 - s) / 2 + y.get()) * 100}%`,
      width: `${s * 100}%`,
      height: `${s * 100}%`,
    };
  });
  return { gesture, style, zoomed, onLayout };
}
