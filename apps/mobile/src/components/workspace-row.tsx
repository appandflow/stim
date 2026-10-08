import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Fragment, memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentSessionLine } from '@/components/agent-sessions';
import { PhaseBar } from '@/components/build-progress';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { toneColor } from '@/design/tone';
import { useLargeText } from '@/hooks/large-text';
import { useMachinePresence } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { workspaceAgentSessions } from '@/lib/agents';
import { buildKey, buildTiming, outcomeLabel } from '@/lib/format';
import { archivedPage } from '@/lib/archived-page';
import type { HomeArchive, HomeItem, HomeWorktree } from '@/lib/home';
import {
  offlineRowStatus,
  rowDevices,
  rowLabel,
  rowProblems,
  rowStatus,
  warmStepText,
  type HomeWorkspace,
} from '@/lib/home-list';
import { worktreeRowLabel, worktreeRowSummary, type PlatformState } from '@/lib/worktree-row';
import { barSteps, currentPhaseLabel, gitChip, phaseSteps } from '@/lib/workspace-view';
import { isSettingUp, isShownLive, platformName, runningBuild } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState, WorktreeFacts } from '@/protocol/types';

const SEPARATOR = '\u00B7';

const PLATFORM_TONE = {
  building: 'brand',
  failed: 'error',
  running: 'success',
  idle: 'tertiary',
} as const;

function platformDotStyle(theme: Parameters<typeof toneColor>[0], platform: PlatformState, offline: boolean) {
  const color = toneColor(theme, offline ? 'tertiary' : PLATFORM_TONE[platform.kind]);
  return {
    borderColor: color,
    backgroundColor: platform.kind === 'idle' || offline ? 'transparent' : color,
  };
}

export const WorkspaceGroupRow = memo(function WorkspaceGroupRow({
  workspace,
  ...props
}: {
  workspace: HomeWorkspace;
  now: number;
  folder: boolean;
  showsMachine: boolean;
  onOpen: (item: HomeItem | HomeArchive, errors: boolean, checkout?: boolean) => void;
}) {
  if (workspace.apps.length === 1) return <WorkspaceRow item={workspace.apps[0]} {...props} />;
  if ('archive' in workspace.apps[0]) {
    return (
      <>
        {workspace.apps.map((item) => (
          <WorkspaceRow key={item.key} item={item} title={item.inCheckout ?? item.title} {...props} />
        ))}
      </>
    );
  }
  return <WorkspaceRow item={workspace.apps[0]} apps={workspace.apps} title={workspace.title} {...props} />;
});

const WorkspaceRow = memo(function WorkspaceRow({
  item,
  now,
  folder,
  showsMachine,
  onOpen,
  apps,
  title: groupTitle,
}: {
  item: HomeItem | HomeArchive;
  /** Every app of a worktree with more than one, which the row summarizes. */
  apps?: (HomeItem | HomeArchive)[];
  title?: string;
  now: number;
  /** Whether to name the folder in the checkout, when the repo's workspaces sit in different ones. */
  folder: boolean;
  /** Whether to name the machine, when more than one is paired. */
  showsMachine: boolean;
  onOpen: (item: HomeItem | HomeArchive, errors: boolean, checkout?: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const large = useLargeText();
  const lines = large ? 3 : 1;
  const { online, cached, lastSeenAt } = useMachinePresence(item.macId);
  const offline = !online || cached;
  const at = offline ? (lastSeenAt ?? now) : now;
  const summary = apps && !('archive' in item) ? worktreeRowSummary(apps, at, offline ? { lastSeenAt } : null) : null;
  const shown = summary?.lead ?? item;
  const { env } = shown;
  const archive = 'archive' in item ? archivedPage(item.archive, null, now) : null;
  const expiry = archive?.retention.filter((part) => part.kind === 'logs' || part.kind === 'recordings');
  const expiryLabel = expiry?.some((part) => part.expired)
    ? t`Expired content`
    : expiry?.some((part) => part.soon)
      ? t`Expires soon`
      : null;
  const status = summary?.status ?? rowStatus(env, now, offline ? { lastSeenAt } : null);
  const problems = summary?.problems ?? rowProblems(env, at);
  const devices = rowDevices(env, at);
  const sessions = summary?.sessions ?? workspaceAgentSessions(env);
  const build = runningBuild(env);
  const title = groupTitle ?? item.title;
  const live = apps ? apps.some((app) => isShownLive(app.env)) : isShownLive(env);
  const errorApp = apps?.find((app) => (app.env.logs?.errorsSinceMarker ?? 0) > 0) ?? shown;
  const errors = errorApp.env.logs?.errorsSinceMarker ?? 0;
  const color = toneColor(theme, offline ? 'tertiary' : status.tone);

  const context: ReactNode[] = [];
  if (showsMachine) {
    context.push(
      <View key="mac" style={styles.inline}>
        <Icon name="laptopcomputer" size={13} color={offline ? theme.colors.tertiary : theme.colors.success} />
        <Text variant="footnote" tone="secondary" numberOfLines={lines}>
          {item.macName}
        </Text>
      </View>,
    );
  }
  if (summary?.platforms.length) {
    context.push(
      <View key="platforms" style={styles.platforms}>
        {summary.platforms.map((platform) => (
          <View key={platform.platform} style={styles.inline}>
            <View style={[styles.platformDot, platformDotStyle(theme, platform, offline)]} />
            <Text variant="footnote" tone="secondary">
              {platformName(platform.platform)}
            </Text>
          </View>
        ))}
      </View>,
    );
  }
  if (devices.names && !summary) {
    context.push(
      <Text key="devices" variant="footnote" tone="secondary">
        {devices.names}
      </Text>,
    );
  }
  const drivers = summary ? summary.drivers.map((tool) => tool || t`unknown tool`).join(', ') : devices.drivers;
  if (drivers) {
    context.push(
      <View key="drivers" style={styles.inline}>
        <Icon name="cursorarrow.rays" size={13} color={offline ? theme.colors.tertiary : theme.colors.primary} />
        <Text variant="footnote" weight="medium" tone={offline ? 'tertiary' : 'brand'}>
          {drivers}
        </Text>
      </View>,
    );
  }
  if (devices.idle && !summary) {
    context.push(
      <Text key="idle" variant="footnote" tone="tertiary">
        {devices.idle.text}
      </Text>,
    );
  }
  const remote = summary?.remote ?? devices.remote;
  if (remote) {
    context.push(
      <Text key="remote" variant="footnote" tone={offline ? 'tertiary' : 'info'}>
        <Trans>EAS session</Trans>
      </Text>,
    );
  }

  return (
    <Touch
      feedback="row"
      onPress={() => (apps ? onOpen(shown, false, true) : onOpen(shown, false))}
      accessibilityLabel={
        summary
          ? worktreeRowLabel(title, summary, showsMachine ? item.macName : null)
          : archive
            ? [title, archive.prLabel, archive.removed, archive.size, expiryLabel, showsMachine ? item.macName : null]
                .filter(Boolean)
                .join(', ')
            : rowLabel({
                item: { ...item, title },
                now: at,
                status,
                problems,
                sessions,
                folder: !apps && folder,
                showsMachine,
              })
      }
      accessibilityHint={apps ? t`Opens every app in this checkout` : t`Opens the workspace`}
      accessibilityActions={!archive && errors > 0 ? [{ name: 'errors', label: t`Show errors` }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'errors') onOpen(errorApp, true);
      }}
      style={styles.row}
    >
      <View style={[styles.lead, offline && styles.dimmed]}>
        <View
          style={[
            styles.dot,
            {
              borderColor: color,
              backgroundColor: live && !offline ? color : 'transparent',
            },
          ]}
        />
      </View>
      <View style={[styles.body, offline && styles.dimmed]}>
        <View style={[styles.titleLine, large && styles.titleLineStacked]}>
          <Text
            variant="headline"
            weight="medium"
            tone={live ? 'default' : 'secondary'}
            numberOfLines={lines}
            ellipsizeMode={lines > 1 ? 'tail' : 'middle'}
            style={styles.title}
          >
            {title}
          </Text>
          <Text variant="callout" weight="medium" tone={offline ? 'tertiary' : status.tone} numberOfLines={1}>
            {archive ? t`Archived` : status.text}
          </Text>
        </View>
        {archive ? (
          <Text variant="footnote" tone="secondary">
            {[archive.removed, archive.size].join(' \u00B7 ')}
          </Text>
        ) : null}
        {expiryLabel ? (
          <Text variant="caption2" tone="warning">
            {expiryLabel}
          </Text>
        ) : null}
        {!archive && sessions.length ? (
          <AgentSessionLine sessions={sessions} variant="callout" tone="secondary" />
        ) : null}
        {!archive && problems.length ? (
          <View style={styles.pills}>
            {problems.map((problem) => (
              <Pill
                key={`${problem.kind}:${problem.text}`}
                tone={offline ? 'neutral' : problem.tone}
                onPress={problem.kind === 'errors' ? () => onOpen(errorApp, true) : undefined}
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
        <GitLine
          facts={env.worktree}
          archive={archive}
          folder={!apps && (archive || folder) ? item.inCheckout : null}
        />
      </View>
    </Touch>
  );
});

export const WorktreeRow = memo(function WorktreeRow({
  item,
  now,
  showsMachine,
}: {
  item: HomeWorktree;
  now: number;
  showsMachine: boolean;
}) {
  const { theme } = useUnistyles();
  const large = useLargeText();
  const lines = large ? 3 : 1;
  const { online, cached, lastSeenAt } = useMachinePresence(item.macId);
  const offline = !online || cached;
  const status = offlineRowStatus(now, offline ? { lastSeenAt } : null);
  const notWarmed = t`Not warmed`;
  return (
    <View
      accessible
      accessibilityLabel={[
        item.title,
        notWarmed,
        status?.label,
        gitChip(item.facts)?.label,
        showsMachine ? item.macName : null,
      ]
        .filter(Boolean)
        .join(', ')}
      style={[styles.row, offline && styles.dimmed]}
    >
      <View style={styles.lead}>
        <View
          style={[
            styles.dot,
            {
              borderColor: theme.colors.tertiary,
              backgroundColor: 'transparent',
            },
          ]}
        />
      </View>
      <View style={styles.body}>
        <View style={[styles.titleLine, large && styles.titleLineStacked]}>
          <Text
            variant="headline"
            weight="medium"
            tone="secondary"
            numberOfLines={lines}
            ellipsizeMode={lines > 1 ? 'tail' : 'middle'}
            style={styles.title}
          >
            {item.title}
          </Text>
          <Text variant="callout" weight="medium" tone="tertiary" numberOfLines={1}>
            {status?.text ?? notWarmed}
          </Text>
        </View>
        {showsMachine ? (
          <View style={styles.inline}>
            <Icon name="laptopcomputer" size={13} color={offline ? theme.colors.tertiary : theme.colors.success} />
            <Text variant="footnote" tone="secondary" numberOfLines={lines}>
              {item.macName}
            </Text>
          </View>
        ) : null}
        <GitLine facts={item.facts} />
      </View>
    </View>
  );
});

function GitLine({
  facts,
  folder,
  archive,
}: {
  facts: WorktreeFacts | null | undefined;
  folder?: string | null;
  archive?: ReturnType<typeof archivedPage> | null;
}) {
  const large = useLargeText();
  const lines = large ? 3 : 1;
  const git = archive ? archive.git : gitChip(facts);
  const gitParts: ReactNode[] = [];
  if (folder) {
    gitParts.push(
      <Text
        key="folder"
        variant="footnote"
        tone="tertiary"
        numberOfLines={lines}
        ellipsizeMode={lines > 1 ? 'tail' : 'middle'}
        style={styles.shrink}
      >
        {folder}
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
  for (const part of archive ? [] : (git?.parts ?? [])) {
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

  return gitParts.length ? <Line parts={gitParts} /> : null;
}

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
      <View style={styles.buildLine}>
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
  dot: {
    width: 11,
    height: 11,
    borderRadius: theme.radius.round,
    borderWidth: 2,
  },
  body: { flex: 1, gap: theme.space.sm },
  dimmed: { opacity: 0.5 },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.md,
  },
  title: { flex: 1 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  build: { gap: theme.space.sm, paddingVertical: theme.space.xxs },
  titleLineStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.space.xs,
  },
  buildLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.xs,
  },
  platforms: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.md,
  },
  platformDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.round,
    borderWidth: 1.5,
  },
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.sm,
    rowGap: 2,
  },
  shrink: { flexShrink: 1 },
  spacer: { flex: 1 },
  outcome: { marginRight: theme.space.sm },
  tabular: { fontVariant: ['tabular-nums'] },
}));
