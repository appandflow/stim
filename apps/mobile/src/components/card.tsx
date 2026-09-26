import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { Touch, type TouchProps } from '@/components/touch';
import { radius, useColors } from '@/theme';

export function Card({
  children,
  ring,
  style,
  ...touch
}: { children: ReactNode; ring?: string; style?: StyleProp<ViewStyle> & ViewProps['style'] } & Omit<
  TouchProps,
  'children' | 'style'
>) {
  const colors = useColors();
  const cardStyle = [
    styles.card,
    { backgroundColor: colors.surface, borderColor: ring ?? colors.border, borderWidth: ring ? 2 : 1 },
    style,
  ];
  if (touch.onPress) {
    return (
      <Touch feedback="card" {...touch} style={cardStyle}>
        {children}
      </Touch>
    );
  }
  return <View style={cardStyle}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, borderCurve: 'continuous', overflow: 'hidden' },
});
