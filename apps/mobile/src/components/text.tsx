import { Text as NativeText, type TextProps as NativeTextProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { Theme } from '@/design/theme';
import { fontWeight, type FontWeight, type TextVariant } from '@/design/tokens';

export type TextTone =
  | 'default'
  | 'secondary'
  | 'tertiary'
  | 'brand'
  | 'onBrand'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

export type TextProps = NativeTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: FontWeight;
  mono?: boolean;
};

function toneColor(theme: Theme, tone: TextTone): string {
  switch (tone) {
    case 'default':
      return theme.colors.text;
    case 'brand':
      return theme.colors.primary;
    case 'onBrand':
      return theme.colors.onPrimary;
    default:
      return theme.colors[tone];
  }
}

/**
 * The tone's color is read through `useUnistyles()` rather than the stylesheet: Unistyles does not re-style a `Text`
 * nested in another `Text` on a theme change (jpudysz/react-native-unistyles#1045).
 */
export function Text({ variant = 'callout', tone = 'default', weight, mono, style, ...props }: TextProps) {
  const { theme } = useUnistyles();
  return (
    <NativeText {...props} style={[styles.text(variant, weight, mono), { color: toneColor(theme, tone) }, style]} />
  );
}

const styles = StyleSheet.create((theme) => ({
  text: (variant: TextVariant, weight: FontWeight | undefined, mono: boolean | undefined) => ({
    ...theme.typography[variant],
    ...(weight ? { fontWeight: fontWeight[weight] } : null),
    ...(mono ? { fontFamily: theme.mono } : null),
  }),
}));
