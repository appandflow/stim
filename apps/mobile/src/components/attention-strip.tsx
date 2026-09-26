import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import type { HomeAttentionItem } from '@/lib/attention';

const COLLAPSED = 3;

export function AttentionStrip({
  items,
  onOpen,
}: {
  items: HomeAttentionItem[];
  onOpen: (item: HomeAttentionItem) => void;
}) {
  const { theme } = useUnistyles();
  const [expandedState, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const expanded = expandedState && items.length > COLLAPSED;
  const shown = expanded ? items : items.slice(0, COLLAPSED);
  const more = items.length - shown.length;
  return (
    <View style={styles.card}>
      {shown.map((item, index) => {
        const tone = item.severity === 'error' ? 'error' : 'warning';
        return (
          <Touch
            key={item.key}
            feedback="row"
            onPress={() => onOpen(item)}
            accessibilityLabel={`${item.severity === 'error' ? 'Error' : 'Warning'}: ${item.title} on ${item.macName}, ${item.detail}`}
            style={[styles.row, index > 0 && styles.divider]}
          >
            <View style={styles.dot(tone)} />
            <View style={styles.text}>
              <Text variant="callout" weight="semibold" numberOfLines={1} ellipsizeMode="middle">
                {item.title}
              </Text>
              <Text variant="footnote" tone={tone} numberOfLines={2}>
                {item.detail}
              </Text>
            </View>
            <Icon name="chevron.right" size={13} color={theme.colors.tertiary} />
          </Touch>
        );
      })}
      {more > 0 || expanded ? (
        <Touch feedback="row" onPress={() => setExpanded(!expanded)} style={[styles.row, styles.divider]}>
          <Text variant="footnote" weight="medium" tone="brand">
            {expanded ? 'Show fewer' : `${more} more`}
          </Text>
        </Touch>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginHorizontal: theme.space.xl,
    marginTop: theme.space.xl,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.separator },
  dot: (tone: 'error' | 'warning') => ({
    width: 8,
    height: 8,
    borderRadius: theme.radius.round,
    backgroundColor: theme.colors[tone],
  }),
  text: { flex: 1, gap: 1 },
}));
