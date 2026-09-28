import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { EaseView } from 'react-native-ease';

const COLUMNS = 10;
/** Neighbouring pixels overlap so no hairline of the content shows between them before they move. */
const OVERLAP = 1;
const PIXEL_MS = 160;
const SPREAD_MS = 300;
const VANISHED = { scale: 0, rotate: 45 };
const COVERING = { scale: 1, rotate: 0 };

/** Longest time from `dismissed` until the last pixel is gone, not counting `delay`. */
export const PIXEL_DISMISS_MS = SPREAD_MS + PIXEL_MS;

/**
 * Delay before the pixel at `row`, `column` starts to vanish. It grows with the distance from the centre of the grid
 * to the pixel's centre, scaled so the grid's outer corners would be at `spreadMs`.
 */
export function rippleDelay(row: number, column: number, rows: number, columns: number, spreadMs: number) {
  const distance = Math.hypot(column + 0.5 - columns / 2, row + 0.5 - rows / 2);
  const maxDistance = Math.hypot(columns / 2, rows / 2);
  return Math.round((distance / maxDistance) * spreadMs);
}

/**
 * Covers the screen with square pixels of `color`. When `dismissed` turns true, the pixels shrink and turn away,
 * rippling outward from the centre after `delay` ms. Each pixel is an `EaseView`, so the whole ripple runs on native
 * animations from a single render.
 */
export function PixelDismiss({ color, dismissed, delay }: { color: string; dismissed: boolean; delay: number }) {
  const { width, height } = useWindowDimensions();
  const grid = useMemo(() => pixelGrid(width, height), [width, height]);

  return (
    <View style={styles.center}>
      <View style={{ width, height: grid.height }}>
        {grid.pixels.map(({ key, left, top, rippleMs }) => (
          <EaseView
            key={key}
            style={[styles.pixel, { left, top, width: grid.pixelSize, height: grid.pixelSize, backgroundColor: color }]}
            animate={dismissed ? VANISHED : COVERING}
            transition={{ type: 'timing', duration: PIXEL_MS, delay: delay + rippleMs, easing: 'easeOut' }}
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
        rippleMs: rippleDelay(row, column, rows, COLUMNS, SPREAD_MS),
      });
    }
  }
  return { pixelSize: size + OVERLAP, height: rows * size, pixels };
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pixel: { position: 'absolute' },
});
