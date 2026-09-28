import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { usePathname, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Modal, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useAppUpdate } from '@/hooks/app-update';
import { useHomeFilters, type HomeView } from '@/hooks/home-filters';
import { useInbox } from '@/hooks/inbox';
import { useMacs } from '@/hooks/mac-connection';
import { useRecents } from '@/hooks/recents';
import { drawerStatus, UPDATE_READY_TEXT, type DrawerMachine } from '@/lib/drawer-status';
import { machineStats } from '@/lib/home';
import { isShownLive, workspaceTitleAt } from '@/lib/workspaces';
import { About } from '@/screens/about';

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
  const inbox = useInbox();
  const [aboutOpen, setAboutOpen] = useState(false);
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
    return [
      { ...recent, title: workspaceTitleAt(recent.path, connection.status), live: env ? isShownLive(env) : false },
    ];
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
        {inbox.supported ? (
          <NavRow
            icon="bell"
            title="Notifications"
            count={inbox.unread}
            selected={pathname === '/inbox'}
            onPress={() => go('/inbox')}
          />
        ) : null}
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
          onPress={() =>
            status.macId
              ? go({ pathname: '/mac/[id]', params: { id: status.macId } })
              : Platform.OS === 'android'
                ? setAboutOpen(true)
                : router.push('/about')
          }
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
      {/* react-native-screens draws an Android formSheet inside the stack, which sits in the drawer's scene card. */}
      {Platform.OS === 'android' ? (
        <Modal
          visible={aboutOpen}
          transparent
          animationType="fade"
          statusBarTranslucent
          navigationBarTranslucent
          onRequestClose={() => setAboutOpen(false)}
        >
          <Pressable
            style={styles.scrim}
            onPress={() => setAboutOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close About"
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
            <About />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function NavRow({
  icon,
  title,
  count = 0,
  selected,
  onPress,
}: {
  icon: IconName;
  title: string;
  /** Shown as a pill, and read out as unread, when above zero. */
  count?: number;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Touch
      feedback="row"
      onPress={onPress}
      accessibilityLabel={count > 0 ? `${title}, ${count} unread` : title}
      accessibilityState={{ selected }}
      style={styles.row(selected)}
    >
      <Icon name={icon} size={20} color={theme.colors.text} />
      <Text variant="headline" weight="medium" style={styles.grow}>
        {title}
      </Text>
      {count > 0 ? (
        <View style={styles.count}>
          <Text variant="caption" weight="semibold" style={styles.countText}>
            {count > 99 ? '99+' : count}
          </Text>
        </View>
      ) : null}
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
  scrim: { flex: 1, backgroundColor: theme.colors.scrim },
  sheet: {
    height: '50%',
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    overflow: 'hidden',
    backgroundColor: theme.colors.background,
  },
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
  updateDot: { width: 6, height: 6, borderRadius: theme.radius.round, backgroundColor: theme.colors.primary },
}));
