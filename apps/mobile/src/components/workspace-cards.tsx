import { plural, t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentSessionLine } from '@/components/agent-sessions';
import { PhaseBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { StatusDot } from '@/components/pill';
import { PlatformGlyph } from '@/components/platform-glyph';
import { StatRow } from '@/components/stat-row';
import { Text, type TextTone } from '@/components/text';
import type { TextVariant } from '@/design/tokens';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useBuildOutput } from '@/hooks/workspace-logs';
import { useNow } from '@/hooks/use-now';
import { formatDuration } from '@/intl/format';
import { agentLabel } from '@/lib/agents';
import { buildKey, buildTiming, macosBuildLabel, recheckNote } from '@/lib/format';
import {
  barSteps,
  currentPhaseLabel,
  otherPlatformLine,
  phaseSteps,
  remoteBuild,
  type BuildLine,
  type BundleLine,
  type GitChip,
  type MetroHealth,
  type Usage,
  type WorkspaceStage,
  usageLabel,
  usageParts,
} from '@/lib/workspace-view';
import { platformName } from '@/lib/workspaces';
import type { AgentSession, BuildReport, EnvironmentState, MacosAppState, DevicePlatform } from '@/protocol/types';

const STACK_FONT_SCALE = 1.3;
const CardColumns = createContext(2);
const VALUE: TextVariant = 'caption';
const VALUE_WEIGHT = 'medium';

function SmallCard({
  title,
  alert,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  children,
}: {
  title: string;
  alert?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint: string;
  children: ReactNode;
}) {
  const { theme } = useUnistyles();
  const columns = useContext(CardColumns);
  return (
    <Card
      key={columns}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={[styles.small, { flexBasis: columns === 4 ? '20%' : '40%' }, alert && styles.alert]}
    >
      <View style={styles.smallHeader}>
        <Text variant="caption2" weight="semibold" tone="secondary" style={styles.caps} numberOfLines={1}>
          {title}
        </Text>
        <Icon name="chevron.right" size={11} color={theme.colors.tertiary} />
      </View>
      {children}
    </Card>
  );
}

export function MacosBuildCard({ app, onPress }: { app: MacosAppState; onPress: () => void }) {
  const state = macosBuildLabel(app);
  return (
    <SmallCard
      title={t`Build`}
      alert={app.build.state === 'failed'}
      onPress={onPress}
      accessibilityLabel={t`macOS build: ${state}`}
      accessibilityHint={t`Opens build logs`}
    >
      <Text variant={VALUE} weight={VALUE_WEIGHT} numberOfLines={1}>
        {app.product}
      </Text>
      <Text variant={VALUE} tone={app.build.state === 'failed' ? 'error' : 'secondary'}>
        {state}
      </Text>
      {app.build.durationMs !== undefined ? (
        <Text variant={VALUE} tone="tertiary">
          {formatDuration(app.build.durationMs)}
        </Text>
      ) : null}
      {app.build.error ? (
        <Text variant={VALUE} tone="error" numberOfLines={2}>
          {app.build.error}
        </Text>
      ) : null}
    </SmallCard>
  );
}

export function StatusCard({ stage, usage, onPress }: { stage: WorkspaceStage; usage: Usage; onPress: () => void }) {
  const parts = usageParts(usage);
  const note = stage.kind === 'building' ? null : stage.subtitle;
  return (
    <SmallCard
      title={t`Status`}
      alert={stage.tone === 'error' && stage.kind !== 'build-failed'}
      onPress={onPress}
      accessibilityLabel={[t`Status`, stage.label, note, usageLabel(usage) || t`resources not measured`]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={t`Shows the status and what this workspace uses`}
    >
      <Text variant={VALUE} weight="semibold" tone={stage.tone} numberOfLines={1}>
        {stage.label}
        {note ? (
          <Text variant={VALUE} weight="regular" tone="secondary">
            {` \u00B7 ${note}`}
          </Text>
        ) : null}
      </Text>
      {parts.length ? (
        <StatRow wrap gap="sm" stats={parts} />
      ) : (
        <Text variant={VALUE} tone="tertiary">
          <Trans>Not measured</Trans>
        </Text>
      )}
    </SmallCard>
  );
}

const LINE_TONE: Record<BuildLine['tone'], TextTone> = { default: 'default', error: 'error', secondary: 'secondary' };

export type BuildCardLine = Omit<BuildLine, 'platform'> & {
  platform: DevicePlatform;
  key?: string;
  project?: string | null;
};

export function BuildCard({ lines, onPress }: { lines: BuildCardLine[]; onPress: () => void }) {
  const spoken = lines.map((line) => line.spoken).join(', ');
  return (
    <SmallCard
      title={t`Build`}
      alert={lines.some((line) => line.tone === 'error')}
      onPress={onPress}
      accessibilityLabel={t`Build: ${spoken}`}
      accessibilityHint={t`Shows the builds`}
    >
      {lines.map((line) => {
        const row = (
          <View key={line.key ?? line.platform} style={styles.stat}>
            <View style={styles.glyphBox}>
              <PlatformGlyph platform={line.platform} size={line.platform === 'ios' ? 14 : 12} />
            </View>
            <Text
              variant={VALUE}
              weight={VALUE_WEIGHT}
              tone={LINE_TONE[line.tone]}
              numberOfLines={1}
              style={[styles.tabular, styles.shrink]}
            >
              {line.main}
              {line.sub ? (
                <Text variant="caption2" weight="regular" tone="tertiary">
                  {` ${line.sub}`}
                </Text>
              ) : null}
            </Text>
          </View>
        );
        return line.project ? (
          <View key={line.key ?? line.platform}>
            {row}
            <Text testID="project-subtitle" variant="caption2" tone="secondary">
              {line.project}
            </Text>
          </View>
        ) : (
          row
        );
      })}
    </SmallCard>
  );
}

function timingText(elapsed: string, estimate: string | null): string {
  return estimate ? t`${elapsed} of ${estimate}` : elapsed;
}

function healthLabel(health: MetroHealth): string {
  switch (health) {
    case 'healthy':
      return t`healthy`;
    case 'unhealthy':
      return t`unhealthy`;
    case 'stopped':
      return t`stopped`;
  }
}

function healthColor(health: MetroHealth, colors: Theme['colors']): string {
  return health === 'healthy' ? colors.success : health === 'unhealthy' ? colors.error : colors.tertiary;
}

export function LogsCard({
  errors,
  metro,
  bundle,
  onPress,
}: {
  errors: number | null;
  metro: MetroHealth | null;
  bundle: BundleLine | null;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const metroState = metro ? healthLabel(metro) : null;
  return (
    <SmallCard
      title={t`Logs`}
      alert={errors !== null && errors > 0}
      onPress={onPress}
      accessibilityLabel={[
        t`Logs`,
        errors === null ? null : plural(errors, { one: '# error', other: '# errors' }),
        metroState ? t`Metro ${metroState}` : null,
        bundle?.text,
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={t`Opens the logs`}
    >
      {errors === null && !metro ? (
        <Text variant={VALUE} tone="tertiary">
          <Trans>No logs yet</Trans>
        </Text>
      ) : null}
      {errors !== null ? (
        <Text variant={VALUE} weight={VALUE_WEIGHT} numberOfLines={1} style={styles.tabular}>
          {String(errors)}
          <Text variant={VALUE} weight="regular" tone="secondary">
            <Plural value={errors} one=" error" other=" errors" />
          </Text>
        </Text>
      ) : null}
      {metro ? (
        <View style={styles.stat}>
          <StatusDot color={healthColor(metro, theme.colors)} filled={metro !== 'stopped'} />
          <Text variant={VALUE} weight={VALUE_WEIGHT} numberOfLines={1} style={styles.shrink}>
            <Trans>Metro</Trans>
            {bundle ? (
              <Text
                variant={VALUE}
                weight="regular"
                tone={bundle.tone === 'error' ? 'error' : 'secondary'}
              >{` \u00B7 ${bundle.text}`}</Text>
            ) : null}
          </Text>
        </View>
      ) : null}
    </SmallCard>
  );
}

export function WorkCard({
  sessions,
  git,
  onPress,
}: {
  sessions: AgentSession[];
  git: GitChip | null;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const agent = sessions[0];
  const more = sessions.length - 1;
  return (
    <SmallCard
      title={t`Work`}
      onPress={onPress}
      accessibilityLabel={[
        t`Work`,
        agent ? agentLabel(agent) : t`No agent session`,
        more > 0 ? t`and ${more} more` : null,
        git?.label ?? t`no git state`,
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={t`Shows the agent sessions and the branch`}
    >
      {agent ? (
        <AgentSessionLine sessions={sessions} variant={VALUE} weight={VALUE_WEIGHT} />
      ) : (
        <Text variant={VALUE} tone="tertiary" numberOfLines={1}>
          <Trans>No agent session</Trans>
        </Text>
      )}
      {git ? (
        <View style={styles.gitLine}>
          {git.pr ? (
            <>
              <Text variant={VALUE} weight={VALUE_WEIGHT} tone={git.pr.tone} numberOfLines={1}>
                {git.pr.text}
              </Text>
              {git.pr.ci === 'failing' ? (
                <Text variant={VALUE} weight={VALUE_WEIGHT} tone="error" numberOfLines={1}>
                  <Trans>CI failing</Trans>
                </Text>
              ) : null}
            </>
          ) : (
            <Icon name="arrow.triangle.branch" size={12} color={theme.colors.secondary} />
          )}
          {git.parts.map((part) => (
            <Text
              key={part.text}
              variant={VALUE}
              tone={part.tone}
              numberOfLines={1}
              style={[styles.tabular, part.tone === 'default' ? null : styles.shrink]}
            >
              {part.text}
            </Text>
          ))}
          {!git.pr && git.parts.length === 0 ? (
            <Text variant={VALUE} tone="secondary">
              <Trans>Up to date</Trans>
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant={VALUE} tone="tertiary" numberOfLines={1}>
          <Trans>No git state</Trans>
        </Text>
      )}
    </SmallCard>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  const { theme } = useUnistyles();
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const columns = fontScale <= STACK_FONT_SCALE && width >= 4 * 200 + 3 * theme.space.md ? 4 : 2;
  return (
    <CardColumns.Provider value={columns}>
      <View
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        style={[styles.grid, fontScale > STACK_FONT_SCALE && styles.stacked]}
      >
        {children}
      </View>
    </CardColumns.Provider>
  );
}

export function BuildInProgressCard({
  env,
  build,
  target,
  onPress,
}: {
  env: EnvironmentState;
  build: BuildReport;
  target: string | null;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const now = useNow(1000);
  const steps = phaseSteps(build, env.builds?.[build.platform] ?? [], now);
  const { elapsed, estimate } = buildTiming(build, now);
  const { phase, counts } = currentPhaseLabel(build);
  const output = useBuildOutput(env.path, build.slot, build.detail?.line ? null : build.startedAt, 1);
  const line = build.detail?.line ?? output.at(-1)?.msg ?? null;
  const other = otherPlatformLine(env, build.platform, now);
  const miss = build.missReason?.summary;
  const recheck = recheckNote(build);
  const remote = remoteBuild(build, now);
  const detail = remote?.phaseElapsedMs != null ? formatDuration(remote.phaseElapsedMs, { seconds: true }) : counts;
  const name = platformName(build.platform);
  const host = remote?.host;
  const title = host ? t`Building ${name} on ${host}` : t`Building ${name}`;
  const phaseText = detail ? `${phase} ${detail}` : phase;
  const timing = timingText(elapsed, estimate);
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={t`${title}, ${phaseText}, ${timing}`}
      accessibilityHint={t`Shows the build`}
      style={styles.building}
    >
      <View style={styles.buildingHeader}>
        <PlatformGlyph
          platform={build.platform}
          size={15}
          color={theme.colors.primary}
          background={theme.colors.raised}
        />
        <Text variant="body" weight="semibold" numberOfLines={1} style={remote ? styles.shrink : undefined}>
          {title}
        </Text>
        {remote ? <Icon name="desktopcomputer" size={14} color={theme.colors.secondary} /> : null}
        {target && !remote ? (
          <Text variant="caption" tone="secondary" numberOfLines={1} style={styles.shrink}>
            {target}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        <Icon name="chevron.right" size={12} color={theme.colors.tertiary} />
      </View>
      <View style={styles.phaseLine}>
        <Text variant="footnote" weight="semibold" tone="brand">
          {phase}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={[styles.shrink, styles.tabular]}>
            {detail}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        <Text variant="footnote" style={styles.tabular}>
          {elapsed}
        </Text>
        {estimate ? (
          <Text variant="footnote" tone="tertiary" style={styles.tabular}>
            {` / ${estimate}`}
          </Text>
        ) : null}
      </View>
      <PhaseBar steps={barSteps(steps)} buildId={buildKey(build)} />
      {miss ? (
        <Text variant="caption" tone="secondary">
          {t`Cache miss: ${miss}`}
        </Text>
      ) : null}
      {recheck ? (
        <Text variant="caption" tone="tertiary">
          {recheck}
        </Text>
      ) : null}
      {other ? (
        <Text variant="caption" tone="tertiary">
          {other}
        </Text>
      ) : null}
      {line ? (
        <Text variant="caption2" tone="tertiary" mono numberOfLines={1}>
          {line}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  shrink: { flexShrink: 1 },
  spacer: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  caps: { textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md },
  stacked: { flexDirection: 'column', flexWrap: 'nowrap' },
  small: { flexGrow: 1, padding: theme.space.md + 2, gap: theme.space.xs },
  gitLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.xs + 1, rowGap: 2 },
  alert: {
    borderColor: withAlpha(theme.colors.error, 0.45),
    backgroundColor: withAlpha(theme.colors.error, 0.06),
  },
  smallHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.xs },
  stat: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs + 1 },
  glyphBox: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  building: {
    padding: theme.space.lg,
    gap: theme.space.md,
    borderColor: withAlpha(theme.colors.primary, 0.3),
    backgroundColor: withAlpha(theme.colors.primary, 0.05),
  },
  buildingHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  phaseLine: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.sm },
}));
