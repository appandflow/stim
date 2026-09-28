import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { EaseView } from 'react-native-ease';

const COLUMNS = 10;
/** Neighbouring pixels overlap so no hairline of the content shows between them before they move. */
const OVERLAP = 1;
const PIXEL_MS = 160;
const SPREAD_MS = 450;
const VANISHED = { scale: 0 };
const COVERING = { scale: 1 };

/** Longest time from `dismissed` until the last pixel is gone, not counting `delay`. */
export const PIXEL_DISMISS_MS = SPREAD_MS + PIXEL_MS;

/** Delay before a pixel starts to vanish: a random time up to `spreadMs`, so the pixels go in no order. */
export function dissolveDelay(spreadMs: number) {
  return Math.round(Math.random() * spreadMs);
}

/**
 * Covers the screen with square pixels of `color`. When `dismissed` turns true, the pixels shrink away in random
 * order after `delay` ms. Each pixel is an `EaseView`, so the whole dissolve runs on native animations from a single
 * render.
 */
export function PixelDismiss({ color, dismissed, delay }: { color: string; dismissed: boolean; delay: number }) {
  const { width, height } = useWindowDimensions();
  const grid = useMemo(() => pixelGrid(width, height), [width, height]);

  return (
    <View style={styles.center}>
      <View style={{ width, height: grid.height }}>
        {grid.pixels.map(({ key, left, top, delayMs }) => (
          <EaseView
            key={key}
            style={[styles.pixel, { left, top, width: grid.pixelSize, height: grid.pixelSize, backgroundColor: color }]}
            animate={dismissed ? VANISHED : COVERING}
            transition={{ type: 'timing', duration: PIXEL_MS, delay: delay + delayMs, easing: 'easeOut' }}
          />
        ))}
      </View>
    </View>
  );
}

function pixelGrid(width: number, height: number) {
  const size = width / COLUMNS;
  const rows = 2 * Math.ceil(height / 2 / size);
  const pixels = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      pixels.push({
        key: `${row}:${column}`,
        left: column * size,
        top: row * size,
        delayMs: dissolveDelay(SPREAD_MS),
      });
    }
  }
  return { pixelSize: size + OVERLAP, height: rows * size, pixels };
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pixel: { position: 'absolute' },
});
