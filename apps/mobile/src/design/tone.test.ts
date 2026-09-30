import { colors } from '@/design/tokens';
import { toneColor } from '@/design/tone';

describe('toneColor', () => {
  it.each(['light', 'dark'] as const)('reads the tone from the %s palette', (scheme) => {
    const palette = colors[scheme];
    const theme = { colors: palette } as Parameters<typeof toneColor>[0];
    expect(toneColor(theme, 'default')).toBe(palette.text);
    expect(toneColor(theme, 'onBrand')).toBe(palette.onPrimary);
    expect(toneColor(theme, 'secondary')).toBe(palette.secondary);
    expect(toneColor(theme, 'error')).toBe(palette.error);
  });

  it('draws brand as primary, which stays legible on the dark background where the brand token does not', () => {
    const theme = { colors: colors.dark } as Parameters<typeof toneColor>[0];
    expect(toneColor(theme, 'brand')).toBe('#B39CFF');
  });
});
