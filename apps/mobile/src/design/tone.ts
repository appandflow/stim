import type { Theme } from '@/design/theme';

export type Tone =
  | 'default'
  | 'secondary'
  | 'tertiary'
  | 'brand'
  | 'onBrand'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

/**
 * `brand` draws as `primary`, not as the `brand` token: `primary` is the lighter purple in dark mode, where `brand`
 * has a 2.7:1 contrast ratio against the background and is too dim for text and tints.
 */
export function toneColor(theme: Theme, tone: Tone): string {
  const { colors } = theme;
  switch (tone) {
    case 'default':
      return colors.text;
    case 'brand':
      return colors.primary;
    case 'onBrand':
      return colors.onPrimary;
    default:
      return colors[tone];
  }
}
