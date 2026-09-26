import { fitRect, liftAbove, zoomRect, type Rect } from '@/lib/zoom';

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
