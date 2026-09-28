import { fallDelay } from '@/components/pixel-dismiss';

describe('fallDelay', () => {
  it('drops the bottom of the left column first and the top of the right column last', () => {
    for (let i = 0; i < 100; i++) {
      const bottomLeft = fallDelay(9, 0, 10, 10, 500);
      const topLeft = fallDelay(0, 0, 10, 10, 500);
      const bottomRight = fallDelay(9, 9, 10, 10, 500);
      const topRight = fallDelay(0, 9, 10, 10, 500);
      expect(bottomLeft).toBeLessThan(topLeft);
      expect(bottomLeft).toBeLessThan(bottomRight);
      expect(topRight).toBeGreaterThan(topLeft);
      expect(topRight).toBeGreaterThan(bottomRight);
      expect(topRight).toBeLessThanOrEqual(500);
    }
  });
});
