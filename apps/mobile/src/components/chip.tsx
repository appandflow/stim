import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radius, useColors } from '@/theme';

export function Chip({ tint, mono, children }: { tint?: string; mono?: string; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.chip, { backgroundColor: tint ? `${tint}29` : colors.raised }]}>
      <Text style={[styles.text, { color: tint ?? colors.secondary }]} numberOfLines={1}>
        {children}
        {mono ? <Text style={styles.mono}>{mono}</Text> : null}
      </Text>
    </View>
  );
}

export function StatusDot({ color, filled = true }: { color: string; filled?: boolean }) {
  return <View style={[styles.dot, { borderColor: color, backgroundColor: filled ? color : 'transparent' }]} />;
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.chip,
    borderCurve: 'continuous',
  },
  text: { fontSize: 12, fontWeight: '500' },
  mono: { fontVariant: ['tabular-nums'] },
  dot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1 },
});
