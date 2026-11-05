import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { withAlpha } from '@/design/color';
import { barFills, namesPhases, phaseName, segmentWeights, type PhaseStep } from '@/lib/workspace-view';

/** A running build's phases as bar segments sized by their expected time, with their names under them unless `names` is off. */
export function PhaseBar({ steps, buildId, names = true }: { steps: PhaseStep[]; buildId: string; names?: boolean }) {
  const weights = segmentWeights(steps);
  const fills = barFills(steps, buildId);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.phases}>
      <View style={styles.segments}>
        {steps.map((step, i) => (
          <View key={step.phase} style={[styles.segment, { flexGrow: weights[i] }]}>
            <View
              style={[
                styles.segmentFill,
                {
                  width: `${Math.round(fills[i]! * 100)}%`,
                },
              ]}
            />
          </View>
        ))}
      </View>
      {names && namesPhases(steps) ? (
        <View style={styles.segments}>
          {steps.map((step, i) => (
            <Text
              key={step.phase}
              variant="caption2"
              tone={step.state === 'current' ? 'brand' : 'tertiary'}
              weight={step.state === 'current' ? 'semibold' : undefined}
              numberOfLines={1}
              style={[styles.segmentLabel, { flexGrow: weights[i] }]}
            >
              {phaseName(step.phase)}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  phases: { gap: theme.space.xs },
  segments: { flexDirection: 'row', gap: 3 },
  segment: {
    flexBasis: 0,
    height: 5,
    borderRadius: theme.radius.round,
    overflow: 'hidden',
    backgroundColor: withAlpha(theme.colors.primary, theme.opacity.tint),
  },
  segmentFill: { height: 5, backgroundColor: theme.colors.primary },
  segmentLabel: { flexBasis: 0 },
}));
