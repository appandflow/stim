import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { EaseView } from 'react-native-ease';

const COLUMNS = 10;
/** Neighbouring pixels overlap so no hairline of the content shows between them before they move. */
const OVERLAP = 1;
const PIXEL_MS = 400;
const SPREAD_MS = 500;
/** How many columns later a column's top row starts than its bottom row. */
const ROW_LAG = 4;
const COVERING = { translateY: 0, rotate: 0 };

/** Longest time from `dismissed` until the last pixel is gone, not counting `delay`. */
export const PIXEL_DISMISS_MS = SPREAD_MS + PIXEL_MS;

/**
 * Delay before the pixel at `row`, `column` starts to fall. Columns go from left to right, and each column drops its
 * bottom row first and its top row `ROW_LAG` columns later. Up to one column of random lag breaks each column apart.
 * The delays are scaled so the last pixel starts before `spreadMs`.
 */
export function fallDelay(row: number, column: number, rows: number, columns: number, spreadMs: number) {
  const order = column + (ROW_LAG * (rows - 1 - row)) / rows + Math.random();
  return Math.round((order / (columns + ROW_LAG)) * spreadMs);
}

/**
 * Covers the screen with square pixels of `color`. When `dismissed` turns true, the pixels tumble off the bottom,
 * column by column, after `delay` ms. Each pixel is an `EaseView`, so the whole fall runs on native animations from a
 * single render.
 */
export function PixelDismiss({ color, dismissed, delay }: { color: string; dismissed: boolean; delay: number }) {
  const { width, height } = useWindowDimensions();
  const grid = useMemo(() => pixelGrid(width, height), [width, height]);

  return (
    <View style={styles.center}>
      <View style={{ width, height: grid.height }}>
        {grid.pixels.map(({ key, left, top, delayMs, vanished }) => (
          <EaseView
            key={key}
            style={[styles.pixel, { left, top, width: grid.pixelSize, height: grid.pixelSize, backgroundColor: color }]}
            animate={dismissed ? vanished : COVERING}
            transition={{ type: 'timing', duration: PIXEL_MS, delay: delay + delayMs, easing: 'easeIn' }}
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
        delayMs: fallDelay(row, column, rows, COLUMNS, SPREAD_MS),
        vanished: { translateY: (rows + 1 - row) * size, rotate: (Math.random() - 0.5) * 140 },
      });
    }
  }
  return { pixelSize: size + OVERLAP, height: rows * size, pixels };
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pixel: { position: 'absolute' },
});
