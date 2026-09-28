import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, StyleSheet, useWindowDimensions, View } from 'react-native';
import { EaseView } from 'react-native-ease';
import { useReducedMotion } from 'react-native-reanimated';

import { colors } from '@/design/tokens';

const ICON = require('@/assets/images/icon.png');

/** `imageWidth` of the `expo-splash-screen` config in app.config.ts. */
const ICON_SIZE = 120;
/**
 * icon.png draws a 96 pt purple square with a 22 pt radius. The flood starts 1 pt inside it so the icon hides it
 * completely on the first frame.
 */
const FLOOD_SIZE = 94;
const FLOOD_RADIUS = 21;
/**
 * icon.png's white letter circle is 66 pt wide. Android clips without anti-aliasing, so the clip keeps a purple margin
 * and its edge falls on purple.
 */
const LETTERS_CLIP = 72;
const COLUMNS = 10;

const FLOOD_MS = 350;
/** Core Animation replaces a 0 duration with its 0.25 s default. */
const CUT_MS = 1;
const RIPPLE_DELAY_MS = 100;
const RIPPLE_SPREAD_MS = 300;
const PIXEL_MS = 160;
const RIPPLE_END_MS = FLOOD_MS + RIPPLE_DELAY_MS + RIPPLE_SPREAD_MS + PIXEL_MS;
const POP_MS = 90;
const SHRINK_MS = 130;
const SETTLE_DELAY_MS = FLOOD_MS + 50;
const SETTLE_MS = 600;
const CROSSFADE_MS = 250;
/** The native animations start once this render reaches the UI thread, after the unmount timer starts. */
const UNMOUNT_SLACK_MS = 50;
const DISPLAY_TIMEOUT_MS = 300;

let played = false;

/**
 * Wraps the app, draws the native splash over it, and hides the native splash once this frame is on screen. Then it
 * plays the dismiss once per app process: the icon's purple square floods the screen, the letters pop and shrink, and
 * the purple breaks into pixels that vanish outward from the logo while the app settles into place. Reduce Motion gets
 * a crossfade.
 */
export function SplashOverlay({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(!played);
  const [scheme] = useState<'light' | 'dark'>(() => (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'));
  const reduceMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(false);
  const [replayed] = useState(played);
  const { width, height } = useWindowDimensions();

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
      (reduceMotion ? CROSSFADE_MS : RIPPLE_END_MS) + UNMOUNT_SLACK_MS,
    );
    return () => clearTimeout(timeout);
  }, [visible, displayed, reduceMotion]);

  const started = replayed || displayed;
  const grid = useMemo(() => pixelGrid(width, height), [width, height]);
  const ripple = started && !reduceMotion;
  const floodScale = (Math.max(width, height) + 4 * grid.size) / FLOOD_SIZE;

  return (
    <>
      <EaseView
        style={styles.app}
        animate={{ scale: started ? 1 : 0.98 }}
        transition={
          reduceMotion
            ? { type: 'none' }
            : { type: 'timing', duration: SETTLE_MS, delay: SETTLE_DELAY_MS, easing: 'easeOut' }
        }
      >
        {children}
      </EaseView>
      {visible && (
        <EaseView
          style={[StyleSheet.absoluteFill, styles.center]}
          animate={{ opacity: started && reduceMotion ? 0 : 1 }}
          transition={{ type: 'timing', duration: CROSSFADE_MS, easing: 'easeInOut' }}
          useHardwareLayer
          pointerEvents="none"
          testID="splash-overlay"
        >
          {!reduceMotion && (
            <View style={[styles.grid, { width: grid.width, height: grid.height }]}>
              {grid.cells.map((cell) => (
                <EaseView
                  key={cell.key}
                  style={[
                    styles.pixel,
                    { left: cell.left, top: cell.top, width: grid.size + 1, height: grid.size + 1 },
                  ]}
                  animate={ripple ? { scale: 0, rotate: 45 } : { scale: 1, rotate: 0 }}
                  transition={{ type: 'timing', duration: PIXEL_MS, delay: cell.delay, easing: 'easeOut' }}
                />
              ))}
            </View>
          )}
          <EaseView
            style={[StyleSheet.absoluteFill, { backgroundColor: colors[scheme].background }]}
            animate={{ opacity: ripple ? 0 : 1 }}
            transition={{ type: 'timing', duration: CUT_MS, delay: FLOOD_MS - 20 }}
          />
          <EaseView
            style={styles.flood}
            animate={
              ripple
                ? { opacity: 0, scale: floodScale, borderRadius: 2 }
                : { opacity: 1, scale: 1, borderRadius: FLOOD_RADIUS }
            }
            transition={{
              default: { type: 'timing', duration: FLOOD_MS, easing: [0.7, 0, 0.3, 1] },
              opacity: { type: 'timing', duration: CUT_MS, delay: FLOOD_MS },
            }}
          />
          <EaseView
            style={styles.icon}
            animate={{ opacity: ripple ? 0 : 1 }}
            transition={{ type: 'timing', duration: CUT_MS, delay: FLOOD_MS - 20 }}
          >
            <Image source={ICON} style={styles.icon} onDisplay={() => setDisplayed(true)} />
          </EaseView>
          <EaseView
            style={styles.letters}
            animate={{ scale: ripple ? 1.2 : 1 }}
            transition={{ type: 'timing', duration: POP_MS, delay: FLOOD_MS, easing: 'easeOut' }}
          >
            <EaseView
              style={styles.lettersClip}
              animate={{ scale: ripple ? 0 : 1 }}
              transition={{ type: 'timing', duration: SHRINK_MS, delay: FLOOD_MS + POP_MS, easing: 'easeIn' }}
            >
              <Image source={ICON} style={styles.lettersIcon} />
            </EaseView>
          </EaseView>
        </EaseView>
      )}
    </>
  );
}

function pixelGrid(width: number, height: number) {
  const size = width / COLUMNS;
  const rows = (Math.ceil(height / 2 / size) + 1) * 2;
  const gridHeight = rows * size;
  const maxDistance = Math.hypot(width / 2, gridHeight / 2);
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const left = column * size;
      const top = row * size;
      const distance = Math.hypot(left + size / 2 - width / 2, top + size / 2 - gridHeight / 2);
      const delay = Math.round(FLOOD_MS + RIPPLE_DELAY_MS + (distance / maxDistance) * RIPPLE_SPREAD_MS);
      cells.push({ key: `${row}:${column}`, left, top, delay });
    }
  }
  return { size, width, height: gridHeight, cells };
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  grid: { position: 'absolute' },
  icon: { width: ICON_SIZE, height: ICON_SIZE },
  flood: { position: 'absolute', width: FLOOD_SIZE, height: FLOOD_SIZE, backgroundColor: colors.light.brand },
  pixel: { position: 'absolute', backgroundColor: colors.light.brand },
  letters: { position: 'absolute', width: LETTERS_CLIP, height: LETTERS_CLIP },
  lettersClip: { width: LETTERS_CLIP, height: LETTERS_CLIP, borderRadius: LETTERS_CLIP / 2, overflow: 'hidden' },
  lettersIcon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    marginLeft: (LETTERS_CLIP - ICON_SIZE) / 2,
    marginTop: (LETTERS_CLIP - ICON_SIZE) / 2,
  },
});
