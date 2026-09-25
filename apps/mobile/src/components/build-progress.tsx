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
  const timing = build.expectedMs && progress.remaining ? `${elapsed} / ~${clockDuration(build.expectedMs)}` : elapsed;
  const platform = build.platform === 'ios' ? 'iOS' : 'Android';
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
          {compact ? '' : `Building ${platform}${build.slot === 'default' ? '' : ` \u00B7 ${build.slot}`}  `}
          <Text style={[styles.phase, { color: colors.primary }]}>{build.phase}</Text>
        </Text>
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
      {progress.remaining ? (
        <Text style={[styles.remaining, { color: colors.tertiary }]} numberOfLines={1}>
          {progress.remaining}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  label: { fontSize: 13, flex: 1, flexShrink: 1 },
  phase: { fontSize: 12, fontFamily: mono },
  timing: { fontSize: 12, fontFamily: mono, flexShrink: 0 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  indeterminate: { opacity: 0.6 },
  remaining: { fontSize: 11, marginTop: -2 },
});
