import { Text as NativeText, type TextProps as NativeTextProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { fontWeight, type FontWeight, type TextVariant } from '@/design/tokens';
import { toneColor, type Tone } from '@/design/tone';

export type TextTone = Tone;

export type TextProps = NativeTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: FontWeight;
  mono?: boolean;
};

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
