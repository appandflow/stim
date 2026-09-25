import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useColors } from '@/theme';

export function EmptyState({ title, message, children }: { title: string; message?: string; children?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {message ? <Text style={[styles.message, { color: colors.secondary }]}>{message}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  title: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  message: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
