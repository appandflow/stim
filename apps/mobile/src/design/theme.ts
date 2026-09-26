import { Platform, type TextStyle } from 'react-native';

import {
  colors,
  fonts,
  fontWeight,
  media,
  opacity,
  radius,
  space,
  text,
  type ColorToken,
  type TextVariant,
} from '@/design/tokens';

const typography = Object.fromEntries(
  Object.entries(text).map(([variant, style]) => [
    variant,
    {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: fontWeight[style.fontWeight],
      ...(style.letterSpacing ? { letterSpacing: style.letterSpacing } : null),
    },
  ]),
) as Record<TextVariant, Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'>>;

function buildTheme(palette: Record<ColorToken, string>) {
  return {
    colors: palette,
    media,
    space,
    radius,
    opacity,
    typography,
    mono: Platform.select({ ios: fonts.mono.ios, default: fonts.mono.android }),
  };
}

export const themes = {
  light: buildTheme(colors.light),
  dark: buildTheme(colors.dark),
};

export type Theme = typeof themes.light;
