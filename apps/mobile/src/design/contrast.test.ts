import { processColor } from 'react-native';

import { withAlpha } from '@/design/color';
import { colorsHighContrast, type ColorToken } from '@/design/tokens';
import { highContrastThemes } from '@/design/theme';
import { toneColor } from '@/design/tone';

type Mode = 'light' | 'dark';

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg: number[], bg: number[], alpha: number) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

const surfaces: ColorToken[] = ['background', 'surface', 'raised', 'selection', 'sidebar'];
const textTokens: ColorToken[] = ['text', 'secondary', 'tertiary', 'primary', 'accent'];
const tones: ColorToken[] = ['success', 'warning', 'error', 'info'];

describe.each<Mode>(['light', 'dark'])('Increase Contrast palette, %s', (mode) => {
  const palette = colorsHighContrast[mode];
  const surface = (name: ColorToken) => channels(palette[name]);

  it('keeps returned brand text at 7:1 on every surface', () => {
    const foreground = channels(toneColor(highContrastThemes[mode], 'brand'));
    for (const name of surfaces) {
      expect(ratio(foreground, surface(name))).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps text and tone colors at 7:1 on every surface and on their own tints', () => {
    for (const token of [...textTokens, ...tones]) {
      for (const name of surfaces) {
        expect(ratio(surface(token), surface(name))).toBeGreaterThanOrEqual(7);
        if (tones.includes(token)) {
          const native = processColor(withAlpha(palette[token], highContrastThemes[mode].opacity.tint));
          expect(typeof native).toBe('number');
          const rgba = native as number;
          const tint = over([(rgba >>> 16) & 255, (rgba >>> 8) & 255, rgba & 255], surface(name), (rgba >>> 24) / 255);
          expect(ratio(surface(token), tint)).toBeGreaterThanOrEqual(7);
        }
      }
    }
  });

  it('keeps border and separator at 3:1 on every surface', () => {
    for (const edge of ['border', 'separator'] as const) {
      for (const name of surfaces) {
        expect(ratio(surface(edge), surface(name))).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
