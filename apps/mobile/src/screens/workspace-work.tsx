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
import { archivedPage } from '@/lib/archived-page';
import { formatDuration } from '@/intl/format';
import { agentWebUrl } from '@/lib/agents';
import { checksSummary, checksTone } from '@/lib/workspace-view';
import { worktreeApps, worktreeSessions } from '@/lib/worktree-page';
import { workspaceTitleAt } from '@/lib/workspace-names';
import { pullRequestStateName, pullRequestReviewName } from '@/lib/format';

const commits = (n: number) => plural(n, { one: '# commit', other: '# commits' });
const files = (n: number) => plural(n, { one: '# file', other: '# files' });

export function WorkspaceWork({ path, archive: archiveId }: { path: string; archive?: string }) {
  const { theme } = useUnistyles();
  const status = useStatus();
  const router = useRouter();
  const { mac, state } = useMacConnection();
  const canDiff = !archiveId && state.kind === 'open' && state.features.includes('workspace-diff');
  const openDiff = (group: 'changed' | 'untracked') =>
    router.push({ pathname: '/mac/[id]/diff', params: { id: mac?.id ?? '', path, group } });
  const now = useNow(30_000);
  const archive = status?.archived?.find((entry) => entry.id === archiveId);
  const page = archive ? archivedPage(archive, null, now) : null;
  const env = archiveId ? page?.env : status?.environments.find((e) => e.path === path);
  const worktree = env?.worktree;
  const git = worktree?.git;
  const pr = archive?.worktree.pullRequest ?? worktree?.pullRequest;
  const sessions = page
    ? page.sessions.map((session) => session.agent)
    : archiveId
      ? []
      : worktreeSessions(worktreeApps(path, status?.environments ?? []));
  const onlyAgentHasLink = sessions.length === 1 && agentWebUrl(sessions[0]!) !== null;
  const livePr = archiveId ? null : worktree?.pullRequest;
  const checks = livePr ? checksTone(livePr.checks) : null;
  const checkedAt = livePr ? Date.parse(livePr.checkedAt) : NaN;
  const sinceChecked = formatDuration(Math.max(0, now - checkedAt));
  return (
    <SheetScreen
      title={page?.title ?? worktree?.branch ?? workspaceTitleAt(path, status)}
      titleLines={2}
      subtitle={t`Work`}
    >
      {sessions.length ? (
        <ListSection
          title={plural(sessions.length, { one: 'Agent session', other: 'Agent sessions' })}
          bare={onlyAgentHasLink}
        >
          {sessions.map((agent) => {
            const durationMs = page?.sessions.find((session) => session.agent === agent)?.durationMs;
            const duration = durationMs == null ? null : formatDuration(durationMs);
            return (
              <View key={`${agent.tool}:${agent.sessionId}`}>
                <AgentSessionRow agent={agent} card={onlyAgentHasLink} />
                {page ? (
                  <Text variant="footnote" tone="tertiary" style={styles.session}>
                    {duration === null ? t`Ended session` : t`Ended session, ${duration} duration`}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </ListSection>
      ) : null}
      {archive ? (
        <ListSection title={t`Git`}>
          <ListRow title={t`Branch`} value={archive.worktree.branch ?? page?.title} />
          {archive.worktree.head ? (
            <ListRow
              title={t`Final commit`}
              value={archive.worktree.head.slice(0, 8)}
              subtitle={archive.worktree.subject ?? undefined}
            />
          ) : null}
        </ListSection>
      ) : git ? (
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
          {archiveId ? (
            page?.merged ? (
              <ListRow title={t`State`} value={t`Merged`} />
            ) : null
          ) : (
            <ListRow title={t`State`} value={pullRequestStateName(pr.state)} />
          )}
          {livePr?.checks ? (
            <ListRow
              title={t`Checks`}
              value={checksSummary(livePr.checks) ?? undefined}
              accessory={checks ? <StatusDot color={toneColor(theme, checks)} /> : undefined}
            />
          ) : null}
          {livePr?.reviewDecision ? (
            <ListRow title={t`Review`} value={pullRequestReviewName(livePr.reviewDecision)} />
          ) : null}
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
  session: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm },
  pr: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm },
  center: { textAlign: 'center' },
}));
