import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { usePathname, useRouter, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { ScrollView } from '@/components/lists';
import { Touch } from '@/components/touch';
import { useAppUpdate } from '@/hooks/app-update';
import { useHomeFilters, type HomeView } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import { useRecents } from '@/hooks/recents';
import { drawerStatus, UPDATE_READY_TEXT, type DrawerMachine } from '@/lib/drawer-status';
import { machineStats } from '@/lib/home';
import { isActive, workspaceTitleAt } from '@/lib/workspaces';
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
  const update = useAppUpdate();
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
    return [{ ...recent, title: workspaceTitleAt(recent.path, connection.status), live: env ? isActive(env) : false }];
  });
  const machines: DrawerMachine[] = connections.map((c) => ({
    id: c.mac.id,
    name: c.mac.name,
    state: c.state,
    missing: c.missing,
    diskTone: machineStats(c.usage).find((s) => s.kind === 'disk')?.tone ?? 'normal',
  }));
  const versionText = `Stim ${Constants.expoConfig?.version ?? ''}${
    Constants.nativeBuildVersion ? ` (${Constants.nativeBuildVersion})` : ''
  }`;
  const status = drawerStatus(machines, update.ready, versionText);
  const statusColor =
    status.tone === 'critical' ? colors.error : status.tone === 'warn' ? colors.warn : colors.secondary;

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
        <NavRow
          icon="laptopcomputer"
          title="Machines"
          selected={pathname === '/' && view === 'machines'}
          onPress={() => show('machines')}
        />
        <NavRow icon="plus" title="Pair a machine" selected={false} onPress={() => go('/pair')} />
        {recentRows.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.secondary }]}>Recent workspaces</Text>
            {recentRows.map((recent) => (
              <Touch
                key={`${recent.macId}\n${recent.path}`}
                feedback="row"
                onPress={() => go({ pathname: '/mac/[id]/workspace', params: { id: recent.macId, path: recent.path } })}
                accessibilityLabel={recent.live ? `${recent.title}, live` : recent.title}
                style={styles.recent}
              >
                <Icon name="arrow.triangle.branch" size={15} color={recent.live ? colors.live : colors.tertiary} />
                <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.recentTitle, { color: colors.text }]}>
                  {recent.title}
                </Text>
              </Touch>
            ))}
          </>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        <Touch
          onPress={() => go(status.macId ? { pathname: '/mac/[id]', params: { id: status.macId } } : '/about')}
          accessibilityLabel={
            connections.length === 1 ? `1 machine, ${status.text}` : `${connections.length} machines, ${status.text}`
          }
          style={styles.footerLeft}
        >
          <View style={[styles.badge, { backgroundColor: colors.text }]}>
            <Text style={[styles.badgeText, { color: colors.sidebar }]}>{connections.length}</Text>
          </View>
          <View style={styles.footerStatusRow}>
            {status.text === UPDATE_READY_TEXT ? (
              <View style={[styles.updateDot, { backgroundColor: colors.primary }]} />
            ) : null}
            <Text numberOfLines={1} style={[styles.footerDetail, { color: statusColor }]}>
              {status.text}
            </Text>
          </View>
        </Touch>
        <Touch
          feedback="row"
          onPress={() => go('/settings')}
          accessibilityLabel="Settings"
          hitSlop={8}
          style={styles.gearButton}
        >
          <Icon name="gearshape" size={20} color={colors.secondary} />
        </Touch>
      </View>
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
    <Touch
      feedback="row"
      onPress={onPress}
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      style={[styles.row, selected && { backgroundColor: colors.border }]}
    >
      <Icon name={icon} size={20} color={colors.text} />
      <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
    </Touch>
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
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  footerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8 },
  badge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 15, fontWeight: '600' },
  footerStatusRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  footerDetail: { flex: 1, fontSize: 13 },
  updateDot: { width: 6, height: 6, borderRadius: 3 },
  gearButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
