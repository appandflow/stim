import { expect, test } from 'vitest';
import { canTilt } from './canTilt';

test('opposite tap edges produce opposite tilt axes, regardless of page position', () => {
  const bounds = { left: 100, top: 300, width: 200, height: 200 };
  expect(canTilt(bounds, 100, 400)).toEqual({ x: 0, y: -6 });
  expect(canTilt(bounds, 300, 400)).toEqual({ x: 0, y: 6 });
  expect(canTilt(bounds, 200, 300)).toEqual({ x: 6, y: 0 });
  expect(canTilt(bounds, 200, 500)).toEqual({ x: -6, y: 0 });
  expect(canTilt(bounds, 200, 400)).toEqual({ x: 0, y: 0 });
  expect(canTilt(bounds, 250, 350)).toEqual({ x: 3, y: 3 });
});
