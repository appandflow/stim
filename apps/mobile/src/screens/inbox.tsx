import { t } from '@lingui/core/macro';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, Platform, RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/empty-state';
import { Icon, type IconName } from '@/components/icon';
import { SectionList } from '@/components/lists';
import { useMenuDrawer } from '@/components/menu-drawer';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useInbox } from '@/hooks/inbox';
import { usePairedMacs } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { formatDuration } from '@/intl/format';
import { byDay, itemData, type InboxFilters, type InboxItem } from '@/lib/inbox';
import { NOTIFY_CATEGORIES, notificationRoute } from '@/lib/notifications';
import type { OversightCategory } from '@stim-cli/core/oversight';
import { notificationSuppressionLabel, notifyCategoryLabel } from '@/lib/settings-options';

const MENU_ICON = require('@/assets/icons/menu.png');
const SLIDERS_ICON = require('@/assets/icons/sliders.png');

/** The same symbols as Stim Desktop's inbox (#1746). */
const CATEGORY_ICONS: Partial<Record<string, IconName>> = {
  started: 'play.circle',
  stuck: 'hourglass',
  looping: 'arrow.triangle.2.circlepath',
  finished: 'checkmark.circle',
  machine: 'exclamationmark.triangle',
  control: 'hand.raised',
  attention: 'exclamationmark.bubble',
};

function categoryColor(theme: Theme, category: string): string {
  switch (category) {
    case 'started':
      return theme.colors.info;
    case 'stuck':
    case 'machine':
    case 'attention':
      return theme.colors.warning;
    case 'looping':
      return theme.colors.error;
    case 'finished':
      return theme.colors.success;
    case 'control':
      return theme.colors.primary;
    default:
      return theme.colors.tertiary;
  }
}

export function Inbox() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const menu = useMenuDrawer();
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
    else if (route.pathname === '/') router.replace('/');
    else router.push(route);
  };

  return (
    <View style={styles.screen}>
      {menu.permanent ? null : (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon={Platform.OS === 'ios' ? 'line.3.horizontal' : MENU_ICON}
            tintColor={theme.colors.text}
            accessibilityLabel={t`Menu`}
            onPress={menu.open}
          />
        </Stack.Toolbar>
      )}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={Platform.OS === 'ios' ? 'slider.vertical.3' : SLIDERS_ICON}
          iconRenderingMode="template"
          tintColor={theme.colors.text}
          accessibilityLabel={t`Filter and mark read`}
        >
          <Stack.Toolbar.MenuAction icon="checkmark.circle" disabled={inbox.unread === 0} onPress={inbox.markAllRead}>
            {t`Mark all read`}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu inline title={t`Category`}>
            <Stack.Toolbar.MenuAction isOn={category === null} onPress={() => setCategory(null)}>
              {t`All categories`}
            </Stack.Toolbar.MenuAction>
            {NOTIFY_CATEGORIES.map((value) => (
              <Stack.Toolbar.MenuAction key={value} isOn={category === value} onPress={() => setCategory(value)}>
                {notifyCategoryLabel(value)}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          {showMacs ? (
            <Stack.Toolbar.Menu inline title={t`Machine`}>
              <Stack.Toolbar.MenuAction isOn={macId === null} onPress={() => setMacId(null)}>
                {t`All machines`}
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
          <Text variant="body" weight="medium" tone="tertiary" accessibilityRole="header" style={styles.sectionHeader}>
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => <InboxRow item={item} now={now} onPress={open} />}
        ListEmptyComponent={
          <EmptyState
            title={category || macId ? t`Nothing matches the filters` : t`No notifications`}
            message={
              inbox.supported
                ? t`What your Macs notify about, such as an agent that looks stuck or work that finished, is listed here for 7 days.`
                : t`Update stim-server on your Macs to keep a history of their notifications.`
            }
          />
        }
      />
    </View>
  );
}

function InboxRow({ item, now, onPress }: { item: InboxItem; now: number; onPress: (item: InboxItem) => void }) {
  const { theme } = useUnistyles();
  const label = notifyCategoryLabel(item.category);
  const ago = formatDuration(Math.max(0, now - Date.parse(item.at)), { coarse: true });
  const machine = item.target.kind === 'machine';
  const detail = [label, machine ? null : item.macName].filter(Boolean).join(' \u00B7 ');
  const { title, body } = item;
  return (
    <Touch
      feedback="row"
      onPress={() => onPress(item)}
      accessibilityLabel={
        item.read ? t`${title}, ${body}, ${detail}, ${ago} ago` : t`Unread, ${title}, ${body}, ${detail}, ${ago} ago`
      }
      style={styles.row}
    >
      <View style={styles.iconWell(categoryColor(theme, item.category))}>
        <Icon
          name={Object.hasOwn(CATEGORY_ICONS, item.category) ? CATEGORY_ICONS[item.category]! : 'bell'}
          size={18}
          color={categoryColor(theme, item.category)}
        />
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
          {item.suppressed ? ` \u00B7 ${notificationSuppressionLabel(item.suppressed)}` : ''}
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
