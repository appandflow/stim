import { Image } from 'expo-image';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type ViewToken,
} from 'react-native';

import { DeviceGridTile } from '@/components/device-grid-tile';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { MacChip } from '@/components/mac-chip';
import { Toggle } from '@/components/toggle';
import { WorkspaceRow } from '@/components/workspace-row';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import {
  filtersActive,
  filterWorkspaces,
  mergeWorkspaces,
  projectNames,
  runningDevices,
  type DeviceTileItem,
  type HomeItem,
} from '@/lib/home';
import { isActive } from '@/lib/workspaces';
import { radius, useColors } from '@/theme';

const MENU_ICON = require('@/assets/icons/menu.png');
const FUNNEL_ICON = require('@/assets/icons/funnel.png');
const ILLUSTRATION_LIGHT = require('@/assets/images/empty-illustration.png');
const ILLUSTRATION_DARK = require('@/assets/images/empty-illustration-dark.png');
const VIEWABILITY = { itemVisiblePercentThreshold: 10 };

export function Home() {
  const colors = useColors();
  const illustration = useColorScheme() === 'dark' ? ILLUSTRATION_DARK : ILLUSTRATION_LIGHT;
  const router = useRouter();
  const { macs, connections } = useMacs();
  const { filters, update, view, setView } = useHomeFilters();
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<DeviceTileItem>[] }) =>
      setVisible(new Set(viewableItems.map((token) => token.key))),
    [],
  );

  const macIds = useMemo(() => connections.map((c) => c.mac.id), [connections]);
  const byMac = useMemo(() => new Map(connections.map((c) => [c.mac.id, c])), [connections]);
  const items = useMemo(
    () => mergeWorkspaces(connections.map((c) => ({ id: c.mac.id, name: c.mac.name, status: c.status }))),
    [connections],
  );
  const { shown, hiddenByActivity } = useMemo(() => filterWorkspaces(items, filters, macIds), [items, filters, macIds]);
  const sections = useMemo(() => {
    const live = shown.filter((item) => isActive(item.env));
    const idle = shown.filter((item) => !isActive(item.env));
    return [
      { title: 'Live', data: live },
      { title: 'Idle', data: idle },
    ].filter((s) => s.data.length > 0);
  }, [shown]);
  const tiles = useMemo(() => runningDevices(items, filters, macIds), [items, filters, macIds]);
  const noFilterSet = useMemo(() => !filtersActive(filters, macIds, projectNames(items)), [filters, macIds, items]);
  const loading =
    macs === null ||
    (items.length === 0 &&
      connections.some((c) => !c.status && !c.missing && (c.state.kind === 'connecting' || c.state.kind === 'open')));

  const header = (
    <>
      <Stack.Screen options={{ title: 'Stim' }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={Platform.OS === 'ios' ? 'line.3.horizontal' : MENU_ICON}
          tintColor={colors.text}
          accessibilityLabel="Menu"
          onPress={() => router.push('/menu')}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={FUNNEL_ICON}
          iconRenderingMode="template"
          tintColor={colors.text}
          accessibilityLabel="Filter"
          onPress={() => router.push('/filters')}
        >
          {filtersActive(filters, macIds, projectNames(items)) ? (
            <Stack.Toolbar.Badge style={{ backgroundColor: colors.primary }} />
          ) : null}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
    </>
  );

  if (macs?.length === 0) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        {header}
        <EmptyState
          title="No machine paired"
          message="In Stim Desktop, open Pair a phone and scan its QR code. This phone and the machine both need Tailscale."
        >
          <Pressable
            onPress={() => router.push('/pair')}
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            accessibilityRole="button"
          >
            <Text style={[styles.primaryButtonText, { color: colors.onPrimary }]}>Pair a machine</Text>
          </Pressable>
        </EmptyState>
      </View>
    );
  }

  const openWorkspace = (item: HomeItem, errors: boolean) =>
    router.push({
      pathname: errors ? '/mac/[id]/logs' : '/mac/[id]/workspace',
      params: { id: item.macId, path: item.env.path, ...(errors ? { errors: '1' } : {}) },
    });

  const listHeader = (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.tertiary }]}>Machines</Text>
        <Pressable
          onPress={() => router.push('/pair')}
          accessibilityRole="button"
          accessibilityLabel="Pair a machine"
          hitSlop={10}
        >
          <Icon name="plus" size={22} color={colors.text} />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {connections.map((c) => (
          <MacChip
            key={c.mac.id}
            mac={c}
            onPress={() => router.push({ pathname: '/mac/[id]', params: { id: c.mac.id } })}
          />
        ))}
      </ScrollView>
      <View style={styles.views}>
        <Toggle colors={colors} label="Workspaces" on={view === 'workspaces'} onPress={() => setView('workspaces')} />
        <Toggle colors={colors} label="Devices" on={view === 'devices'} onPress={() => setView('devices')} />
      </View>
    </View>
  );

  if (view === 'devices') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        {header}
        <FlatList
          data={tiles}
          keyExtractor={(tile) => tile.key}
          numColumns={2}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.list}
          columnWrapperStyle={styles.gridRow}
          ListHeaderComponent={listHeader}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={VIEWABILITY}
          renderItem={({ item: tile }) => (
            <DeviceGridTile
              tile={tile}
              connection={byMac.get(tile.item.macId)?.connection ?? null}
              visible={focused && visible.has(tile.key)}
              onPress={() => openWorkspace(tile.item, false)}
            />
          )}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.loading} color={colors.primary} />
            ) : (
              <View style={styles.empty}>
                <Image source={illustration} style={styles.illustration} contentFit="contain" />
                <Text style={[styles.emptyTitle, { color: colors.text }]}>No device running</Text>
                <Text style={[styles.emptyMessage, { color: colors.secondary }]}>
                  Simulators and emulators appear here while they run, on every paired machine the filters keep.
                </Text>
              </View>
            )
          }
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {header}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={listHeader}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.tertiary }]}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const mac = byMac.get(item.macId);
          return (
            <WorkspaceRow
              item={item}
              macOnline={mac?.state.kind === 'open'}
              onPress={() => openWorkspace(item, false)}
              onErrors={() => openWorkspace(item, true)}
            />
          );
        }}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loading} color={colors.primary} />
          ) : (
            <View style={styles.empty}>
              <Image source={illustration} style={styles.illustration} contentFit="contain" />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                {items.length
                  ? noFilterSet
                    ? 'No live workspaces'
                    : 'Nothing matches the filters'
                  : connections.some((c) => c.state.kind === 'open')
                    ? 'Nothing running'
                    : 'No machine connected'}
              </Text>
              <Text style={[styles.emptyMessage, { color: colors.secondary }]}>
                {items.length
                  ? noFilterSet
                    ? 'Start one with `stim ios` or `stim android` in a worktree.'
                    : 'Change the filters to see more workspaces.'
                  : !connections.some((c) => c.state.kind === 'open')
                    ? 'The chips above show why each machine is offline.'
                    : 'Workspaces appear here when an agent runs stim start, stim ios or stim android on a paired machine.'}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          filters.activity === 'live' && hiddenByActivity > 0 ? (
            <Pressable onPress={() => update({ activity: 'all' })} accessibilityRole="button" style={styles.footer}>
              <Text style={[styles.footerText, { color: colors.secondary }]}>
                {`${hiddenByActivity} idle ${hiddenByActivity === 1 ? 'workspace' : 'workspaces'} hidden. `}
                <Text style={{ color: colors.primary }}>Show all</Text>
              </Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingBottom: 32 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 15, fontWeight: '500' },
  chips: { gap: 10, paddingHorizontal: 20, paddingBottom: 4 },
  views: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingTop: 16 },
  gridRow: { gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  loading: { marginTop: 48 },
  empty: { alignItems: 'center', padding: 32, gap: 8 },
  illustration: { width: 160, height: 160, marginBottom: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyMessage: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  footer: { paddingHorizontal: 20, paddingVertical: 16 },
  footerText: { fontSize: 14 },
  primaryButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.card, marginTop: 8 },
  primaryButtonText: { fontSize: 16, fontWeight: '600' },
});
