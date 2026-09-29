import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentSessionLine } from '@/components/agent-sessions';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { STAT_ICON } from '@/components/machine-stats';
import { StatusDot } from '@/components/pill';
import { PlatformGlyph } from '@/components/platform-glyph';
import { Text, type TextTone } from '@/components/text';
import type { TextVariant } from '@/design/tokens';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useBuildOutput } from '@/hooks/workspace-logs';
import { useNow } from '@/hooks/use-now';
import { agentLabel } from '@/lib/agents';
import { buildProgress, clockDuration } from '@/lib/format';
import { formatBytes } from '@/lib/home';
import {
  barSteps,
  currentPhaseLabel,
  formatCpu,
  formatMemoryMb,
  namesPhases,
  otherPlatformLine,
  phaseName,
  phaseSteps,
  type BuildLine,
  type BundleLine,
  type ChipTone,
  type GitChip,
  type MetroHealth,
  type PhaseStep,
  type Usage,
  type WorkspaceStage,
} from '@/lib/workspace-view';
import { platformName } from '@/lib/workspaces';
import type { AgentSession, BuildReport, EnvironmentState } from '@/protocol/types';

const CHIP_TONE: Record<ChipTone, TextTone> = {
  default: 'default',
  secondary: 'secondary',
  tertiary: 'tertiary',
  success: 'success',
  warning: 'warning',
  error: 'error',
  brand: 'brand',
};

export function chipColor(tone: ChipTone, colors: Theme['colors']): string {
  if (tone === 'default') return colors.text;
  return tone === 'brand' ? colors.primary : colors[tone];
}

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
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={[styles.small, alert && styles.alert]}
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

const usageParts = (usage: Usage) =>
  [
    usage.cpuPercent === null ? null : { kind: 'cpu' as const, value: formatCpu(usage.cpuPercent), label: 'CPU' },
    usage.memoryMb === null
      ? null
      : { kind: 'memory' as const, value: formatMemoryMb(usage.memoryMb), label: 'memory' },
    usage.diskBytes === null ? null : { kind: 'disk' as const, value: formatBytes(usage.diskBytes), label: 'disk' },
  ].filter((part) => part !== null);

export const usageLabel = (usage: Usage) =>
  usageParts(usage)
    .map((part) => `${part.label} ${part.value}`)
    .join(', ');

function UsagePart({ kind, value }: { kind: keyof typeof STAT_ICON; value: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.usageItem, kind === 'disk' && styles.shrink]}>
      <Icon name={STAT_ICON[kind]} size={11} color={theme.colors.secondary} />
      <Text variant={VALUE} style={[styles.tabular, styles.shrink]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export function StatusCard({ stage, usage, onPress }: { stage: WorkspaceStage; usage: Usage; onPress: () => void }) {
  const parts = usageParts(usage);
  const note = stage.label === 'Building' ? null : stage.subtitle;
  return (
    <SmallCard
      title="Status"
      onPress={onPress}
      accessibilityLabel={['Status', stage.label, note, usageLabel(usage) || 'resources not measured']
        .filter(Boolean)
        .join(', ')}
      accessibilityHint="Shows the status and what this workspace uses"
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
        <View style={styles.usage}>
          {parts.map((part) => (
            <UsagePart key={part.kind} kind={part.kind} value={part.value} />
          ))}
        </View>
      ) : (
        <Text variant={VALUE} tone="tertiary">
          Not measured
        </Text>
      )}
    </SmallCard>
  );
}

const LINE_TONE: Record<BuildLine['tone'], TextTone> = { default: 'default', error: 'error', secondary: 'secondary' };

export function BuildCard({
  lines,
  building,
  onPress,
}: {
  lines: BuildLine[];
  building: BuildReport | null;
  onPress: () => void;
}) {
  if (building) return <BuildingCard build={building} onPress={onPress} />;
  return (
    <SmallCard
      title="Build"
      alert={lines.some((line) => line.tone === 'error')}
      onPress={onPress}
      accessibilityLabel={`Build: ${lines.map((line) => line.spoken).join(', ')}`}
      accessibilityHint="Shows the builds"
    >
      {lines.map((line) => (
        <View key={line.platform} style={styles.stat}>
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
      ))}
    </SmallCard>
  );
}

function BuildingCard({ build, onPress }: { build: BuildReport; onPress: () => void }) {
  const now = useNow(1000);
  const { elapsed, estimate } = buildTiming(build, now);
  const { phase } = currentPhaseLabel(build);
  return (
    <SmallCard
      title="Build"
      onPress={onPress}
      accessibilityLabel={`Build: building ${platformName(build.platform)}, ${phase}, ${elapsed}${estimate ? ` of ${estimate}` : ''}`}
      accessibilityHint="Shows the build"
    >
      <View style={styles.stat}>
        <View style={styles.glyphBox}>
          <PlatformGlyph platform={build.platform} size={build.platform === 'ios' ? 14 : 12} />
        </View>
        <Text variant={VALUE} weight={VALUE_WEIGHT} tone="brand" numberOfLines={1} style={styles.shrink}>
          {phase}
        </Text>
      </View>
      <Text variant={VALUE} weight={VALUE_WEIGHT} numberOfLines={1} style={styles.tabular}>
        {elapsed}
        {estimate ? (
          <Text variant={VALUE} weight="regular" tone="tertiary">
            {` / ${estimate}`}
          </Text>
        ) : null}
      </Text>
    </SmallCard>
  );
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
  return (
    <SmallCard
      title="Logs"
      alert={errors !== null && errors > 0}
      onPress={onPress}
      accessibilityLabel={[
        'Logs',
        errors === null ? null : errors === 1 ? '1 error' : `${errors} errors`,
        metro ? `Metro ${metro}` : null,
        bundle?.text,
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint="Opens the logs"
    >
      {errors === null && !metro ? (
        <Text variant={VALUE} tone="tertiary">
          No logs yet
        </Text>
      ) : null}
      {errors !== null ? (
        <Text variant={VALUE} weight={VALUE_WEIGHT} numberOfLines={1} style={styles.tabular}>
          {String(errors)}
          <Text variant={VALUE} weight="regular" tone="secondary">
            {errors === 1 ? ' error' : ' errors'}
          </Text>
        </Text>
      ) : null}
      {metro ? (
        <View style={styles.stat}>
          <StatusDot color={healthColor(metro, theme.colors)} filled={metro !== 'stopped'} />
          <Text variant={VALUE} weight={VALUE_WEIGHT} numberOfLines={1} style={styles.shrink}>
            Metro
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
  agents,
  git,
  now,
  onPress,
}: {
  agents: AgentSession[];
  git: GitChip | null;
  now: number;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const agent = agents[0];
  return (
    <SmallCard
      title="Work"
      onPress={onPress}
      accessibilityLabel={[
        'Work',
        agent ? agentLabel(agent, now) : 'No agent session',
        agents.length > 1 ? `and ${agents.length - 1} more` : null,
        git?.label ?? 'no git state',
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint="Shows the agent sessions and the branch"
    >
      {agents.length ? (
        <AgentSessionLine agents={agents} now={now} variant={VALUE} weight={VALUE_WEIGHT} />
      ) : (
        <Text variant={VALUE} tone="tertiary" numberOfLines={1}>
          No agent session
        </Text>
      )}
      {git ? (
        <View style={styles.gitLine}>
          {git.pr ? (
            <>
              <Text variant={VALUE} weight={VALUE_WEIGHT} tone={CHIP_TONE[git.pr.tone]} numberOfLines={1}>
                {git.pr.text}
              </Text>
              {git.pr.ci === 'failing' ? (
                <Text variant={VALUE} weight={VALUE_WEIGHT} tone="error" numberOfLines={1}>
                  CI failing
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
              tone={CHIP_TONE[part.tone]}
              numberOfLines={1}
              style={[styles.tabular, part.tone === 'default' ? null : styles.shrink]}
            >
              {part.text}
            </Text>
          ))}
          {!git.pr && git.parts.length === 0 ? (
            <Text variant={VALUE} tone="secondary">
              Up to date
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant={VALUE} tone="tertiary" numberOfLines={1}>
          No git state
        </Text>
      )}
    </SmallCard>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

function segmentWeights(steps: PhaseStep[]): number[] {
  const total = steps.reduce((sum, step) => sum + (step.expectedMs ?? 0), 0);
  if (total <= 0) return steps.map(() => 1);
  return steps.map((step) => Math.max(step.expectedMs ?? 0, total * 0.18));
}

function PhaseBar({ steps }: { steps: PhaseStep[] }) {
  const weights = segmentWeights(steps);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.phases}>
      <View style={styles.segments}>
        {steps.map((step, i) => (
          <View key={step.phase} style={[styles.segment, { flexGrow: weights[i] }]}>
            <View
              style={[
                styles.segmentFill,
                {
                  width: `${Math.round((step.state === 'current' ? (step.fraction ?? 0.1) : (step.fraction ?? 0)) * 100)}%`,
                },
              ]}
            />
          </View>
        ))}
      </View>
      {namesPhases(steps) ? (
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

export function buildTiming(build: BuildReport, now: number): { elapsed: string; estimate: string | null } {
  const progress = buildProgress(build, now);
  return {
    elapsed: clockDuration(progress.elapsedMs),
    estimate: build.expectedMs ? `~${clockDuration(build.expectedMs)}` : null,
  };
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
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`Building ${platformName(build.platform)}, ${phase}${counts ? ` ${counts}` : ''}, ${elapsed}${estimate ? ` of ${estimate}` : ''}`}
      accessibilityHint="Shows the build"
      style={styles.building}
    >
      <View style={styles.buildingHeader}>
        <PlatformGlyph
          platform={build.platform}
          size={15}
          color={theme.colors.primary}
          background={theme.colors.raised}
        />
        <Text variant="body" weight="semibold">
          {`Building ${platformName(build.platform)}`}
        </Text>
        {target ? (
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
        {counts ? (
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.shrink}>
            {counts}
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
      <PhaseBar steps={barSteps(steps)} />
      {miss ? (
        <Text variant="caption" tone="secondary">
          {`Cache miss: ${miss}`}
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
  small: { flexGrow: 1, flexBasis: '40%', padding: theme.space.md + 2, gap: theme.space.xs },
  usage: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, overflow: 'hidden' },
  usageItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  gitLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs + 1, overflow: 'hidden' },
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
