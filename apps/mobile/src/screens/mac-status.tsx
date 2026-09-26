import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { ConnectionBanner } from '@/components/connection-banner';
import { Icon } from '@/components/icon';
import { ListRow, ListSection } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { connectionColor, describeState } from '@/components/mac-chip';
import { MachineStatsRow } from '@/components/machine-stats';
import { explainReadOnly, ScopeChip } from '@/components/read-only';
import { Text } from '@/components/text';
import { UsageCharts, useUsageHistory } from '@/components/usage-charts';
import { withAlpha } from '@/design/color';
import { useMacById, useMachineStatus, useMachineUsage } from '@/hooks/mac-connection';
import { pairingScope } from '@/lib/connection';
import { budgetRows, formatBytes, LOW_DISK_BYTES, memoryGb, usageCharts, type BudgetRow } from '@/lib/home';
import { tildeHome } from '@/lib/paths';
import { attentionGroups, devicesOf, workspaceTitleAt, type AttentionGroup } from '@/lib/workspaces';
import type { StatusPayload } from '@/protocol/types';

export function MacStatus({ id }: { id: string }) {
  const { theme } = useUnistyles();
  const { mac, connection, state, missing, home } = useMacById(id);
  const status = useMachineStatus(id);
  const usage = useMachineUsage(id);
  const [budgets, setBudgets] = useState<BudgetRow[] | null>(null);
  const open = state.kind === 'open';
  const samples = useUsageHistory(connection, open, usage);
  const charts = useMemo(() => usageCharts(samples ?? [], usage), [samples, usage]);

  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    connection.request('settings.get', {}).then(
      (settings) => !cancelled && setBudgets(budgetRows(settings)),
      () => !cancelled && setBudgets([]),
    );
    return () => {
      cancelled = true;
    };
  }, [connection, open]);

  if (!mac) {
    return (
      <View style={styles.center}>
        <Text tone="secondary">This machine is not paired.</Text>
      </View>
    );
  }

  const capacity = status?.capacity;
  const usedBytes = typeof usage?.memory.usedBytes === 'number' ? usage.memory.usedBytes : null;
  const memoryPressed = !!usage?.memory.pressure && usage.memory.pressure !== 'normal';
  const running = (status?.environments ?? []).flatMap((env) =>
    devicesOf(env)
      .filter((d) => d.running)
      .map((d) => ({ env, device: d })),
  );
  const attention = attentionGroups(status?.environments ?? []);

  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.background }}>
      <View style={styles.titleRow}>
        <View>
          <Icon name="laptopcomputer" size={26} color={theme.colors.text} />
          <View style={[styles.dot, { backgroundColor: connectionColor(state, missing, theme.colors) }]} />
        </View>
        <View style={styles.titleText}>
          <Text variant="title" numberOfLines={1}>
            {mac.name}
          </Text>
          <Text tone="secondary" style={styles.subtitle} numberOfLines={1}>
            {open ? `stim ${state.server.stim} \u00B7 server ${state.server.version}` : describeState(state, missing)}
          </Text>
        </View>
        <ScopeChip state={state} />
      </View>
      <Text variant="caption" tone="tertiary" mono selectable>
        {mac.endpoint}
      </Text>
      <ConnectionBanner state={state} style={styles.banner} />
      {pairingScope(state) === 'read' ? (
        <Banner
          message="This phone is read-only: it cannot reload or stop workspaces, or control devices."
          action={{ label: 'Allow control', onPress: () => explainReadOnly(mac.name, state, connection) }}
        />
      ) : null}
      {usage ? <MachineStatsRow usage={usage} large /> : null}

      {capacity ? (
        <ListSection title="Capacity">
          <ListRow title="Live workspaces" value={String(capacity.liveCount)} />
          <ListRow
            title="Stim's share of memory"
            value={`${(capacity.committedMb / 1024).toFixed(1)} of ${Math.round(capacity.totalMemoryMb / 1024)} GB`}
            valueTone={capacity.overCapacity ? 'warning' : 'default'}
          />
          <Bar fraction={capacity.committedMb / Math.max(1, capacity.totalMemoryMb)} warn={capacity.overCapacity} />
          {capacity.overCapacity ? (
            <Text variant="footnote" tone="warning" style={styles.item}>
              Over comfortable capacity.
            </Text>
          ) : null}
        </ListSection>
      ) : open ? (
        <ActivityIndicator color={theme.colors.primary} />
      ) : null}

      {usage ? (
        <>
          {charts.length > 0 ? (
            <ListSection title="Last hour">
              <View style={styles.item}>
                <UsageCharts charts={charts} />
              </View>
            </ListSection>
          ) : null}
          <ListSection title="Machine">
            <ListRow
              title="Load average"
              value={`${[usage.load.avg1, usage.load.avg5, usage.load.avg15].map((n) => n.toFixed(1)).join(' \u00B7 ')} on ${usage.load.cpus} cores`}
              valueTone={usage.load.avg5 > usage.load.cpus ? 'warning' : 'default'}
            />
            <ListRow
              title={usedBytes === null ? 'Memory' : 'Memory used'}
              value={`${usedBytes === null ? '' : `${memoryGb(usedBytes).toFixed(1)} of `}${Math.round(memoryGb(usage.memory.totalBytes))} GB${usage.memory.pressure ? ` \u00B7 ${usage.memory.pressure} pressure` : ''}`}
              valueTone={memoryPressed ? 'warning' : 'default'}
            />
            {usedBytes === null ? null : (
              <Bar fraction={usedBytes / Math.max(1, usage.memory.totalBytes)} warn={memoryPressed} />
            )}
          </ListSection>
          <ListSection title="Disk">
            {usage.volumes.map((volume) => {
              const low = volume.freeBytes < LOW_DISK_BYTES;
              return (
                <View key={volume.mount}>
                  <ListRow
                    title={`${volume.mount} \u00B7 ${volume.holds.join(', ')}`}
                    value={`${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}`}
                    valueTone={low ? 'warning' : 'default'}
                  />
                  <Bar fraction={1 - volume.freeBytes / Math.max(1, volume.totalBytes)} warn={low} />
                </View>
              );
            })}
          </ListSection>
        </>
      ) : null}

      {budgets && budgets.length > 0 ? (
        <ListSection title="Budgets">
          {budgets.map((row) => (
            <ListRow key={row.label} title={row.label} value={row.value} />
          ))}
        </ListSection>
      ) : null}

      {status ? (
        <ListSection title="Devices">
          {running.length === 0 && status.deviceLeases.length === 0 ? (
            <Text variant="footnote" tone="tertiary" style={styles.item}>
              No device running.
            </Text>
          ) : null}
          {running.map(({ env, device }) => (
            <ListRow
              key={`${env.path}\n${device.platform}\n${device.slot}`}
              title={`${device.platform === 'ios' ? 'iOS' : 'Android'} \u00B7 ${device.model}`}
              value={workspaceTitleAt(env.path, status)}
            />
          ))}
          {status.deviceLeases.map((lease) => (
            <ListRow
              key={`${lease.platform}\n${lease.id ?? lease.path}`}
              title={`${lease.deviceName ?? lease.id ?? 'Device'} \u00B7 leased`}
              value={workspaceTitleAt(lease.path, status)}
              valueTone={lease.expired ? 'warning' : 'default'}
            />
          ))}
        </ListSection>
      ) : null}

      {attention.length > 0 ? <NeedsAttention groups={attention} home={home} status={status} /> : null}
    </ScrollView>
  );
}

const COLLAPSED_GROUPS = 3;

function NeedsAttention({
  groups,
  home,
  status,
}: {
  groups: AttentionGroup[];
  home: string | null | undefined;
  status: StatusPayload | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? groups : groups.slice(0, COLLAPSED_GROUPS);
  const hidden = groups.length - shown.length;
  return (
    <ListSection title={`Needs attention \u00B7 ${groups.length}`}>
      {shown.map((group) => (
        <View key={group.path} style={[styles.item, styles.group]}>
          <View style={styles.groupHeader}>
            <Text variant="body" weight="semibold" style={styles.groupTitle} numberOfLines={1} ellipsizeMode="middle">
              {workspaceTitleAt(group.path, status)}
            </Text>
            <Text variant="caption" tone={group.live ? 'success' : 'tertiary'}>
              {group.live ? 'live' : 'idle'}
            </Text>
          </View>
          {group.items.map((item, index) => (
            <View key={index} style={styles.issue(item.severity === 'error')}>
              <Text variant="footnote" tone={item.severity === 'error' ? 'error' : 'warning'}>
                {tildeHome(item.message, home)}
              </Text>
              {item.remedy && item.command ? (
                <View style={styles.remedy}>
                  <Text variant="caption" mono style={styles.command} selectable numberOfLines={2}>
                    {item.remedy}
                  </Text>
                  <Button
                    variant="plain"
                    size="small"
                    title="Copy"
                    accessibilityLabel="Copy command"
                    onPress={() => void Clipboard.setStringAsync(item.command ?? '')}
                  />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      {groups.length > COLLAPSED_GROUPS ? (
        <Button
          variant="plain"
          size="small"
          title={expanded ? 'Show fewer' : `Show ${hidden} more ${hidden === 1 ? 'workspace' : 'workspaces'}`}
          onPress={() => setExpanded(!expanded)}
          style={[styles.item, styles.leading]}
        />
      ) : null}
    </ListSection>
  );
}

function Bar({ fraction, warn }: { fraction: number; warn: boolean }) {
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` as const;
  return (
    <View style={styles.item}>
      <View style={styles.track}>
        <View style={[styles.fill(warn), { width }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background },
  container: { padding: theme.space.xxl, paddingTop: theme.space.xxxl, gap: theme.space.lg, paddingBottom: 48 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg },
  banner: { marginHorizontal: -theme.space.xxl },
  dot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 11,
    height: 11,
    borderRadius: theme.radius.round,
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  titleText: { flex: 1 },
  subtitle: { marginTop: theme.space.xxs },
  item: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm },
  leading: { alignSelf: 'flex-start' },
  track: { height: 5, borderRadius: theme.radius.round, overflow: 'hidden', backgroundColor: theme.colors.raised },
  fill: (warn: boolean) => ({
    height: 5,
    borderRadius: theme.radius.round,
    backgroundColor: warn ? theme.colors.warning : theme.colors.accent,
  }),
  group: { gap: theme.space.sm },
  groupHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space.lg },
  groupTitle: { flexShrink: 1 },
  issue: (error: boolean) => ({
    padding: theme.space.md,
    borderRadius: theme.radius.control,
    gap: theme.space.sm,
    backgroundColor: withAlpha(error ? theme.colors.error : theme.colors.warning, theme.opacity.subtle),
  }),
  remedy: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg },
  command: { flex: 1 },
}));
