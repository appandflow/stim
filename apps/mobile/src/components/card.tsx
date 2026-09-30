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
  const cardStyle = [styles.card, style];
  if (touch.onPress) {
    return (
      <Touch feedback="card" {...touch} style={cardStyle}>
        {children}
      </Touch>
    );
  }
  return <View style={cardStyle}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
}));
