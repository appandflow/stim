import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentSessionRow } from '@/components/agent-sessions';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list';
import { StatusDot } from '@/components/pill';
import { SheetScreen } from '@/components/sheet-screen';
import { Text } from '@/components/text';
import { toneColor } from '@/design/tone';
import { useMacConnection, useStatus } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { formatDuration } from '@/intl/format';
import { agentWebUrl, workspaceAgentSessions } from '@/lib/agents';
import { checksSummary, checksTone } from '@/lib/workspace-view';
import { workspaceTitleAt } from '@/lib/workspace-names';
import { pullRequestStateName, pullRequestReviewName } from '@/lib/format';

const commits = (n: number) => plural(n, { one: '# commit', other: '# commits' });
const files = (n: number) => plural(n, { one: '# file', other: '# files' });

export function WorkspaceWork({ path }: { path: string }) {
  const { theme } = useUnistyles();
  const status = useStatus();
  const router = useRouter();
  const { mac, state } = useMacConnection();
  const canDiff = state.kind === 'open' && state.features.includes('workspace-diff');
  const openDiff = (group: 'changed' | 'untracked') =>
    router.push({ pathname: '/mac/[id]/diff', params: { id: mac?.id ?? '', path, group } });
  const now = useNow(30_000);
  const env = status?.environments.find((e) => e.path === path);
  const worktree = env?.worktree;
  const git = worktree?.git;
  const pr = worktree?.pullRequest;
  const sessions = env ? workspaceAgentSessions(env) : [];
  const onlyAgentHasLink = sessions.length === 1 && agentWebUrl(sessions[0]!) !== null;
  const checks = pr ? checksTone(pr.checks) : null;
  const checkedAt = pr ? Date.parse(pr.checkedAt) : NaN;
  const sinceChecked = formatDuration(Math.max(0, now - checkedAt));
  return (
    <SheetScreen title={worktree?.branch ?? workspaceTitleAt(path, status)} titleLines={2} subtitle={t`Work`}>
      {sessions.length ? (
        <ListSection
          title={plural(sessions.length, { one: 'Agent session', other: 'Agent sessions' })}
          bare={onlyAgentHasLink}
        >
          {sessions.map((agent) => (
            <AgentSessionRow key={`${agent.tool}:${agent.sessionId}`} agent={agent} card={onlyAgentHasLink} />
          ))}
        </ListSection>
      ) : null}
      {git ? (
        <ListSection title={t`Git`}>
          <ListRow
            title={t`Upstream`}
            value={git.upstream ?? t`None`}
            valueTone={git.upstream ? 'default' : 'tertiary'}
          />
          <ListRow title={t`Ahead`} value={git.ahead === null ? '\u2014' : commits(git.ahead)} />
          <ListRow title={t`Behind`} value={git.behind === null ? '\u2014' : commits(git.behind)} />
          <ListRow
            title={t`Changed`}
            value={files(git.changed)}
            valueTone={git.changed ? 'warning' : 'default'}
            accessory={canDiff ? 'chevron' : undefined}
            onPress={canDiff ? () => openDiff('changed') : undefined}
          />
          <ListRow
            title={t`Untracked`}
            value={files(git.untracked)}
            valueTone={git.untracked ? 'warning' : 'default'}
            accessory={canDiff ? 'chevron' : undefined}
            onPress={canDiff ? () => openDiff('untracked') : undefined}
          />
          {git.mergedInto ? <ListRow title={t`Merged into`} value={git.mergedInto} valueTone="brand" /> : null}
        </ListSection>
      ) : (
        <Text variant="footnote" tone="secondary">
          <Trans>Stim reports no git state for this workspace.</Trans>
        </Text>
      )}
      {pr ? (
        <ListSection title={t`Pull request`}>
          <View style={styles.pr}>
            <Text variant="callout" weight="semibold">
              {`#${pr.number} ${pr.title}`}
            </Text>
          </View>
          <ListRow title={t`State`} value={pullRequestStateName(pr.state)} />
          {pr.checks ? (
            <ListRow
              title={t`Checks`}
              value={checksSummary(pr.checks) ?? undefined}
              accessory={checks ? <StatusDot color={toneColor(theme, checks)} /> : undefined}
            />
          ) : null}
          {pr.reviewDecision ? <ListRow title={t`Review`} value={pullRequestReviewName(pr.reviewDecision)} /> : null}
        </ListSection>
      ) : null}
      {pr ? (
        <>
          <Button title={t`Open in GitHub`} onPress={() => void Linking.openURL(pr.url)} />
          {Number.isFinite(checkedAt) ? (
            <Text variant="footnote" tone="tertiary" style={styles.center}>
              {t`Checked ${sinceChecked} ago`}
            </Text>
          ) : null}
        </>
      ) : null}
    </SheetScreen>
  );
}

const styles = StyleSheet.create((theme) => ({
  pr: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm },
  center: { textAlign: 'center' },
}));
