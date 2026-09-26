/** Brand colors match website/src/css/custom.css and apps/desktop Theme.swift. */

export const space = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  xxxl: 24,
  huge: 32,
} as const;

export const radius = {
  small: 4,
  chip: 7,
  control: 10,
  card: 12,
  sheet: 20,
  round: 999,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export type FontWeight = keyof typeof fontWeight;

export interface TextStyleToken {
  fontSize: number;
  lineHeight: number;
  fontWeight: FontWeight;
  /** Points. Zero leaves the platform's default tracking, which iOS varies with the size of the system font. */
  letterSpacing: number;
}

export const text = {
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: 'regular', letterSpacing: 0 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: 'regular', letterSpacing: 0 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: 'regular', letterSpacing: 0 },
  callout: { fontSize: 14, lineHeight: 19, fontWeight: 'regular', letterSpacing: 0 },
  body: { fontSize: 16, lineHeight: 21, fontWeight: 'regular', letterSpacing: 0 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: 'semibold', letterSpacing: 0 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: 'bold', letterSpacing: 0 },
} as const satisfies Record<string, TextStyleToken>;

export type TextVariant = keyof typeof text;

export const fonts = {
  mono: { ios: 'Menlo', android: 'monospace' },
} as const;

export const opacity = {
  subtle: 0.1,
  pressed: 0.12,
  tint: 0.16,
  track: 0.25,
  disabled: 0.4,
  backdrop: 0.9,
} as const;

export const breakpoints = {
  phone: 0,
  tablet: 768,
} as const;

const light = {
  primary: '#5521FF',
  accent: '#7045FF',
  onPrimary: '#FFFFFF',
  background: '#FFFFFF',
  sidebar: '#F6F4FA',
  surface: '#FCFBFF',
  raised: '#F3EFFF',
  border: '#ECE7FA',
  separator: '#ECE7FA',
  grouped: '#F6F4FA',
  groupedRow: '#FFFFFF',
  text: '#121212',
  secondary: '#6B6B6B',
  tertiary: '#96929F',
  success: '#16A34A',
  warning: '#B7791F',
  error: '#DC2626',
  info: '#2F6BFF',
  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.14)',
};

export type ColorToken = keyof typeof light;

const dark: Record<ColorToken, string> = {
  primary: '#B39CFF',
  accent: '#AA90FF',
  onPrimary: '#15121D',
  background: '#15121D',
  sidebar: '#0E0C13',
  surface: '#201B2B',
  raised: '#2A2338',
  border: '#352A48',
  separator: '#352A48',
  grouped: '#0E0C13',
  groupedRow: '#201B2B',
  text: '#F3EFFF',
  secondary: '#B8B0CC',
  tertiary: '#8C84A3',
  success: '#4ADE80',
  warning: '#F5B454',
  error: '#FF6B6B',
  info: '#7AA7FF',
  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.14)',
};

export const colors = { light, dark };

/**
 * Colors drawn over a simulator or emulator frame and the viewer's dark backdrop. They stay the same in light and
 * dark mode because the media behind them is always dark.
 */
export const media = {
  screen: '#0C0A11',
  frame: '#000000',
  text: '#FFFFFF',
  textSecondary: 'rgba(255, 255, 255, 0.8)',
  textTertiary: 'rgba(255, 255, 255, 0.6)',
  fill: 'rgba(255, 255, 255, 0.12)',
  fillSubtle: 'rgba(255, 255, 255, 0.08)',
  bar: '#1C1C1E',
  note: 'rgba(0, 0, 0, 0.85)',
  badge: 'rgba(0, 0, 0, 0.6)',
} as const;
