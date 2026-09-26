import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ConnectionBanner } from '@/components/connection-banner';
import { Icon } from '@/components/icon';
import { connectionColor, describeState } from '@/components/mac-chip';
import { MachineStatsRow } from '@/components/machine-stats';
import { UsageCharts, useUsageHistory } from '@/components/usage-charts';
import { useMacById } from '@/hooks/mac-connection';
import { budgetRows, formatBytes, LOW_DISK_BYTES, memoryGb, usageCharts, type BudgetRow } from '@/lib/home';
import { tildeHome } from '@/lib/paths';
import { attentionGroups, devicesOf, workspaceTitleAt, type AttentionGroup } from '@/lib/workspaces';
import type { StatusPayload } from '@/protocol/types';
import { mono, useColors } from '@/theme';

export function MacStatus({ id }: { id: string }) {
  const colors = useColors();
  const { mac, connection, state, missing, status, usage, home } = useMacById(id);
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
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.secondary }}>This machine is not paired.</Text>
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
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: colors.background }}>
      <View style={styles.titleRow}>
        <View>
          <Icon name="laptopcomputer" size={26} color={colors.text} />
          <View
            style={[
              styles.dot,
              { backgroundColor: connectionColor(state, missing, colors), borderColor: colors.background },
            ]}
          />
        </View>
        <View style={styles.titleText}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {mac.name}
          </Text>
          <Text style={[styles.subtitle, { color: colors.secondary }]} numberOfLines={1}>
            {open ? `stim ${state.server.stim} \u00B7 server ${state.server.version}` : describeState(state, missing)}
          </Text>
        </View>
      </View>
      <Text style={[styles.endpoint, { color: colors.tertiary }]} selectable>
        {mac.endpoint}
      </Text>
      <ConnectionBanner state={state} />
      {usage ? <MachineStatsRow usage={usage} large /> : null}

      {capacity ? (
        <Section title="Capacity">
          <Line label="Live workspaces" value={String(capacity.liveCount)} />
          <Line
            label="Stim's share of memory"
            value={`${(capacity.committedMb / 1024).toFixed(1)} of ${Math.round(capacity.totalMemoryMb / 1024)} GB`}
            warn={capacity.overCapacity}
          />
          <Bar fraction={capacity.committedMb / Math.max(1, capacity.totalMemoryMb)} warn={capacity.overCapacity} />
          {capacity.overCapacity ? (
            <Text style={[styles.note, { color: colors.warn }]}>Over comfortable capacity.</Text>
          ) : null}
        </Section>
      ) : open ? (
        <ActivityIndicator color={colors.primary} />
      ) : null}

      {usage ? (
        <>
          {charts.length > 0 ? (
            <Section title="Last hour">
              <UsageCharts charts={charts} />
            </Section>
          ) : null}
          <Section title="Machine">
            <Line
              label="Load average"
              value={`${[usage.load.avg1, usage.load.avg5, usage.load.avg15].map((n) => n.toFixed(1)).join(' \u00B7 ')} on ${usage.load.cpus} cores`}
              warn={usage.load.avg5 > usage.load.cpus}
            />
            <Line
              label={usedBytes === null ? 'Memory' : 'Memory used'}
              value={`${usedBytes === null ? '' : `${memoryGb(usedBytes).toFixed(1)} of `}${Math.round(memoryGb(usage.memory.totalBytes))} GB${usage.memory.pressure ? ` \u00B7 ${usage.memory.pressure} pressure` : ''}`}
              warn={memoryPressed}
            />
            {usedBytes === null ? null : (
              <Bar fraction={usedBytes / Math.max(1, usage.memory.totalBytes)} warn={memoryPressed} />
            )}
          </Section>
          <Section title="Disk">
            {usage.volumes.map((volume) => {
              const low = volume.freeBytes < LOW_DISK_BYTES;
              return (
                <View key={volume.mount} style={styles.volume}>
                  <Line
                    label={`${volume.mount} \u00B7 ${volume.holds.join(', ')}`}
                    value={`${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}`}
                    warn={low}
                  />
                  <Bar fraction={1 - volume.freeBytes / Math.max(1, volume.totalBytes)} warn={low} />
                </View>
              );
            })}
          </Section>
        </>
      ) : null}

      {budgets && budgets.length > 0 ? (
        <Section title="Budgets">
          {budgets.map((row) => (
            <Line key={row.label} label={row.label} value={row.value} />
          ))}
        </Section>
      ) : null}

      {status ? (
        <Section title="Devices">
          {running.length === 0 && status.deviceLeases.length === 0 ? (
            <Text style={[styles.note, { color: colors.tertiary }]}>No device running.</Text>
          ) : null}
          {running.map(({ env, device }) => (
            <Line
              key={`${env.path}\n${device.platform}\n${device.slot}`}
              label={`${device.platform === 'ios' ? 'iOS' : 'Android'} \u00B7 ${device.model}`}
              value={workspaceTitleAt(env.path, status)}
            />
          ))}
          {status.deviceLeases.map((lease) => (
            <Line
              key={`${lease.platform}\n${lease.id ?? lease.path}`}
              label={`${lease.deviceName ?? lease.id ?? 'Device'} \u00B7 leased`}
              value={workspaceTitleAt(lease.path, status)}
              warn={lease.expired}
            />
          ))}
        </Section>
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
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? groups : groups.slice(0, COLLAPSED_GROUPS);
  const hidden = groups.length - shown.length;
  return (
    <Section title={`Needs attention \u00B7 ${groups.length}`}>
      {shown.map((group) => (
        <View key={group.path} style={styles.group}>
          <View style={styles.groupHeader}>
            <Text style={[styles.groupTitle, { color: colors.text }]} numberOfLines={1} ellipsizeMode="middle">
              {workspaceTitleAt(group.path, status)}
            </Text>
            <Text style={{ color: group.live ? colors.live : colors.tertiary, fontSize: 12 }}>
              {group.live ? 'live' : 'idle'}
            </Text>
          </View>
          {group.items.map((item, index) => (
            <View
              key={index}
              style={[styles.issue, { backgroundColor: `${item.severity === 'error' ? colors.error : colors.warn}1A` }]}
            >
              <Text style={[styles.issueText, { color: item.severity === 'error' ? colors.error : colors.warn }]}>
                {tildeHome(item.message, home)}
              </Text>
              {item.remedy && item.command ? (
                <View style={styles.remedy}>
                  <Text style={[styles.command, { color: colors.text }]} selectable numberOfLines={2}>
                    {item.remedy}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy command"
                    onPress={() => void Clipboard.setStringAsync(item.command ?? '')}
                    hitSlop={8}
                  >
                    <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600' }}>Copy</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      {groups.length > COLLAPSED_GROUPS ? (
        <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} hitSlop={8}>
          <Text style={{ color: colors.primary, fontSize: 14 }}>
            {expanded ? 'Show fewer' : `Show ${hidden} more ${hidden === 1 ? 'workspace' : 'workspaces'}`}
          </Text>
        </Pressable>
      ) : null}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.tertiary }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
    </View>
  );
}

function Line({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const colors = useColors();
  return (
    <View style={styles.line}>
      <Text style={[styles.label, { color: colors.secondary }]} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[styles.value, { color: warn ? colors.warn : colors.text }]}>{value}</Text>
    </View>
  );
}

function Bar({ fraction, warn }: { fraction: number; warn: boolean }) {
  const colors = useColors();
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` as const;
  return (
    <View style={[styles.track, { backgroundColor: colors.raised }]}>
      <View style={[styles.fill, { width, backgroundColor: warn ? colors.warn : colors.accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 20, paddingTop: 28, gap: 14, paddingBottom: 48 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  dot: { position: 'absolute', top: -2, right: -4, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  titleText: { flex: 1 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 14, marginTop: 2 },
  endpoint: { fontSize: 12, fontFamily: mono },
  section: { gap: 6 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  card: { borderRadius: 14, borderCurve: 'continuous', borderWidth: 1, padding: 14, gap: 10 },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  label: { fontSize: 14, flexShrink: 1 },
  value: { fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'], textAlign: 'right' },
  volume: { gap: 6 },
  track: { height: 5, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
  note: { fontSize: 13 },
  group: { gap: 6 },
  groupHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  groupTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  issue: { padding: 10, borderRadius: 8, gap: 6 },
  issueText: { fontSize: 13, lineHeight: 18 },
  remedy: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  command: { flex: 1, fontSize: 12, fontFamily: mono },
});
