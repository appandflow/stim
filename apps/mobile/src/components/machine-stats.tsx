import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/icon';
import { Text } from '@/components/text';
import type { Theme } from '@/design/theme';
import { machineStats, type MachineStat, type StatKind } from '@/lib/home';
import type { MachineUsage } from '@/protocol/types';

export const STAT_ICON: Record<StatKind, IconName> = {
  cpu: 'cpu',
  memory: 'memorychip',
  disk: 'internaldrive',
};

export function toneColor(tone: MachineStat['tone'], colors: Theme['colors']): string {
  return tone === 'critical' ? colors.error : tone === 'warn' ? colors.warning : colors.text;
}

/** The CPU, RAM and disk stats as a compact icon+value row. Shared by the machine chip and the status sheet. */
export function MachineStatsRow({ usage, large }: { usage: MachineUsage | null; large?: boolean }) {
  const { theme } = useUnistyles();
  const stats = machineStats(usage);
  if (stats.length === 0) return null;
  return (
    <View style={styles.row} accessibilityLabel={stats.map((s) => `${s.label} ${s.value}`).join(', ')}>
      {stats.map((stat) => (
        <View key={stat.kind} style={styles.stat}>
          <Icon name={STAT_ICON[stat.kind]} size={large ? 15 : 12} color={toneColor(stat.tone, theme.colors)} />
          <Text
            variant={large ? 'callout' : 'caption'}
            weight={large ? 'medium' : undefined}
            style={[styles.value, { color: toneColor(stat.tone, theme.colors) }]}
            numberOfLines={1}
          >
            {stat.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  value: { fontVariant: ['tabular-nums'] },
}));
