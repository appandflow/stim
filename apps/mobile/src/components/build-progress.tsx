import { StyleSheet, Text, View } from 'react-native';

import { useNow } from '@/hooks/use-now';
import { buildProgress, clockDuration } from '@/lib/format';
import type { BuildReport } from '@/protocol/types';
import { mono, useColors } from '@/theme';

export function BuildProgressBar({ build, compact = false }: { build: BuildReport; compact?: boolean }) {
  const colors = useColors();
  const now = useNow(1000);
  const progress = buildProgress(build, now);
  const elapsed = clockDuration(progress.elapsedMs);
  const timing = compact
    ? (progress.remaining ?? elapsed)
    : build.expectedMs && progress.remaining
      ? `${elapsed} / ~${clockDuration(build.expectedMs)} \u00B7 ${progress.remaining}`
      : elapsed;
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {compact ? null : (
          <Text style={[styles.label, { color: colors.text }]}>
            Building {build.platform}
            {build.slot === 'default' ? '' : ` \u00B7 ${build.slot}`}
          </Text>
        )}
        <Text style={[styles.phase, { color: colors.primary }]}>{build.phase}</Text>
        <View style={styles.spacer} />
        <Text style={[styles.timing, { color: colors.secondary }]} numberOfLines={1}>
          {timing}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: colors.raised }]}>
        <View
          style={[
            styles.fill,
            { backgroundColor: colors.accent, width: `${Math.round((progress.fraction ?? 0.15) * 100)}%` },
            progress.fraction === null && styles.indeterminate,
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 13 },
  phase: { fontSize: 12, fontFamily: mono },
  spacer: { flex: 1 },
  timing: { fontSize: 12, fontFamily: mono },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  indeterminate: { opacity: 0.6 },
});
