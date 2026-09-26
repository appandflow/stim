import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { MachineStatsRow } from '@/components/machine-stats';
import { Touch } from '@/components/touch';
import { useMachineLink, useMachineUsage } from '@/hooks/mac-connection';
import type { ConnectionState } from '@/lib/connection';
import { machineStats } from '@/lib/home';
import type { PairedMac } from '@/lib/macs';
import { useColors, type Colors } from '@/theme';

export function connectionColor(state: ConnectionState, missing: boolean, colors: Colors): string {
  if (missing || state.kind === 'refused' || state.kind === 'closed') return colors.error;
  if (state.kind === 'open') return colors.live;
  return state.kind === 'waiting' ? colors.warn : colors.tertiary;
}

export function MacChip({ mac, onPress }: { mac: PairedMac; onPress: () => void }) {
  const colors = useColors();
  const { state, missing } = useMachineLink(mac.id);
  const usage = useMachineUsage(mac.id);
  const dot = connectionColor(state, missing, colors);
  const name = mac.name;
  const open = state.kind === 'open';
  const stats = open ? machineStats(usage) : [];
  const detail = open
    ? stats.map((s) => `${s.label} ${s.value}`).join(', ') || 'Loading'
    : describeState(state, missing);
  return (
    <Touch
      feedback="card"
      onPress={onPress}
      accessibilityLabel={`${name}, ${detail}`}
      style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View>
        <Icon name="laptopcomputer" size={20} color={colors.text} />
        <View style={[styles.dot, { backgroundColor: dot, borderColor: colors.surface }]} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {name}
        </Text>
        {open && stats.length > 0 ? (
          <MachineStatsRow usage={usage} />
        ) : (
          <Text style={[styles.detail, { color: colors.secondary }]} numberOfLines={1}>
            {open ? 'Loading' : detail}
          </Text>
        )}
      </View>
    </Touch>
  );
}

export function describeState(state: ConnectionState, missing: boolean): string {
  if (missing) return 'Not paired';
  switch (state.kind) {
    case 'open':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'waiting':
      return `Offline \u00B7 retrying in ${Math.round(state.retryInMs / 1000)}s`;
    case 'refused':
      return state.code === 'protocol-unsupported' ? 'Needs an update' : 'Pair again';
    default:
      return 'Disconnected';
  }
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 14,
    paddingRight: 18,
    paddingVertical: 9,
    borderRadius: 24,
    borderCurve: 'continuous',
    borderWidth: 1,
    maxWidth: 280,
  },
  dot: { position: 'absolute', top: -2, right: -3, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  text: { flexShrink: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 1 },
});
