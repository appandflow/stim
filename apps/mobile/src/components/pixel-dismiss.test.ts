import { dissolveDelay } from '@/components/pixel-dismiss';

describe('dissolveDelay', () => {
  it('stays within the spread', () => {
    const delays = Array.from({ length: 1000 }, () => dissolveDelay(450));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(450);
  });
});
