import { StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { machineStats, type MachineStat, type StatKind } from '@/lib/home';
import type { MachineUsage } from '@/protocol/types';
import { useColors, type Colors } from '@/theme';

const STAT_ICON: Record<StatKind, IconName> = {
  cpu: 'cpu',
  memory: 'memorychip',
  disk: 'internaldrive',
};

function toneColor(tone: MachineStat['tone'], colors: Colors): string {
  return tone === 'critical' ? colors.error : tone === 'warn' ? colors.warn : colors.text;
}

/** The CPU, RAM and disk stats as a compact icon+value row. Shared by the machine chip and the status sheet. */
export function MachineStatsRow({ usage, large }: { usage: MachineUsage | null; large?: boolean }) {
  const colors = useColors();
  const stats = machineStats(usage);
  if (stats.length === 0) return null;
  return (
    <View style={styles.row} accessibilityLabel={stats.map((s) => `${s.label} ${s.value}`).join(', ')}>
      {stats.map((stat) => (
        <View key={stat.kind} style={styles.stat}>
          <Icon name={STAT_ICON[stat.kind]} size={large ? 15 : 12} color={toneColor(stat.tone, colors)} />
          <Text
            style={[large ? styles.largeValue : styles.compactValue, { color: toneColor(stat.tone, colors) }]}
            numberOfLines={1}
          >
            {stat.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  compactValue: { fontSize: 12, fontVariant: ['tabular-nums'] },
  largeValue: { fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
});
