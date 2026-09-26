import { withAlpha } from '@/design/color';

describe('withAlpha', () => {
  it('splits #RRGGBB into its channels', () => {
    expect(withAlpha('#5521FF', 0.16)).toBe('rgba(85, 33, 255, 0.16)');
    expect(withAlpha('#0C0A11', 0.9)).toBe('rgba(12, 10, 17, 0.9)');
  });
});
