import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Touch, type TouchProps } from '@/components/touch';

export function Card({
  children,
  ring,
  style,
  ...touch
}: { children: ReactNode; ring?: string; style?: StyleProp<ViewStyle> & ViewProps['style'] } & Omit<
  TouchProps,
  'children' | 'style'
>) {
  const cardStyle = [styles.card(ring), style];
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
  card: (ring: string | undefined) => ({
    backgroundColor: theme.colors.surface,
    borderColor: ring ?? theme.colors.border,
    borderWidth: ring ? 2 : 1,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
  }),
}));
