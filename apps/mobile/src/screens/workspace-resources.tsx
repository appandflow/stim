import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ListSection } from '@/components/list';
import { SheetScreen } from '@/components/sheet-screen';
import { Text } from '@/components/text';
import { useMacConnection, useMachineUsage, useStatus, useStatusHistory } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { formatBytes, formatMemoryMb } from '@/intl/format';
import {
  diskBreakdown,
  formatCpu,
  processRows,
  sparkline,
  workspaceSeries,
  workspaceStage,
  workspaceUsage,
} from '@/lib/workspace-view';
import { devicesOf, orderDevices } from '@/lib/workspaces';
import type { MachineUsage } from '@/protocol/types';

function workspaceVolumeFree(usage: MachineUsage | null): number | null {
  const volumes = usage?.volumes ?? [];
  const holding = volumes.filter((volume) => volume.holds.includes('Workspaces'));
  const pool = holding.length ? holding : volumes;
  return pool.length ? Math.min(...pool.map((volume) => volume.freeBytes)) : null;
}

export function WorkspaceResources({ path }: { path: string }) {
  const status = useStatus();
  const { mac } = useMacConnection();
  const machineUsage = useMachineUsage(mac?.id);
  const history = useStatusHistory(mac?.id);
  const now = useNow(30_000);
  const env = status?.environments.find((e) => e.path === path);
  if (!env) {
    return (
      <SheetScreen title={t`Status`}>
        <Text tone="secondary">
          <Trans>This workspace is no longer in the status.</Trans>
        </Text>
      </SheetScreen>
    );
  }
  const usage = workspaceUsage(env, status?.machine);
  const devices = orderDevices(devicesOf(env));
  const stage = workspaceStage(env, devices, now);
  const rows = processRows(env, devices, status?.machine);
  const series = workspaceSeries(history, path);
  const free = workspaceVolumeFree(machineUsage);
  const minutes = series?.minutes ?? 0;
  const peakCpu = series?.peakCpuPercent == null ? null : formatCpu(series.peakCpuPercent);
  const freeSpace = free === null ? '' : formatBytes(free);
  const diskNote = [
    diskBreakdown(env),
    free === null ? null : t`The Mac volume that holds workspaces has ${freeSpace} free.`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <SheetScreen
      title={t`Status`}
      subtitle={
        <>
          <Text variant="callout" weight="semibold" tone={stage.tone}>
            {stage.label}
            {stage.subtitle ? (
              <Text variant="callout" weight="regular" tone="secondary">
                {` \u00B7 ${stage.subtitle}`}
              </Text>
            ) : null}
          </Text>
          <Text variant="footnote" tone="secondary">
            {series && series.minutes > 0 ? t`This workspace \u00B7 last ${minutes} min` : t`This workspace`}
          </Text>
        </>
      }
    >
      <View style={styles.tiles}>
        <Tile
          label={t`CPU`}
          value={usage.cpuPercent === null ? '\u2014' : formatCpu(usage.cpuPercent)}
          bars={series?.cpuPercent ?? []}
          note={peakCpu === null ? null : t`peak ${peakCpu}`}
        />
        <Tile
          label={t`Memory`}
          value={usage.memoryMb === null ? '\u2014' : formatMemoryMb(usage.memoryMb)}
          bars={series?.memoryMb ?? []}
          note={series?.memoryChangeMb == null ? null : memoryChange(series.memoryChangeMb)}
        />
        <Tile
          label={t`Disk`}
          value={usage.diskBytes === null ? '\u2014' : formatBytes(usage.diskBytes)}
          bars={[]}
          note={free === null ? null : t`${freeSpace} free`}
        />
      </View>
      {rows.length ? (
        <ListSection>
          <View style={styles.tableRow}>
            <Text variant="caption" tone="tertiary" style={styles.grow}>
              <Trans>Process</Trans>
            </Text>
            <Text variant="caption" tone="tertiary" style={styles.cpu}>
              <Trans>CPU</Trans>
            </Text>
            <Text variant="caption" tone="tertiary" style={styles.memory}>
              <Trans>Memory</Trans>
            </Text>
          </View>
          {rows.map((row) => (
            <View key={row.key} style={[styles.tableRow, styles.separated]}>
              <Text variant="callout" numberOfLines={1} style={styles.grow}>
                {row.label}
              </Text>
              <Text variant="callout" tone="secondary" style={styles.cpu}>
                {formatCpu(row.cpuPercent)}
              </Text>
              <Text variant="callout" tone="secondary" style={styles.memory}>
                {formatMemoryMb(row.memoryMb)}
              </Text>
            </View>
          ))}
        </ListSection>
      ) : (
        <Text variant="footnote" tone="secondary">
          <Trans>Nothing in this workspace is using CPU or memory now.</Trans>
        </Text>
      )}
      {diskNote ? (
        <Text variant="footnote" tone="tertiary">
          {diskNote}
        </Text>
      ) : null}
    </SheetScreen>
  );
}

function memoryChange(mb: number): string {
  const sign = mb >= 0 ? '+' : '\u2212';
  return `${sign}${formatMemoryMb(Math.abs(mb))}`;
}

function Tile({
  label,
  value,
  bars,
  note,
}: {
  label: string;
  value: string;
  bars: (number | null)[];
  note: string | null;
}) {
  const heights = sparkline(bars);
  return (
    <View style={styles.tile}>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <Text variant="headline" style={styles.tabular} numberOfLines={1}>
        {value}
      </Text>
      {heights.length > 1 ? (
        <View style={styles.spark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {heights.map((height, i) => (
            <View
              key={i}
              style={[styles.bar, { height: height === null ? 0 : `${Math.max(6, Math.round(height * 100))}%` }]}
            />
          ))}
        </View>
      ) : null}
      {note ? (
        <Text variant="caption2" tone="tertiary" numberOfLines={1}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tiles: { flexDirection: 'row', gap: theme.space.md },
  tile: {
    flex: 1,
    flexBasis: 0,
    padding: theme.space.md + 2,
    gap: 3,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.grouped,
  },
  tabular: { fontVariant: ['tabular-nums'] },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, height: 22, marginVertical: 2 },
  bar: { flex: 1, borderRadius: 1, backgroundColor: theme.colors.accent },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm + 2,
  },
  separated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.separator },
  grow: { flex: 1 },
  cpu: { width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] },
  memory: { width: 72, textAlign: 'right', fontVariant: ['tabular-nums'] },
}));
