import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { STAT_ICON } from '@/components/machine-stats';
import { StatusDot } from '@/components/pill';
import { PlatformGlyph } from '@/components/platform-glyph';
import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useBuildOutput } from '@/hooks/workspace-logs';
import { useNow } from '@/hooks/use-now';
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
  type CiState,
  type GitChip,
  type MetroHealth,
  type PhaseStep,
  type StageTone,
  type Usage,
  type WorkspaceStage,
} from '@/lib/workspace-view';
import { platformName } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState } from '@/protocol/types';

function stageColor(tone: StageTone, colors: Theme['colors']): string {
  return tone === 'brand' ? colors.primary : colors[tone];
}

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

export function StageLine({
  stage,
  git,
  onGitPress,
}: {
  stage: WorkspaceStage;
  git: GitChip | null;
  onGitPress: () => void;
}) {
  const { theme } = useUnistyles();
  const [stageY, setStageY] = useState(0);
  const [chipY, setChipY] = useState(0);
  const wrapped = chipY > stageY;
  return (
    <View style={styles.stage}>
      <View
        style={styles.stageGroup}
        accessible
        accessibilityLabel={[stage.label, stage.subtitle].filter(Boolean).join(', ')}
        onLayout={(event) => setStageY(event.nativeEvent.layout.y)}
      >
        <StatusDot color={stageColor(stage.tone, theme.colors)} />
        <Text variant="footnote" weight="semibold">
          {stage.label}
        </Text>
        {stage.subtitle ? (
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.shrink}>
            {stage.subtitle}
          </Text>
        ) : null}
      </View>
      {git ? (
        <View style={styles.stageGroup} onLayout={(event) => setChipY(event.nativeEvent.layout.y)}>
          {wrapped ? null : <View style={styles.divider} />}
          <Touch
            feedback="card"
            onPress={onGitPress}
            accessibilityLabel={git.label}
            accessibilityHint="Shows the branch"
            hitSlop={6}
            style={styles.gitChip}
          >
            {git.pr ? (
              <>
                <Text variant="caption" weight="semibold" tone={CHIP_TONE[git.pr.tone]}>
                  {git.pr.text}
                </Text>
                {git.pr.ci ? <CiMark state={git.pr.ci} /> : null}
              </>
            ) : (
              <Icon name="arrow.triangle.branch" size={12} color={theme.colors.secondary} />
            )}
            {git.parts.map((part) => (
              <Text key={part.text} variant="caption" tone={CHIP_TONE[part.tone]} style={styles.tabular}>
                {part.text}
              </Text>
            ))}
            <Icon name="chevron.right" size={10} color={theme.colors.tertiary} />
          </Touch>
        </View>
      ) : null}
    </View>
  );
}

function CiMark({ state }: { state: CiState }) {
  const { theme } = useUnistyles();
  if (state === 'pending') return <StatusDot color={theme.colors.warning} />;
  return state === 'passing' ? (
    <Icon name="checkmark" size={11} color={theme.colors.success} />
  ) : (
    <Icon name="xmark" size={10} color={theme.colors.error} />
  );
}

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

export function ResourcesCard({ usage, onPress }: { usage: Usage; onPress: () => void }) {
  const { theme } = useUnistyles();
  const parts = usageParts(usage);
  return (
    <SmallCard
      title="Resources"
      onPress={onPress}
      accessibilityLabel={`Resources: ${usageLabel(usage) || 'not measured'}`}
      accessibilityHint="Shows what this workspace uses"
    >
      {parts.length === 0 ? (
        <Text variant="footnote" tone="tertiary">
          Not measured
        </Text>
      ) : null}
      {parts.map((part) => (
        <View key={part.kind} style={styles.stat}>
          <Icon name={STAT_ICON[part.kind]} size={12} color={theme.colors.secondary} />
          <Text
            variant={part.kind === 'disk' ? 'caption' : 'callout'}
            weight={part.kind === 'disk' ? undefined : 'semibold'}
            tone={part.kind === 'disk' ? 'secondary' : 'default'}
            style={styles.tabular}
            numberOfLines={1}
          >
            {part.value}
          </Text>
        </View>
      ))}
    </SmallCard>
  );
}

const LINE_TONE: Record<BuildLine['tone'], TextTone> = { default: 'default', error: 'error', secondary: 'secondary' };

export function BuildCard({ lines, onPress }: { lines: BuildLine[]; onPress: () => void }) {
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
            variant="footnote"
            weight="semibold"
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
  metro: { port: number; health: MetroHealth } | null;
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
        metro ? `Metro port ${metro.port}, ${metro.health}` : null,
        bundle?.text,
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint="Opens the logs"
    >
      {errors === null && !metro && !bundle ? (
        <Text variant="footnote" tone="tertiary">
          No logs yet
        </Text>
      ) : null}
      {errors !== null ? (
        <View style={styles.stat}>
          <StatusDot color={errors > 0 ? theme.colors.error : theme.colors.border} />
          <Text variant="footnote" weight="semibold" style={styles.tabular}>
            {String(errors)}
          </Text>
          <Text variant="footnote" tone="secondary">
            {errors === 1 ? 'error' : 'errors'}
          </Text>
        </View>
      ) : null}
      {metro ? (
        <View style={styles.stat}>
          <StatusDot color={healthColor(metro.health, theme.colors)} filled={metro.health !== 'stopped'} />
          <Text variant="footnote" weight="semibold">
            Metro
          </Text>
          <Text variant="footnote" tone="secondary" style={styles.tabular}>
            {`:${metro.port}`}
          </Text>
        </View>
      ) : null}
      {bundle ? (
        <Text variant="caption2" tone={bundle.tone === 'default' ? 'secondary' : bundle.tone} numberOfLines={2}>
          {bundle.text}
        </Text>
      ) : null}
    </SmallCard>
  );
}

export function CardRow({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
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
  stage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: theme.space.md,
    rowGap: theme.space.sm,
  },
  stageGroup: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, flexShrink: 1 },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 14, backgroundColor: theme.colors.border },
  gitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs + 1,
    paddingHorizontal: theme.space.md,
    paddingVertical: 3,
    borderRadius: theme.radius.control,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.grouped,
  },
  shrink: { flexShrink: 1 },
  spacer: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  caps: { textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 1 },
  row: { flexDirection: 'row', gap: theme.space.md },
  small: { flex: 1, flexBasis: 0, minHeight: 92, padding: theme.space.md + 2, gap: theme.space.xs },
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
