import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Touch } from '@/components/touch';
import type { HomeAttentionItem } from '@/lib/attention';
import { radius, useColors } from '@/theme';

const COLLAPSED = 3;

export function AttentionStrip({
  items,
  onOpen,
}: {
  items: HomeAttentionItem[];
  onOpen: (item: HomeAttentionItem) => void;
}) {
  const colors = useColors();
  const [expandedState, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const expanded = expandedState && items.length > COLLAPSED;
  const shown = expanded ? items : items.slice(0, COLLAPSED);
  const more = items.length - shown.length;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {shown.map((item, index) => {
        const tint = item.severity === 'error' ? colors.error : colors.warn;
        return (
          <Touch
            key={item.key}
            feedback="row"
            onPress={() => onOpen(item)}
            accessibilityLabel={`${item.severity === 'error' ? 'Error' : 'Warning'}: ${item.title} on ${item.macName}, ${item.detail}`}
            style={[
              styles.row,
              index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
            ]}
          >
            <View style={[styles.dot, { backgroundColor: tint }]} />
            <View style={styles.text}>
              <Text style={[styles.title, { color: colors.text }]} numberOfLines={1} ellipsizeMode="middle">
                {item.title}
              </Text>
              <Text style={[styles.detail, { color: tint }]} numberOfLines={2}>
                {item.detail}
              </Text>
            </View>
            <Icon name="chevron.right" size={13} color={colors.tertiary} />
          </Touch>
        );
      })}
      {more > 0 || expanded ? (
        <Touch
          feedback="row"
          onPress={() => setExpanded(!expanded)}
          style={[styles.more, { borderTopColor: colors.border }]}
        >
          <Text style={[styles.moreText, { color: colors.primary }]}>{expanded ? 'Show fewer' : `${more} more`}</Text>
        </Touch>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: radius.card,
    borderCurve: 'continuous',
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { flex: 1, gap: 1 },
  title: { fontSize: 14, fontWeight: '600' },
  detail: { fontSize: 13 },
  more: { paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  moreText: { fontSize: 13, fontWeight: '500' },
});
