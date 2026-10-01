import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Fragment, memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentSessionLine } from '@/components/agent-sessions';
import { PhaseBar } from '@/components/build-progress';
import { Icon } from '@/components/icon';
import { Pill, StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { toneColor } from '@/design/tone';
import { useMachinePresence } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { workspaceAgentSessions } from '@/lib/agents';
import { buildKey, buildTiming, outcomeLabel } from '@/lib/format';
import type { HomeItem } from '@/lib/home';
import { rowDevices, rowLabel, rowProblems, rowStatus, warmStepText } from '@/lib/home-list';
import { barSteps, currentPhaseLabel, gitChip, phaseSteps } from '@/lib/workspace-view';
import { isSettingUp, isShownLive, runningBuild } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState } from '@/protocol/types';

const SEPARATOR = '\u00B7';

export const WorkspaceRow = memo(function WorkspaceRow({
  item,
  now,
  folder,
  showsMachine,
  onOpen,
}: {
  item: HomeItem;
  now: number;
  /** Whether to name the folder in the checkout, when the repo's workspaces sit in different ones. */
  folder: boolean;
  /** Whether to name the machine, when more than one is paired. */
  showsMachine: boolean;
  onOpen: (item: HomeItem, errors: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const { online, cached, lastSeenAt } = useMachinePresence(item.macId);
  const offline = !online || cached;
  const at = offline ? (lastSeenAt ?? now) : now;
  const { env } = item;
  const status = rowStatus(env, now, offline ? { lastSeenAt } : null);
  const problems = rowProblems(env, at);
  const devices = rowDevices(env, at);
  const sessions = workspaceAgentSessions(env);
  const build = runningBuild(env);
  const git = gitChip(env.worktree);
  const live = isShownLive(env);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const color = toneColor(theme, offline ? 'tertiary' : status.tone);

  const context: ReactNode[] = [];
  if (showsMachine) {
    context.push(
      <View key="mac" style={styles.inline}>
        <Icon name="laptopcomputer" size={13} color={offline ? theme.colors.tertiary : theme.colors.success} />
        <Text variant="footnote" tone="secondary" numberOfLines={1}>
          {item.macName}
        </Text>
      </View>,
    );
  }
  if (devices.names) {
    context.push(
      <Text key="devices" variant="footnote" tone="secondary">
        {devices.names}
      </Text>,
    );
  }
  if (devices.drivers) {
    context.push(
      <View key="drivers" style={styles.inline}>
        <StatusDot color={offline ? theme.colors.tertiary : theme.colors.primary} />
        <Text variant="footnote" weight="medium" tone={offline ? 'tertiary' : 'brand'}>
          {devices.drivers}
        </Text>
      </View>,
    );
  }
  if (devices.idle) {
    context.push(
      <Text key="idle" variant="footnote" tone="tertiary">
        {devices.idle.text}
      </Text>,
    );
  }
  if (devices.remote) {
    context.push(
      <Text key="remote" variant="footnote" tone={offline ? 'tertiary' : 'info'}>
        <Trans>EAS session</Trans>
      </Text>,
    );
  }

  const gitParts: ReactNode[] = [];
  if (folder && item.inCheckout) {
    gitParts.push(
      <Text
        key="folder"
        variant="footnote"
        tone="tertiary"
        numberOfLines={1}
        ellipsizeMode="middle"
        style={styles.shrink}
      >
        {item.inCheckout}
      </Text>,
    );
  }
  if (git?.pr) {
    gitParts.push(
      <Text key="pr" variant="footnote" weight="medium" tone={git.pr.tone}>
        {git.pr.text}
      </Text>,
    );
  }
  for (const part of git?.parts ?? []) {
    gitParts.push(
      <Text
        key={part.text}
        variant="footnote"
        tone={part.tone === 'default' ? 'secondary' : part.tone}
        numberOfLines={1}
        style={styles.tabular}
      >
        {part.text}
      </Text>,
    );
  }

  return (
    <Touch
      feedback="row"
      onPress={() => onOpen(item, false)}
      accessibilityLabel={rowLabel({ item, now: at, status, problems, sessions, folder, showsMachine })}
      accessibilityHint={t`Opens the workspace`}
      accessibilityActions={errors > 0 ? [{ name: 'errors', label: t`Show errors` }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'errors') onOpen(item, true);
      }}
      style={styles.row}
    >
      <View style={[styles.lead, offline && styles.dimmed]}>
        <View style={[styles.dot, { borderColor: color, backgroundColor: live && !offline ? color : 'transparent' }]} />
      </View>
      <View style={[styles.body, offline && styles.dimmed]}>
        <View style={styles.titleLine}>
          <Text
            variant="headline"
            weight="medium"
            tone={live ? 'default' : 'secondary'}
            numberOfLines={1}
            ellipsizeMode="middle"
            style={styles.title}
          >
            {item.title}
          </Text>
          <Text variant="callout" weight="medium" tone={offline ? 'tertiary' : status.tone} numberOfLines={1}>
            {status.text}
          </Text>
        </View>
        {sessions.length ? <AgentSessionLine sessions={sessions} variant="callout" tone="secondary" /> : null}
        {problems.length ? (
          <View style={styles.pills}>
            {problems.map((problem) => (
              <Pill
                key={`${problem.kind}:${problem.text}`}
                tone={offline ? 'neutral' : problem.tone}
                onPress={problem.kind === 'errors' ? () => onOpen(item, true) : undefined}
              >
                {problem.text}
              </Pill>
            ))}
          </View>
        ) : null}
        {build && offline ? <RowBuild env={env} build={build} now={at} /> : null}
        {build && !offline ? <TickingRowBuild env={env} build={build} /> : null}
        {isSettingUp(env) && env.phase === 'warming' ? (
          <Text variant="footnote" tone="secondary">
            {warmStepText(env)}
          </Text>
        ) : null}
        {context.length ? <Line parts={context} /> : null}
        {gitParts.length ? <Line parts={gitParts} /> : null}
      </View>
    </Touch>
  );
});

function Line({ parts }: { parts: ReactNode[] }) {
  return (
    <View style={styles.line}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <Text variant="footnote" tone="tertiary">
              {SEPARATOR}
            </Text>
          ) : null}
          {part}
        </Fragment>
      ))}
    </View>
  );
}

function TickingRowBuild({ env, build }: { env: EnvironmentState; build: BuildReport }) {
  const now = useNow(1000);
  return <RowBuild env={env} build={build} now={now} />;
}

function RowBuild({ env, build, now }: { env: EnvironmentState; build: BuildReport; now: number }) {
  const steps = barSteps(phaseSteps(build, env.builds?.[build.platform] ?? [], now));
  const { elapsed, estimate } = buildTiming(build, now);
  const { phase, counts } = currentPhaseLabel(build);
  const outcome = outcomeLabel(build);
  return (
    <View style={styles.build}>
      <View style={styles.inline}>
        <Text variant="footnote" weight="semibold" tone="brand">
          {phase}
        </Text>
        {counts ? (
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={[styles.shrink, styles.tabular]}>
            {counts}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        {outcome ? (
          <Text
            variant="footnote"
            tone={build.outcome === 'hit' ? 'success' : 'warning'}
            numberOfLines={1}
            style={styles.outcome}
          >
            {outcome}
          </Text>
        ) : null}
        <Text variant="footnote" style={styles.tabular}>
          {elapsed}
        </Text>
        {estimate ? (
          <Text variant="footnote" tone="tertiary" style={styles.tabular}>
            {` / ${estimate}`}
          </Text>
        ) : null}
      </View>
      <PhaseBar steps={steps} buildId={buildKey(build)} names={false} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.xxl,
    paddingVertical: theme.space.xl,
  },
  lead: { width: 12, alignItems: 'center', paddingTop: theme.space.sm },
  dot: { width: 11, height: 11, borderRadius: theme.radius.round, borderWidth: 2 },
  body: { flex: 1, gap: theme.space.sm },
  dimmed: { opacity: 0.5 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.md },
  title: { flex: 1 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  build: { gap: theme.space.sm, paddingVertical: theme.space.xxs },
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.sm, rowGap: 2 },
  shrink: { flexShrink: 1 },
  spacer: { flex: 1 },
  outcome: { marginRight: theme.space.sm },
  tabular: { fontVariant: ['tabular-nums'] },
}));
