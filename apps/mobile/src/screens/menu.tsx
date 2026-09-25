import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { usePathname, useRouter, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { useHomeFilters, type HomeView } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import { useRecents } from '@/hooks/recents';
import { isActive, workspaceNames } from '@/lib/workspaces';
import { useColors } from '@/theme';

const WORDMARK = require('@/assets/images/wordmark.png');

export function Menu({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { connections } = useMacs();
  const { view, setView } = useHomeFilters();
  const { recents } = useRecents();
  const go = (href: Href) => {
    onClose();
    router.push(href);
  };
  const show = (next: HomeView) => {
    setView(next);
    onClose();
  };
  const recentRows = recents.flatMap((recent) => {
    const connection = connections.find((c) => c.mac.id === recent.macId);
    if (!connection) return [];
    const env = connection.status?.environments.find((e) => e.path === recent.path);
    return [{ ...recent, title: workspaceNames(recent.path).title, live: env ? isActive(env) : false }];
  });

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 8 }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Image
          source={WORDMARK}
          tintColor={colors.text}
          style={styles.wordmark}
          contentFit="contain"
          accessibilityLabel="Stim"
        />
        <NavRow
          icon="rectangle.stack"
          title="Workspaces"
          selected={pathname === '/' && view === 'workspaces'}
          onPress={() => show('workspaces')}
        />
        <NavRow
          icon="square.grid.2x2"
          title="Devices"
          selected={pathname === '/' && view === 'devices'}
          onPress={() => show('devices')}
        />
        <NavRow icon="laptopcomputer" title="Machines" selected={pathname === '/macs'} onPress={() => go('/macs')} />
        <NavRow icon="plus" title="Pair a machine" selected={false} onPress={() => go('/pair')} />
        {recentRows.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.secondary }]}>Recent workspaces</Text>
            {recentRows.map((recent) => (
              <Pressable
                key={`${recent.macId}\n${recent.path}`}
                onPress={() => go({ pathname: '/mac/[id]/workspace', params: { id: recent.macId, path: recent.path } })}
                accessibilityRole="button"
                accessibilityLabel={recent.live ? `${recent.title}, live` : recent.title}
                style={({ pressed }) => [styles.recent, pressed && { backgroundColor: colors.border }]}
              >
                <Icon name="arrow.triangle.branch" size={15} color={recent.live ? colors.live : colors.tertiary} />
                <Text numberOfLines={1} style={[styles.recentTitle, { color: colors.text }]}>
                  {recent.title}
                </Text>
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>
      <Pressable
        onPress={() => go('/about')}
        accessibilityRole="button"
        accessibilityLabel="About"
        style={({ pressed }) => [styles.footer, pressed && { opacity: 0.6 }]}
      >
        <View style={[styles.badge, { backgroundColor: colors.text }]}>
          <Text style={[styles.badgeText, { color: colors.sidebar }]}>{connections.length}</Text>
        </View>
        <View>
          <Text style={[styles.footerTitle, { color: colors.text }]}>
            {connections.length === 1 ? '1 machine' : `${connections.length} machines`}
          </Text>
          <Text style={[styles.footerDetail, { color: colors.secondary }]}>
            {`Stim for phones ${Constants.expoConfig?.version ?? ''}`}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function NavRow({
  icon,
  title,
  selected,
  onPress,
}: {
  icon: IconName;
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.row, (selected || pressed) && { backgroundColor: colors.border }]}
    >
      <Icon name={icon} size={20} color={colors.text} />
      <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 12, paddingBottom: 16 },
  wordmark: { width: 88, height: 42, marginLeft: 12, marginTop: 8, marginBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 12,
    borderCurve: 'continuous',
  },
  rowTitle: { fontSize: 17, fontWeight: '500' },
  sectionTitle: { fontSize: 14, fontWeight: '500', marginTop: 28, marginBottom: 6, marginLeft: 12 },
  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    borderCurve: 'continuous',
  },
  recentTitle: { flex: 1, fontSize: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 24, paddingTop: 12 },
  badge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 16, fontWeight: '600' },
  footerTitle: { fontSize: 16, fontWeight: '500' },
  footerDetail: { fontSize: 13 },
});
