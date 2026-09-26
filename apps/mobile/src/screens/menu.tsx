import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { usePathname, useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useAppUpdate } from '@/hooks/app-update';
import { useHomeFilters, type HomeView } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import { useRecents } from '@/hooks/recents';
import { drawerStatus, UPDATE_READY_TEXT, type DrawerMachine } from '@/lib/drawer-status';
import { machineStats } from '@/lib/home';
import { isActive, workspaceTitleAt } from '@/lib/workspaces';

const WORDMARK = require('@/assets/images/wordmark.png');

export function Menu({ onClose }: { onClose: () => void }) {
  const { theme } = useUnistyles();
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
  const statusTone = status.tone === 'critical' ? 'error' : status.tone === 'warn' ? 'warning' : 'secondary';

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + theme.space.lg, paddingBottom: insets.bottom + theme.space.md },
      ]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Image
          source={WORDMARK}
          tintColor={theme.colors.text}
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
            <Text variant="callout" weight="medium" tone="secondary" style={styles.sectionTitle}>
              Recent workspaces
            </Text>
            {recentRows.map((recent) => (
              <Touch
                key={`${recent.macId}\n${recent.path}`}
                feedback="row"
                onPress={() => go({ pathname: '/mac/[id]/workspace', params: { id: recent.macId, path: recent.path } })}
                accessibilityLabel={recent.live ? `${recent.title}, live` : recent.title}
                style={styles.recent}
              >
                <Icon
                  name="arrow.triangle.branch"
                  size={15}
                  color={recent.live ? theme.colors.success : theme.colors.tertiary}
                />
                <Text variant="body" numberOfLines={1} ellipsizeMode="middle" style={styles.grow}>
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
          <View style={styles.badge}>
            <Text variant="body" weight="semibold" style={styles.badgeText}>
              {connections.length}
            </Text>
          </View>
          <View style={styles.footerStatusRow}>
            {status.text === UPDATE_READY_TEXT ? <View style={styles.updateDot} /> : null}
            <Text variant="footnote" tone={statusTone} numberOfLines={1} style={styles.grow}>
              {status.text}
            </Text>
          </View>
        </Touch>
        <IconButton icon="gearshape" accessibilityLabel="Settings" onPress={() => go('/settings')} />
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
  const { theme } = useUnistyles();
  return (
    <Touch
      feedback="row"
      onPress={onPress}
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      style={styles.row(selected)}
    >
      <Icon name={icon} size={20} color={theme.colors.text} />
      <Text variant="headline" weight="medium">
        {title}
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1 },
  content: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.xl },
  wordmark: {
    width: 88,
    height: 42,
    marginLeft: theme.space.lg,
    marginTop: theme.space.md,
    marginBottom: theme.space.xxxl,
  },
  row: (selected: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    backgroundColor: selected ? theme.colors.border : undefined,
  }),
  sectionTitle: { marginTop: theme.space.xxxl, marginBottom: theme.space.sm, marginLeft: theme.space.lg },
  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
  },
  grow: { flex: 1 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.xl,
    paddingTop: theme.space.lg,
  },
  footerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.md,
  },
  badge: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.text,
  },
  badgeText: { color: theme.colors.sidebar },
  footerStatusRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  updateDot: { width: 6, height: 6, borderRadius: theme.radius.round, backgroundColor: theme.colors.primary },
}));
