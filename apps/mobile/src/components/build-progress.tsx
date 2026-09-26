import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { useNow } from '@/hooks/use-now';
import { buildProgress, clockDuration, outcomeLabel } from '@/lib/format';
import type { BuildReport } from '@/protocol/types';

export function BuildProgressBar({
  build,
  compact = false,
  frozenAt,
}: {
  build: BuildReport;
  compact?: boolean;
  frozenAt?: number | null;
}) {
  const ticking = useNow(1000);
  const progress = buildProgress(build, frozenAt ?? ticking);
  const elapsed = clockDuration(progress.elapsedMs);
  const timing = build.expectedMs && progress.remaining ? `${elapsed} / ~${clockDuration(build.expectedMs)}` : elapsed;
  const platform = build.platform === 'ios' ? 'iOS' : 'Android';
  const outcome = outcomeLabel(build);
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text variant="footnote" style={styles.label} numberOfLines={1}>
          {compact ? '' : `Building ${platform}${build.slot === 'default' ? '' : ` \u00B7 ${build.slot}`}  `}
          <Text variant="caption" tone="brand" mono>
            {build.phase}
          </Text>
        </Text>
        {outcome ? <Pill tone={build.outcome === 'hit' ? 'success' : 'warning'}>{outcome}</Pill> : null}
        <Text variant="caption" tone="secondary" mono style={styles.timing} numberOfLines={1}>
          {timing}
        </Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${Math.round((progress.fraction ?? 0.15) * 100)}%` },
            progress.fraction === null && styles.indeterminate,
          ]}
        />
      </View>
      {progress.remaining ? (
        <Text variant="caption2" tone="tertiary" style={styles.remaining} numberOfLines={1}>
          {`${progress.remaining} \u00B7 median of ${build.basis} ${build.outcome} run${build.basis === 1 ? '' : 's'}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  label: { flex: 1, flexShrink: 1 },
  timing: { flexShrink: 0 },
  track: { height: 4, borderRadius: theme.radius.round, overflow: 'hidden', backgroundColor: theme.colors.raised },
  fill: { height: 4, borderRadius: theme.radius.round, backgroundColor: theme.colors.accent },
  indeterminate: { opacity: 0.6 },
  remaining: { marginTop: -theme.space.xxs },
}));
