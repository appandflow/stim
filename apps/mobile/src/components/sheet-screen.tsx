import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import type { space } from '@/design/tokens';

export interface SheetScreenProps {
  title?: string;
  titleLines?: number;
  /** A string renders as the standard footnote; a node renders as given. */
  subtitle?: ReactNode;
  /** Sits before the title block. */
  leading?: ReactNode;
  /** Sits after the title block. */
  accessory?: ReactNode;
  gap?: keyof typeof space;
  children?: ReactNode;
}

/** The scrolling shell of a sheet: background, standard insets, and the title row. */
export function SheetScreen({
  title,
  titleLines,
  subtitle,
  leading,
  accessory,
  gap = 'xl',
  children,
}: SheetScreenProps) {
  const { theme } = useUnistyles();
  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={styles.container(gap)}>
      {title === undefined ? null : (
        <View style={styles.titleRow}>
          {leading}
          <View style={styles.titles}>
            <Text variant="title" numberOfLines={titleLines} accessibilityRole="header">
              {title}
            </Text>
            {typeof subtitle === 'string' ? (
              <Text variant="footnote" tone="secondary">
                {subtitle}
              </Text>
            ) : (
              subtitle
            )}
          </View>
          {accessory}
        </View>
      )}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: (gap: keyof typeof theme.space) => ({
    padding: theme.space.xxl,
    paddingTop: theme.space.xxxl,
    paddingBottom: theme.space.giant,
    gap: theme.space[gap],
  }),
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg },
  titles: { flex: 1, gap: theme.space.xxs },
}));
