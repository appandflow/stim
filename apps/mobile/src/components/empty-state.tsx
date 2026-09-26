import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';

export function EmptyState({ title, message, children }: { title: string; message?: string; children?: ReactNode }) {
  return (
    <View style={styles.container}>
      <Text variant="headline" style={styles.centered}>
        {title}
      </Text>
      {message ? (
        <Text variant="callout" tone="secondary" style={styles.centered}>
          {message}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.huge,
    gap: theme.space.md,
  },
  centered: { textAlign: 'center' },
}));
