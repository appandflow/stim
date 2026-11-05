import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Touch, type TouchProps } from '@/components/touch';

export function Card({
  children,
  style,
  ...touch
}: { children: ReactNode; style?: StyleProp<ViewStyle> & ViewProps['style'] } & Omit<
  TouchProps,
  'children' | 'style'
>) {
  if (touch.onPress) {
    return (
      <Touch feedback="card" {...touch} style={[styles.pressableCard, style]}>
        {children}
      </Touch>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

// jpudysz/react-native-unistyles#1317: a plain View that mounts after a theme change renders the previous theme when its
// style key is also passed to a withUnistyles component, which Touch is. Pressable cards therefore get their own key.
// Keep both as inline object literals: building the second from the first made mounted cards miss theme changes.
const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  pressableCard: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
}));
