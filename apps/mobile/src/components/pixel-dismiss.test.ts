import { rippleDelay } from '@/components/pixel-dismiss';

describe('rippleDelay', () => {
  it('starts at the centre and grows with the distance from it', () => {
    const delays = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: 4 }, (_, column) => rippleDelay(row, column, 4, 4, 300)),
    );
    expect(delays).toEqual([
      [225, 168, 168, 225],
      [168, 75, 75, 168],
      [168, 75, 75, 168],
      [225, 168, 168, 225],
    ]);
  });
});
