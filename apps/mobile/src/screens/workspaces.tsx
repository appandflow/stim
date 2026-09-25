import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { ConnectionBanner } from '@/components/connection-banner';
import { EmptyState } from '@/components/empty-state';
import { WorkspaceCard } from '@/components/workspace-card';
import { useMacConnection, useStatus } from '@/hooks/mac-connection';
import { groupByProject, isActive } from '@/lib/workspaces';
import { useColors } from '@/theme';

export function Workspaces() {
  const colors = useColors();
  const router = useRouter();
  const { mac, state, missing } = useMacConnection();
  const status = useStatus();
  const [showIdle, setShowIdle] = useState(false);

  const sections = useMemo(() => {
    if (!status) return [];
    return groupByProject(status)
      .map((group) => ({
        ...group,
        data: showIdle ? group.workspaces : group.workspaces.filter(isActive),
        idleCount: group.workspaces.length - group.liveCount,
      }))
      .filter((group) => group.data.length > 0);
  }, [status, showIdle]);

  const header = (
    <Stack.Screen
      options={{
        title: mac?.name ?? 'Workspaces',
        headerRight: () => (
          <Pressable onPress={() => setShowIdle((v) => !v)} accessibilityRole="button" hitSlop={8}>
            <Text style={[styles.headerButton, { color: colors.primary }]}>{showIdle ? 'Live only' : 'Show idle'}</Text>
          </Pressable>
        ),
      }}
    />
  );

  if (missing) {
    return (
      <>
        {header}
        <EmptyState title="This Mac is not paired" message="Pair it again from the Macs list." />
      </>
    );
  }

  const capacity = status?.capacity;
  const macId = mac?.id ?? '';
  return (
    <>
      {header}
      <SectionList
        sections={sections}
        keyExtractor={(env) => env.path}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <ConnectionBanner state={state} />
            {capacity ? (
              <Text style={[styles.capacity, { color: capacity.overCapacity ? colors.warn : colors.secondary }]}>
                {`${capacity.liveCount} live \u00B7 ${(capacity.committedMb / 1024).toFixed(1)} GB committed of ${Math.round(capacity.totalMemoryMb / 1024)} GB`}
                {capacity.overCapacity ? ' \u00B7 over comfortable capacity' : ''}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          status ? (
            <EmptyState
              title="Nothing running"
              message="Workspaces appear here when an agent runs stim start, stim ios or stim android on this Mac."
            />
          ) : (
            <ActivityIndicator style={styles.loading} color={colors.primary} />
          )
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{section.name}</Text>
            <Text style={[styles.sectionMeta, { color: colors.tertiary }]}>
              {section.liveCount > 0 ? `${section.liveCount} live` : 'idle'}
              {!showIdle && section.idleCount > 0 ? ` \u00B7 ${section.idleCount} idle hidden` : ''}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <View style={styles.item}>
            <WorkspaceCard
              env={item}
              onPress={() => router.push({ pathname: '/mac/[id]/workspace', params: { id: macId, path: item.path } })}
              onErrors={() =>
                router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path: item.path, errors: '1' } })
              }
            />
          </View>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  headerButton: { fontSize: 15, fontWeight: '600', paddingHorizontal: 4 },
  list: { paddingBottom: 32 },
  listHeader: { gap: 6, paddingBottom: 4 },
  capacity: { fontSize: 13, paddingHorizontal: 16, paddingTop: 4 },
  loading: { marginTop: 48 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 20, fontWeight: '600' },
  sectionMeta: { fontSize: 13 },
  item: { paddingHorizontal: 16, paddingBottom: 12 },
});
