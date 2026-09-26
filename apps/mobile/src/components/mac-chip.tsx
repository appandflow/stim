import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { MachineStatsRow } from '@/components/machine-stats';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useMachineLink, useMachineUsage } from '@/hooks/mac-connection';
import type { ConnectionState } from '@/lib/connection';
import { machineStats } from '@/lib/home';
import type { PairedMac } from '@/lib/macs';
import type { Theme } from '@/design/theme';

export function connectionColor(state: ConnectionState, missing: boolean, colors: Theme['colors']): string {
  if (missing || state.kind === 'refused' || state.kind === 'closed') return colors.error;
  if (state.kind === 'open') return colors.success;
  return state.kind === 'waiting' ? colors.warning : colors.tertiary;
}

export function MacChip({ mac, onPress }: { mac: PairedMac; onPress: () => void }) {
  const { theme } = useUnistyles();
  const { state, missing } = useMachineLink(mac.id);
  const usage = useMachineUsage(mac.id);
  const dot = connectionColor(state, missing, theme.colors);
  const name = mac.name;
  const open = state.kind === 'open';
  const stats = open ? machineStats(usage) : [];
  const detail = open
    ? stats.map((s) => `${s.label} ${s.value}`).join(', ') || 'Loading'
    : describeState(state, missing);
  return (
    <Touch feedback="card" onPress={onPress} accessibilityLabel={`${name}, ${detail}`} style={styles.chip}>
      <View>
        <Icon name="laptopcomputer" size={20} color={theme.colors.text} />
        <View style={[styles.dot, { backgroundColor: dot }]} />
      </View>
      <View style={styles.text}>
        <Text variant="body" weight="semibold" numberOfLines={1}>
          {name}
        </Text>
        {open && stats.length > 0 ? (
          <MachineStatsRow usage={usage} />
        ) : (
          <Text variant="caption" tone="secondary" style={styles.detail} numberOfLines={1}>
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

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingLeft: theme.space.lg,
    paddingRight: theme.space.xl,
    paddingVertical: theme.space.md,
    borderRadius: theme.radius.round,
    borderCurve: 'continuous',
    borderWidth: 1,
    maxWidth: 280,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
  dot: {
    position: 'absolute',
    top: -2,
    right: -3,
    width: 9,
    height: 9,
    borderRadius: theme.radius.round,
    borderWidth: 1.5,
    borderColor: theme.colors.surface,
  },
  text: { flexShrink: 1 },
  detail: { fontVariant: ['tabular-nums'], marginTop: 1 },
}));
