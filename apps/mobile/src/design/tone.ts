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
