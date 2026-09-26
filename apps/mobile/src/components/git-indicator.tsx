import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Pill, StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { withAlpha } from '@/design/color';
import { gitBadges } from '@/lib/format';
import type { WorktreeGit } from '@/protocol/types';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** Uncommitted changes, commits ahead and behind, and a merged branch: inline text, or pills with `chips`. */
export function GitIndicator({ git, chips = false }: { git: WorktreeGit | null | undefined; chips?: boolean }) {
  const { theme } = useUnistyles();
  const badges = gitBadges(git);
  if (!badges) return null;
  if (chips) {
    return (
      <>
        {badges.uncommitted ? <Pill tone="warning">{`${badges.uncommitted} uncommitted`}</Pill> : null}
        {badges.ahead ? (
          <Pill accessibilityLabel={`${commits(badges.ahead)} not pushed`}>{`\u2191${badges.ahead} unpushed`}</Pill>
        ) : null}
        {badges.behind ? (
          <Pill accessibilityLabel={`${commits(badges.behind)} behind the upstream`}>
            {`\u2193${badges.behind} behind`}
          </Pill>
        ) : null}
        {badges.merged ? <Pill tone="accent">merged</Pill> : null}
      </>
    );
  }
  return (
    <View style={styles.inline}>
      {badges.uncommitted ? (
        <>
          <StatusDot color={theme.colors.warning} />
          <Text variant="footnote" weight="semibold" tone="warning" style={styles.tabular}>
            {badges.uncommitted}
          </Text>
        </>
      ) : null}
      {badges.arrows ? (
        <Text variant="footnote" weight="semibold" tone="secondary" style={styles.tabular}>
          {badges.arrows}
        </Text>
      ) : null}
      {badges.merged ? (
        <Text variant="caption2" weight="semibold" tone="brand" style={styles.merged}>
          merged
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, flexShrink: 0 },
  tabular: { fontVariant: ['tabular-nums'] },
  merged: {
    paddingHorizontal: theme.space.xs,
    paddingVertical: 1,
    borderRadius: theme.radius.small,
    overflow: 'hidden',
    backgroundColor: withAlpha(theme.colors.primary, theme.opacity.pressed),
  },
}));
