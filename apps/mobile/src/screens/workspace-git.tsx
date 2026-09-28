import * as Linking from 'expo-linking';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { chipColor } from '@/components/workspace-cards';
import { useStatus } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { shortDuration } from '@/lib/format';
import { checksSummary, checksTone } from '@/lib/workspace-view';
import { workspaceTitleAt } from '@/lib/workspaces';
import type { PullRequestFacts } from '@/protocol/types';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;
const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

const STATE_NAME: Record<PullRequestFacts['state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

const REVIEW_NAME: Record<NonNullable<PullRequestFacts['reviewDecision']>, string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
};

export function WorkspaceGit({ path }: { path: string }) {
  const { theme } = useUnistyles();
  const status = useStatus();
  const now = useNow(30_000);
  const env = status?.environments.find((e) => e.path === path);
  const worktree = env?.worktree;
  const git = worktree?.git;
  const pr = worktree?.pullRequest;
  const checks = pr ? checksTone(pr.checks) : null;
  const checkedAt = pr ? Date.parse(pr.checkedAt) : NaN;
  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={styles.container}>
      <View style={styles.titles}>
        <Text variant="title" numberOfLines={2}>
          {worktree?.branch ?? workspaceTitleAt(path, status)}
        </Text>
        <Text variant="footnote" tone="secondary">
          Git
        </Text>
      </View>
      {git ? (
        <ListSection>
          <ListRow title="Upstream" value={git.upstream ?? 'None'} valueTone={git.upstream ? 'default' : 'tertiary'} />
          <ListRow title="Ahead" value={git.ahead === null ? '\u2014' : commits(git.ahead)} />
          <ListRow title="Behind" value={git.behind === null ? '\u2014' : commits(git.behind)} />
          <ListRow title="Changed" value={files(git.changed)} valueTone={git.changed ? 'warning' : 'default'} />
          <ListRow title="Untracked" value={files(git.untracked)} valueTone={git.untracked ? 'warning' : 'default'} />
          {git.mergedInto ? <ListRow title="Merged into" value={git.mergedInto} valueTone="brand" /> : null}
        </ListSection>
      ) : (
        <Text variant="footnote" tone="secondary">
          Stim reports no git state for this workspace.
        </Text>
      )}
      {pr ? (
        <ListSection title="Pull request">
          <View style={styles.pr}>
            <Text variant="callout" weight="semibold">
              {`#${pr.number} ${pr.title}`}
            </Text>
          </View>
          <ListRow title="State" value={STATE_NAME[pr.state]} />
          {pr.checks ? (
            <ListRow
              title="Checks"
              value={checksSummary(pr.checks) ?? undefined}
              accessory={checks ? <StatusDot color={chipColor(checks, theme.colors)} /> : undefined}
            />
          ) : null}
          {pr.reviewDecision ? <ListRow title="Review" value={REVIEW_NAME[pr.reviewDecision]} /> : null}
        </ListSection>
      ) : null}
      {pr ? (
        <>
          <Button title="Open in GitHub" onPress={() => void Linking.openURL(pr.url)} />
          {Number.isFinite(checkedAt) ? (
            <Text variant="footnote" tone="tertiary" style={styles.center}>
              {`Checked ${shortDuration(Math.max(0, now - checkedAt))} ago`}
            </Text>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { padding: theme.space.xxl, paddingTop: theme.space.xxxl, gap: theme.space.xl, paddingBottom: 48 },
  titles: { gap: theme.space.xxs },
  pr: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm },
  center: { textAlign: 'center' },
}));
