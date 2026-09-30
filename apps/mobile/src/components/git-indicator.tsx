import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Pill, StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { withAlpha } from '@/design/color';
import { gitBadges } from '@/lib/format';
import type { WorktreeGit } from '@/protocol/types';

/** Uncommitted changes, commits ahead and behind, and a merged branch: inline text, or pills with `chips`. */
export function GitIndicator({ git, chips = false }: { git: WorktreeGit | null | undefined; chips?: boolean }) {
  const { theme } = useUnistyles();
  const badges = gitBadges(git);
  if (!badges) return null;
  if (chips) {
    const { uncommitted, ahead, behind } = badges;
    return (
      <>
        {uncommitted ? <Pill tone="warning">{t`${uncommitted} uncommitted`}</Pill> : null}
        {ahead ? (
          <Pill
            accessibilityLabel={plural(ahead, { one: '# commit not pushed', other: '# commits not pushed' })}
          >{t`\u2191${ahead} unpushed`}</Pill>
        ) : null}
        {behind ? (
          <Pill
            accessibilityLabel={plural(behind, {
              one: '# commit behind the upstream',
              other: '# commits behind the upstream',
            })}
          >
            {t`\u2193${behind} behind`}
          </Pill>
        ) : null}
        {badges.merged ? (
          <Pill tone="accent">
            <Trans>merged</Trans>
          </Pill>
        ) : null}
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
          <Trans>merged</Trans>
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
