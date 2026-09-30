import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/icon';
import { Text } from '@/components/text';
import type { FontWeight, TextVariant } from '@/design/tokens';
import { toneColor, type Tone } from '@/design/tone';
import type { StatKind } from '@/lib/home';

export const STAT_ICON: Record<StatKind, IconName> = {
  cpu: 'cpu',
  memory: 'memorychip',
  disk: 'internaldrive',
};

export interface StatItem {
  kind: StatKind;
  value: string;
  /** Colors the icon and the value; without it the icon is secondary and the value takes `valueTone`. */
  tone?: Tone;
}

/** CPU, memory and disk stats as a row of icon and value pairs. */
export function StatRow({
  stats,
  iconSize = 11,
  variant = 'caption',
  weight,
  valueTone = 'default',
  wrap,
  gap = 'md',
  accessible,
  accessibilityLabel,
}: {
  stats: readonly StatItem[];
  iconSize?: number;
  variant?: TextVariant;
  weight?: FontWeight;
  valueTone?: Tone;
  wrap?: boolean;
  gap?: 'sm' | 'md';
  accessible?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.row(gap, wrap)} accessible={accessible} accessibilityLabel={accessibilityLabel}>
      {stats.map((stat) => (
        <View key={stat.kind} style={[styles.stat, stat.kind === 'disk' && styles.shrink]}>
          <Icon name={STAT_ICON[stat.kind]} size={iconSize} color={toneColor(theme, stat.tone ?? 'secondary')} />
          <Text
            variant={variant}
            weight={weight}
            tone={stat.tone ?? valueTone}
            style={[styles.value, styles.shrink]}
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
  row: (gap: 'sm' | 'md', wrap: boolean | undefined) =>
    wrap
      ? ({
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: theme.space[gap],
          rowGap: 2,
        } as const)
      : ({ flexDirection: 'row', alignItems: 'center', gap: theme.space[gap], flexShrink: 0 } as const),
  stat: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  shrink: { flexShrink: 1 },
  value: { fontVariant: ['tabular-nums'] },
}));
