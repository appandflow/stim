import { t } from '@lingui/core/macro';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Collapsible } from '@/components/collapsible';
import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import type { HomeAttentionItem } from '@/lib/attention';

const COLLAPSED = 3;

export function AttentionStrip({
  items,
  onOpen,
  notifications,
}: {
  items: HomeAttentionItem[];
  onOpen: (item: HomeAttentionItem) => void;
  /** The notification inbox, which keeps what the strip shows and what came before; absent where there is none. */
  notifications?: { unread: number; onOpen: () => void };
}) {
  const { theme } = useUnistyles();
  const [expandedState, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const unread = notifications?.unread ?? 0;
  const expanded = expandedState && items.length > COLLAPSED;
  const more = items.length - COLLAPSED;
  const renderItem = (item: HomeAttentionItem, index: number) => {
    const tone = item.severity === 'error' ? 'error' : 'warning';
    const { title, macName, detail } = item;
    const label =
      item.severity === 'error'
        ? t`Error: ${title} on ${macName}, ${detail}`
        : t`Warning: ${title} on ${macName}, ${detail}`;
    return (
      <Touch
        key={item.key}
        feedback="row"
        onPress={() => onOpen(item)}
        accessibilityLabel={label}
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
  };
  return (
    <View style={styles.card}>
      {items.slice(0, COLLAPSED).map(renderItem)}
      {more > 0 ? (
        <Collapsible open={expanded}>
          {items.slice(COLLAPSED).map((item, index) => renderItem(item, COLLAPSED + index))}
        </Collapsible>
      ) : null}
      {more > 0 ? (
        <Touch feedback="row" onPress={() => setExpanded(!expanded)} style={[styles.row, styles.divider]}>
          <Text variant="footnote" weight="medium" tone="brand">
            {expanded ? t`Show fewer` : t`${more} more`}
          </Text>
        </Touch>
      ) : null}
      {notifications ? (
        <Touch
          feedback="row"
          onPress={notifications.onOpen}
          accessibilityLabel={unread > 0 ? t`Notifications, ${unread} unread` : t`Notifications`}
          style={[styles.row, styles.divider]}
        >
          <Text variant="callout" weight="semibold" style={styles.text}>
            {t`Notifications`}
          </Text>
          {unread > 0 ? (
            <View style={styles.count}>
              <Text variant="caption" weight="semibold" style={styles.countText}>
                {unread > 99 ? '99+' : unread}
              </Text>
            </View>
          ) : null}
          <Icon name="chevron.right" size={13} color={theme.colors.tertiary} />
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
  count: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: theme.space.sm,
    borderRadius: theme.radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
  },
  countText: { color: theme.colors.onPrimary, fontVariant: ['tabular-nums'] },
}));
