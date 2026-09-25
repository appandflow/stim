import { StyleSheet, Text, View } from 'react-native';

import { Chip, StatusDot } from '@/components/chip';
import { gitBadges } from '@/lib/format';
import type { WorktreeGit } from '@/protocol/types';
import { useColors } from '@/theme';

/** Uncommitted changes, commits ahead and behind, and a merged branch: inline text, or chips with `chips`. */
export function GitIndicator({ git, chips = false }: { git: WorktreeGit | null | undefined; chips?: boolean }) {
  const colors = useColors();
  const badges = gitBadges(git);
  if (!badges) return null;
  if (chips) {
    return (
      <>
        {badges.uncommitted ? <Chip tint={colors.warn}>{`${badges.uncommitted} uncommitted`}</Chip> : null}
        {badges.arrows ? <Chip mono={badges.arrows}>{''}</Chip> : null}
        {badges.merged ? <Chip tint={colors.primary}>merged</Chip> : null}
      </>
    );
  }
  return (
    <View style={styles.inline} accessible accessibilityLabel={badges.label}>
      {badges.uncommitted ? (
        <>
          <StatusDot color={colors.warn} />
          <Text style={[styles.text, { color: colors.warn }]}>{badges.uncommitted}</Text>
        </>
      ) : null}
      {badges.arrows ? <Text style={[styles.text, { color: colors.secondary }]}>{badges.arrows}</Text> : null}
      {badges.merged ? (
        <Text style={[styles.text, styles.pill, { color: colors.primary, backgroundColor: `${colors.primary}1F` }]}>
          merged
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  text: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pill: { fontSize: 11, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, overflow: 'hidden' },
});
