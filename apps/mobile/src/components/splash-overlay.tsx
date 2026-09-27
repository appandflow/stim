import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { Appearance, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '@/design/tokens';

const ICON = require('@/assets/images/icon.png');

/** `imageWidth` of the `expo-splash-screen` config in app.config.ts. */
const ICON_SIZE = 120;

const SQUEEZE_MS = 140;
const BURST_MS = 520;
const CROSSFADE_MS = 250;
const DISPLAY_TIMEOUT_MS = 300;

let played = false;

/**
 * Draws the native splash in JS and hides the native one once this frame is on screen, then plays the dismiss once
 * per app process: the icon squeezes, then bursts toward the viewer while a ring pulses out and the background clears.
 * Reduce Motion gets a crossfade.
 */
export function SplashOverlay() {
  const [visible, setVisible] = useState(!played);
  const [scheme] = useState<'light' | 'dark'>(() => (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'));
  const reduceMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(false);
  const backdrop = useSharedValue(1);
  const iconScale = useSharedValue(1);
  const iconOpacity = useSharedValue(1);
  const ring = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    if (!displayed) {
      const timeout = setTimeout(() => setDisplayed(true), DISPLAY_TIMEOUT_MS);
      return () => clearTimeout(timeout);
    }
    played = true;
    SplashScreen.hide();
    if (reduceMotion) {
      const crossfade = { duration: CROSSFADE_MS, reduceMotion: ReduceMotion.Never };
      backdrop.set(withTiming(0, crossfade));
      iconOpacity.set(withTiming(0, crossfade));
    } else {
      iconScale.set(
        withSequence(
          withTiming(0.9, { duration: SQUEEZE_MS, easing: Easing.out(Easing.quad) }),
          withTiming(4, { duration: BURST_MS, easing: Easing.in(Easing.cubic) }),
        ),
      );
      iconOpacity.set(withDelay(SQUEEZE_MS + BURST_MS * 0.3, withTiming(0, { duration: BURST_MS * 0.7 })));
      ring.set(withDelay(SQUEEZE_MS, withTiming(1, { duration: BURST_MS, easing: Easing.out(Easing.cubic) })));
      backdrop.set(withDelay(SQUEEZE_MS, withTiming(0, { duration: BURST_MS, easing: Easing.inOut(Easing.quad) })));
    }
    const timeout = setTimeout(() => setVisible(false), reduceMotion ? CROSSFADE_MS : SQUEEZE_MS + BURST_MS);
    return () => clearTimeout(timeout);
  }, [visible, displayed, reduceMotion, backdrop, iconScale, iconOpacity, ring]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.get() }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: iconOpacity.get(),
    transform: [{ scale: iconScale.get() }, { rotate: `${(iconScale.get() - 1) * -4}deg` }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ring.get() === 0 ? 0 : 0.5 * (1 - ring.get()),
    transform: [{ scale: 0.6 + ring.get() * 6 }],
  }));

  if (!visible) return null;
  return (
    <Animated.View style={StyleSheet.absoluteFill} pointerEvents="none" testID="splash-overlay">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors[scheme].background }, backdropStyle]} />
      <Animated.View style={[styles.center, StyleSheet.absoluteFill]}>
        <Animated.View style={[styles.ring, ringStyle]} />
        <Animated.View style={iconStyle}>
          <Image source={ICON} style={styles.icon} onDisplay={() => setDisplayed(true)} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  icon: { width: ICON_SIZE, height: ICON_SIZE },
  ring: {
    position: 'absolute',
    width: ICON_SIZE * 0.8,
    height: ICON_SIZE * 0.8,
    borderRadius: ICON_SIZE * 0.4,
    borderWidth: 4,
    borderColor: colors.light.brand,
  },
});
