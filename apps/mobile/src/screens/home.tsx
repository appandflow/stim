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
  View,
  type ListViewToken,
} from 'react-native';

import { DeviceGridTile } from '@/components/device-grid-tile';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { MacChip } from '@/components/mac-chip';
import { StimJar } from '@/components/stim-jar';
import { useMenuDrawer } from '@/components/menu-drawer';
import { WorkspaceRow } from '@/components/workspace-row';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import {
  filtersActive,
  filterWorkspaces,
  gridRows,
  mergeWorkspaces,
  projectNames,
  runningDevices,
  type DeviceTileItem,
  type HomeItem,
} from '@/lib/home';
import { isActive } from '@/lib/workspaces';
import { MacList } from '@/screens/mac-list';
import { radius, useColors } from '@/theme';

const MENU_ICON = require('@/assets/icons/menu.png');
const FUNNEL_ICON = require('@/assets/icons/funnel.png');
const PLUS_ICON = require('@/assets/icons/plus.png');
const WORDMARK = require('@/assets/images/wordmark.png');
const VIEWABILITY = { itemVisiblePercentThreshold: 10 };

export function Home() {
  const colors = useColors();
  const router = useRouter();
  const menu = useMenuDrawer();
  const { macs, connections } = useMacs();
  const { filters, update, view } = useHomeFilters();
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [aspects, setAspects] = useState<ReadonlyMap<string, number>>(new Map());
  const onAspect = useCallback(
    (key: string, aspect: number) =>
      setAspects((current) => (current.get(key) === aspect ? current : new Map(current).set(key, aspect))),
    [],
  );
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: ListViewToken[] }) =>
      setVisible(new Set(viewableItems.flatMap((token) => (token.item as DeviceTileItem[]).map((tile) => tile.key)))),
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
  const rows = useMemo(() => gridRows(tiles, aspects), [tiles, aspects]);
  const noFilterSet = useMemo(() => !filtersActive(filters, macIds, projectNames(items)), [filters, macIds, items]);
  const loading =
    macs === null ||
    (items.length === 0 &&
      connections.some((c) => !c.status && !c.missing && (c.state.kind === 'connecting' || c.state.kind === 'open')));

  const header = (
    <>
      <Stack.Screen
        options={{
          headerTitle: () =>
            view === 'workspaces' ? (
              <Image
                source={WORDMARK}
                tintColor={colors.primary}
                style={styles.wordmark}
                contentFit="contain"
                accessibilityLabel="Stim"
              />
            ) : (
              <Text style={[styles.headerTitleText, { color: colors.text }]}>
                {view === 'devices' ? 'Devices' : 'Machines'}
              </Text>
            ),
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={Platform.OS === 'ios' ? 'line.3.horizontal' : MENU_ICON}
          tintColor={colors.text}
          accessibilityLabel="Menu"
          onPress={menu.open}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        {view === 'machines' ? (
          <Stack.Toolbar.Button
            icon={Platform.OS === 'ios' ? 'plus' : PLUS_ICON}
            iconRenderingMode="template"
            tintColor={colors.text}
            accessibilityLabel="Pair a machine"
            onPress={() => router.push('/pair')}
          />
        ) : (
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
        )}
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
    </View>
  );

  if (view === 'machines') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        {header}
        <MacList />
      </View>
    );
  }

  if (view === 'devices') {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        {header}
        <FlatList
          data={rows}
          keyExtractor={(row) => row.map((tile) => tile.key).join('\n\n')}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.list}
          ListHeaderComponent={listHeader}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={VIEWABILITY}
          renderItem={({ item: row }) => (
            <View style={styles.gridRow}>
              {row.map((tile) => (
                <DeviceGridTile
                  key={tile.key}
                  tile={tile}
                  wide={(aspects.get(tile.key) ?? 0) > 1}
                  connection={byMac.get(tile.item.macId)?.connection ?? null}
                  visible={focused && visible.has(tile.key)}
                  onAspect={onAspect}
                  onPress={() => openWorkspace(tile.item, false)}
                />
              ))}
            </View>
          )}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.loading} color={colors.primary} />
            ) : (
              <View style={styles.empty}>
                <StimJar playing={focused} />
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
              <StimJar playing={focused} />
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
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wordmark: { width: 50, height: 24 },
  headerTitleText: { fontSize: 17, fontWeight: '600' },
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
  gridRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  loading: { marginTop: 48 },
  empty: { alignItems: 'center', padding: 32, gap: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyMessage: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  footer: { paddingHorizontal: 20, paddingVertical: 16 },
  footerText: { fontSize: 14 },
  primaryButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.card, marginTop: 8 },
  primaryButtonText: { fontSize: 16, fontWeight: '600' },
});
