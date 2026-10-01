import type { ReservedRegion } from 'react-native-reserved-regions';

/** A fold that splits the screen: its axis and the span, in points, that it covers across that axis. */
export type Fold = { axis: 'vertical' | 'horizontal'; start: number; end: number };

/** The active division that runs across a `width` by `height` screen and leaves room on both sides of it. */
export function foldOf(regions: readonly ReservedRegion[], width: number, height: number): Fold | null {
  for (const region of regions) {
    if (region.kind !== 'division') continue;
    const { x, y, width: across, height: along } = region.frame;
    if (along >= across && x > 0 && x + across < width) return { axis: 'vertical', start: x, end: x + across };
    if (across > along && y > 0 && y + along < height) return { axis: 'horizontal', start: y, end: y + along };
  }
  return null;
}
