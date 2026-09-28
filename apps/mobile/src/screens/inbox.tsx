import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, Platform, RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/empty-state';
import { Icon, type IconName } from '@/components/icon';
import { SectionList } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useInbox } from '@/hooks/inbox';
import { usePairedMacs } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { shortDuration } from '@/lib/format';
import { byDay, itemData, type InboxFilters, type InboxItem } from '@/lib/inbox';
import { NOTIFY_CATEGORIES, notificationRoute } from '@/lib/notifications';
import type { OversightCategory } from '@/lib/oversight';
import { NOTIFY_CATEGORY_LABELS } from '@/lib/settings-options';

const FUNNEL_ICON = require('@/assets/icons/funnel.png');

/** The same symbols as Stim Desktop's inbox (#1746). */
const CATEGORY_ICONS: Record<OversightCategory, IconName> = {
  started: 'play.circle',
  stuck: 'hourglass',
  looping: 'arrow.triangle.2.circlepath',
  finished: 'checkmark.circle',
  machine: 'exclamationmark.triangle',
  control: 'hand.raised',
};

function categoryColor(theme: Theme, category: OversightCategory): string {
  switch (category) {
    case 'started':
      return theme.colors.info;
    case 'stuck':
    case 'machine':
      return theme.colors.warning;
    case 'looping':
      return theme.colors.error;
    case 'finished':
      return theme.colors.success;
    case 'control':
      return theme.colors.primary;
  }
}

const SUPPRESSED_TEXT = { muted: 'Muted', 'quiet-hours': 'Quiet hours' } as const;

export function Inbox() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const macs = usePairedMacs();
  const [category, setCategory] = useState<OversightCategory | null>(null);
  const [macId, setMacId] = useState<string | null>(null);
  const filters = useMemo<InboxFilters>(
    () => ({ categories: category ? [category] : null, macIds: macId ? [macId] : null }),
    [category, macId],
  );
  const inbox = useInbox(filters);
  const now = useNow(30_000);
  const sections = useMemo(() => byDay(inbox.items, now), [inbox.items, now]);
  const macIds = useMemo(() => (macs ?? []).map((mac) => mac.id), [macs]);
  const showMacs = (macs?.length ?? 0) > 1;

  const open = (item: InboxItem) => {
    inbox.markRead(item);
    const route = notificationRoute(itemData(item), macIds);
    if ('url' in route) void Linking.openURL(route.url);
    else if (route.pathname === '/') router.navigate('/');
    else router.push(route);
  };

  return (
    <View style={styles.screen}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={FUNNEL_ICON}
          iconRenderingMode="template"
          tintColor={theme.colors.text}
          accessibilityLabel="Filter and mark read"
        >
          <Stack.Toolbar.MenuAction icon="checkmark.circle" disabled={inbox.unread === 0} onPress={inbox.markAllRead}>
            Mark all read
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu inline title="Category">
            <Stack.Toolbar.MenuAction isOn={category === null} onPress={() => setCategory(null)}>
              All categories
            </Stack.Toolbar.MenuAction>
            {NOTIFY_CATEGORIES.map((value) => (
              <Stack.Toolbar.MenuAction key={value} isOn={category === value} onPress={() => setCategory(value)}>
                {NOTIFY_CATEGORY_LABELS[value]}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          {showMacs ? (
            <Stack.Toolbar.Menu inline title="Machine">
              <Stack.Toolbar.MenuAction isOn={macId === null} onPress={() => setMacId(null)}>
                All machines
              </Stack.Toolbar.MenuAction>
              {(macs ?? []).map((mac) => (
                <Stack.Toolbar.MenuAction key={mac.id} isOn={macId === mac.id} onPress={() => setMacId(mac.id)}>
                  {mac.name}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          ) : null}
          {category || macId ? <Stack.Toolbar.Badge style={{ backgroundColor: theme.colors.primary }} /> : null}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <SectionList
        sections={sections}
        keyExtractor={(item) => `${item.macId}\n${item.seq}`}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={sections.length === 0 ? styles.emptyList : styles.list}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl refreshing={inbox.refreshing} onRefresh={inbox.refresh} tintColor={theme.colors.tertiary} />
        }
        renderSectionHeader={({ section }) => (
          <Text variant="body" weight="medium" tone="tertiary" style={styles.sectionHeader}>
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => <InboxRow item={item} now={now} onPress={open} />}
        ListEmptyComponent={
          <EmptyState
            title={category || macId ? 'Nothing matches the filters' : 'No notifications'}
            message={
              inbox.supported
                ? 'What your Macs notify about, such as an agent that looks stuck or work that finished, is listed here for 7 days.'
                : 'Update stim-server on your Macs to keep a history of their notifications.'
            }
          />
        }
      />
    </View>
  );
}

function InboxRow({ item, now, onPress }: { item: InboxItem; now: number; onPress: (item: InboxItem) => void }) {
  const { theme } = useUnistyles();
  const label = NOTIFY_CATEGORY_LABELS[item.category];
  const ago = shortDuration(Math.max(0, now - Date.parse(item.at)));
  const machine = item.target.kind === 'machine';
  const detail = [label, machine ? null : item.macName].filter(Boolean).join(' \u00B7 ');
  return (
    <Touch
      feedback="row"
      onPress={() => onPress(item)}
      accessibilityLabel={`${item.read ? '' : 'Unread, '}${item.title}, ${item.body}, ${detail}, ${ago} ago`}
      style={styles.row}
    >
      <View style={styles.iconWell(categoryColor(theme, item.category))}>
        <Icon name={CATEGORY_ICONS[item.category]} size={18} color={categoryColor(theme, item.category)} />
      </View>
      <View style={styles.grow}>
        <View style={styles.titleLine}>
          <Text
            variant="callout"
            weight={item.read ? 'medium' : 'semibold'}
            numberOfLines={1}
            ellipsizeMode="middle"
            style={styles.grow}
          >
            {item.title}
          </Text>
          <Text variant="caption" tone="tertiary">
            {ago}
          </Text>
          {item.read ? null : <View style={styles.unreadDot} />}
        </View>
        <Text variant="callout" tone={item.read ? 'secondary' : 'default'} numberOfLines={3}>
          {item.body}
        </Text>
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {detail}
          {item.suppressed ? ` \u00B7 ${SUPPRESSED_TEXT[item.suppressed]}` : ''}
        </Text>
      </View>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  list: { paddingBottom: theme.space.huge },
  emptyList: { flexGrow: 1 },
  sectionHeader: {
    paddingHorizontal: theme.space.xxl,
    paddingTop: theme.space.xxl,
    paddingBottom: theme.space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.xxl,
    paddingVertical: theme.space.lg,
  },
  iconWell: (color: string) => ({
    width: 32,
    height: 32,
    borderRadius: theme.radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(color, theme.opacity.tint),
    marginTop: Platform.OS === 'ios' ? 1 : 2,
  }),
  grow: { flex: 1, gap: theme.space.xxs },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  unreadDot: { width: 8, height: 8, borderRadius: theme.radius.round, backgroundColor: theme.colors.primary },
}));
