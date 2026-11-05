import type { ReservedRegion } from 'react-native-reserved-regions';

import { foldOf } from '@/lib/fold';

export function sidebarOf(regions: readonly ReservedRegion[], width: number, height: number) {
  const fold = foldOf(regions, width, height);
  if (fold?.axis === 'vertical') {
    return fold.start >= 300 && width - fold.end >= 300 ? { width: fold.start, gap: fold.end - fold.start } : null;
  }
  return width >= 640 && height >= 600 ? { width: width / 3, gap: 0 } : null;
}
