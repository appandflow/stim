import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import type { PairedConnection } from '@/hooks/mac-connection';
import type { ConnectionState } from '@/lib/connection';
import { macUsageSummary } from '@/lib/home';
import { useColors, type Colors } from '@/theme';

export function connectionColor(state: ConnectionState, missing: boolean, colors: Colors): string {
  if (missing || state.kind === 'refused' || state.kind === 'closed') return colors.error;
  if (state.kind === 'open') return colors.live;
  return state.kind === 'waiting' ? colors.warn : colors.tertiary;
}

export function MacChip({ mac, onPress }: { mac: PairedConnection; onPress: () => void }) {
  const colors = useColors();
  const summary = macUsageSummary(mac.status, mac.usage);
  const dot = connectionColor(mac.state, mac.missing, colors);
  const name = mac.mac.name;
  const detail =
    mac.state.kind === 'open' ? summary.parts.join(' \u00B7 ') || 'Loading' : describeState(mac.state, mac.missing);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${detail}`}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
    >
      <View>
        <Icon name="laptopcomputer" size={20} color={colors.text} />
        <View style={[styles.dot, { backgroundColor: dot, borderColor: colors.surface }]} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {name}
        </Text>
        <Text
          style={[styles.detail, { color: summary.warn && mac.state.kind === 'open' ? colors.warn : colors.secondary }]}
          numberOfLines={1}
        >
          {detail}
        </Text>
      </View>
    </Pressable>
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
  pressed: { opacity: 0.6 },
  dot: { position: 'absolute', top: -2, right: -3, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  text: { flexShrink: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 1 },
});
