import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';

import { radius, useColors } from '@/theme';

export function Card({ children, ring, style }: { children: ReactNode; ring?: string; style?: ViewProps['style'] }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: ring ?? colors.border, borderWidth: ring ? 2 : 1 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, borderCurve: 'continuous', overflow: 'hidden' },
});
