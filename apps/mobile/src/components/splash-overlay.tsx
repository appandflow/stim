import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { EaseView } from 'react-native-ease';
import { useReducedMotion } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { PIXEL_DISMISS_MS, PixelDismiss } from '@/components/pixel-dismiss';
import { colors } from '@/design/tokens';

const LOGO = require('@/assets/images/splash-logo.png');

/** `backgroundColor` and `imageWidth` of the `expo-splash-screen` config in app.config.ts. */
const SPLASH_COLOR = colors.light.brand;
const LOGO_SIZE = 120;

const LOGO_POP_SCALE = 1.2;
const LOGO_POP_MS = 90;
const LOGO_SHRINK_MS = 130;
const PIXELS_DELAY_MS = 100;
const APP_START_SCALE = 0.98;
const APP_SETTLE_MS = 600;
const CROSSFADE_MS = 250;
/** The native animations start once this render reaches the UI thread, after the unmount timer starts. */
const UNMOUNT_SLACK_MS = 50;
const DISPLAY_TIMEOUT_MS = 300;

let played = false;

/**
 * Wraps the app, draws the native splash over it, and hides the native splash once this frame is on screen. Then it
 * plays the dismiss once per app process: the logo pops and shrinks, and the purple breaks into pixels that vanish
 * outward from it while the app settles into place. Reduce Motion gets a crossfade.
 */
export function SplashOverlay({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(!played);
  const [displayed, setDisplayed] = useState(false);
  const [replayed] = useState(played);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!visible) return;
    if (!displayed) {
      const timeout = setTimeout(() => setDisplayed(true), DISPLAY_TIMEOUT_MS);
      return () => clearTimeout(timeout);
    }
    played = true;
    SplashScreen.hide();
    const timeout = setTimeout(
      () => setVisible(false),
      (reduceMotion ? CROSSFADE_MS : PIXELS_DELAY_MS + PIXEL_DISMISS_MS) + UNMOUNT_SLACK_MS,
    );
    return () => clearTimeout(timeout);
  }, [visible, displayed, reduceMotion]);

  const started = replayed || displayed;
  const dismissed = started && !reduceMotion;

  return (
    <View style={styles.backdrop}>
      <EaseView
        style={styles.app}
        animate={{ scale: started ? 1 : APP_START_SCALE }}
        transition={
          reduceMotion
            ? { type: 'none' }
            : { type: 'timing', duration: APP_SETTLE_MS, delay: PIXELS_DELAY_MS, easing: 'easeOut' }
        }
      >
        {children}
      </EaseView>
      {visible && (
        <EaseView
          style={styles.overlay}
          animate={{ opacity: started && reduceMotion ? 0 : 1 }}
          transition={{ type: 'timing', duration: CROSSFADE_MS, easing: 'easeInOut' }}
          useHardwareLayer
          pointerEvents="none"
          testID="splash-overlay"
        >
          {reduceMotion ? (
            <View style={styles.fill} />
          ) : (
            <PixelDismiss color={SPLASH_COLOR} dismissed={dismissed} delay={PIXELS_DELAY_MS} />
          )}
          <EaseView
            style={styles.logo}
            animate={{ scale: dismissed ? LOGO_POP_SCALE : 1 }}
            transition={{ type: 'timing', duration: LOGO_POP_MS, easing: 'easeOut' }}
          >
            <EaseView
              style={styles.logo}
              animate={{ scale: dismissed ? 0 : 1 }}
              transition={{ type: 'timing', duration: LOGO_SHRINK_MS, delay: LOGO_POP_MS, easing: 'easeIn' }}
            >
              <Image source={LOGO} style={styles.logo} onDisplay={() => setDisplayed(true)} />
            </EaseView>
          </EaseView>
        </EaseView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: { flex: 1, backgroundColor: theme.colors.background },
  app: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  fill: { ...StyleSheet.absoluteFill, backgroundColor: SPLASH_COLOR },
  logo: { width: LOGO_SIZE, height: LOGO_SIZE },
}));
