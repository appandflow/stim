import type { ReservedRegion } from 'react-native-reserved-regions';

export type Fold = { axis: 'vertical' | 'horizontal'; start: number; end: number };

export function foldOf(regions: readonly ReservedRegion[], width: number, height: number): Fold | null {
  for (const region of regions) {
    if (region.kind !== 'division') continue;
    const { x, y, width: across, height: along } = region.frame;
    if (along >= across && x > 0 && x + across < width) return { axis: 'vertical', start: x, end: x + across };
    if (across > along && y > 0 && y + along < height) return { axis: 'horizontal', start: y, end: y + along };
  }
  return null;
}
