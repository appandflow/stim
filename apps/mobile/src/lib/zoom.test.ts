import { clampOffset, fitRect, liftAbove, zoomOffset, zoomRect, type Rect } from '@/lib/zoom';

describe('fitRect', () => {
  it('centers a phone screen in a wider stage and a landscape one in a taller stage', () => {
    expect(fitRect(0.5, [0, 100, 400, 600])).toEqual([50, 100, 300, 600]);
    expect(fitRect(2, [10, 0, 400, 600])).toEqual([10, 200, 400, 200]);
  });
});

describe('zoomRect', () => {
  const from: Rect = [20, 300, 100, 200];
  const to: Rect = [0, 50, 400, 800];

  it('starts on the thumbnail and ends on the stage', () => {
    expect(zoomRect(from, to, 0, 0, 400)).toEqual(from);
    expect(zoomRect(from, to, 1, 0, 400)).toEqual(to);
  });

  it('shrinks the screen about its center as it follows a drag down, and ignores a drag up', () => {
    expect(zoomRect(from, to, 1, 200, 400)).toEqual([50, 350, 300, 600]);
    expect(zoomRect(from, to, 1, -80, 400)).toEqual(to);
  });
});

describe('liftAbove', () => {
  it('lifts the screen until its bottom meets the keyboard', () => {
    expect(liftAbove(200, 500, 600, 100)).toBe(100);
  });

  it('stops at the header when the screen is taller than the room above the keyboard', () => {
    expect(liftAbove(200, 560, 480, 110)).toBe(90);
  });

  it('leaves a screen that already ends above the keyboard in place', () => {
    expect(liftAbove(200, 300, 600, 100)).toBe(0);
  });
});

describe('zoomOffset', () => {
  it('keeps the point under the fingers in place', () => {
    const offset = zoomOffset(1, 0, 2, 0.25);
    const start = (1 - 2) / 2 + offset;
    expect(start + 0.25 * 2).toBeCloseTo(0.25);
  });

  it('never pans past the picture edge, and centers the picture back at fit', () => {
    expect(zoomOffset(1, 0, 2, 0)).toBe(0.5);
    expect(zoomOffset(3, -1, 1, 0.9)).toBeCloseTo(0);
  });
});

describe('clampOffset', () => {
  it('limits a pan to what overflows the view', () => {
    expect(clampOffset(2, 3)).toBe(1);
    expect(clampOffset(-2, 3)).toBe(-1);
    expect(clampOffset(0.3, 1)).toBeCloseTo(0);
  });
});
