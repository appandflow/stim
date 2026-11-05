import type { ReservedRegion } from 'react-native-reserved-regions';

import { foldOf } from '@/lib/fold';

const camera: ReservedRegion = { kind: 'occlusion', frame: { x: 867, y: 0, width: 84, height: 120 } };

describe('foldOf', () => {
  it('reads the iPhone Duo half-open division as a vertical fold and ignores the camera', () => {
    const division: ReservedRegion = {
      kind: 'division',
      frame: { x: 455.5, y: 0, width: 40, height: 669 },
      occludesContent: false,
    };
    expect(foldOf([camera, division], 951, 669)).toEqual({ axis: 'vertical', start: 455.5, end: 495.5 });
  });

  it('reads a zero-height Android fold across a landscape screen as horizontal', () => {
    const division: ReservedRegion = {
      kind: 'division',
      frame: { x: 0, y: 420, width: 900, height: 0 },
      occludesContent: false,
    };
    expect(foldOf([division], 900, 840)).toEqual({ axis: 'horizontal', start: 420, end: 420 });
  });

  it('has no fold without a division, or with one at the edge of the screen', () => {
    expect(foldOf([camera], 951, 669)).toBeNull();
    const edge: ReservedRegion = {
      kind: 'division',
      frame: { x: 0, y: 0, width: 40, height: 669 },
      occludesContent: false,
    };
    expect(foldOf([edge], 951, 669)).toBeNull();
  });
});
