import { useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { EaseView, type Transition } from 'react-native-ease';
import { useReducedMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { ListSection, SectionHeader } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { PlatformGlyph } from '@/components/platform-glyph';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { buildTiming } from '@/components/workspace-cards';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useBuildPlan, useMacConnection, useStatus } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { useBuildOutput } from '@/hooks/workspace-logs';
import {
  clockDuration,
  durationBars,
  historyDetail,
  historyTitle,
  lastBuildSummary,
  nextBuild,
  planDetail,
  shortDuration,
} from '@/lib/format';
import { relativeTo, tildeHome } from '@/lib/paths';
import { planKey } from '@/lib/plan-checks';
import {
  currentPhaseLabel,
  deviceTitle,
  PHASE_ORDER,
  phaseName,
  phaseSteps,
  type PhaseStep,
} from '@/lib/workspace-view';
import { devicesOf, platformName, runningBuild } from '@/lib/workspaces';
import type {
  BuildDiagnostic,
  BuildHistoryEntry,
  BuildMissChange,
  BuildMissReason,
  BuildReport,
  LastBuild,
  Platform,
} from '@/protocol/types';

const CHANGE_MARK: Record<BuildMissChange['change'], string> = { added: '+', removed: '\u2212', changed: '~' };

const PLATFORMS: Platform[] = ['ios', 'android'];

const SWITCH_INSET = 3;
const PILL_SPRING: Transition = { type: 'spring', damping: 33, stiffness: 260, mass: 1 };
const LABEL_FADE: Transition = { type: 'timing', duration: 180, easing: 'easeInOut' };

/**
 * One workspace's builds, with a switch between iOS and Android: the running build's phases and output, the last
 * build, recent runs, and what the next would do.
 */
export function BuildDetails({ path, platform: initial }: { path: string; platform: Platform }) {
  const { theme } = useUnistyles();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const [platform, setPlatform] = useState<Platform>(initial === 'android' ? 'android' : 'ios');
  const last = env?.lastBuilds?.[platform];
  const history = env?.builds?.[platform] ?? [];
  const building = env ? runningBuild(env) : null;
  const running = building?.platform === platform ? building : null;
  const { plan, checkedAt, recheck } = useBuildPlan(path, platform, planKey(last), building !== null);
  const now = useNow(30_000);
  const name = platformName(platform);
  const checking = plan?.kind === 'checking';
  const canCheck = recheck !== null && !checking;
  const target = running && env ? devicesOf(env).find((d) => d.platform === platform && d.slot === running.slot) : null;
  const started = running ? Date.parse(running.startedAt) : NaN;
  const lastRun = history.find(
    (entry) =>
      entry.startedAt === last?.startedAt && entry.result === 'succeeded' && Object.keys(entry.phases).length > 0,
  );
  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={styles.container}>
      <View style={styles.titles}>
        <Text variant="title">Build</Text>
        {running ? (
          <Text variant="footnote" tone="secondary">
            {[
              target ? deviceTitle(target).name : null,
              Number.isFinite(started) ? `started ${shortDuration(Math.max(0, now - started))} ago` : null,
            ]
              .filter(Boolean)
              .join(' \u00B7 ')}
          </Text>
        ) : null}
      </View>
      <PlatformSwitch value={platform} onChange={setPlatform} building={building?.platform ?? null} />

      {running ? <RunningBuild build={running} path={path} history={history} /> : null}

      {running ? null : (
        <Section title="Last build">
          {last ? <LastBuildDetails last={last} now={now} root={path} /> : <Note>{`No ${name} build recorded.`}</Note>}
          {lastRun ? <PhaseList steps={finishedSteps(lastRun)} /> : null}
        </Section>
      )}

      {history.length ? (
        <Section title="Recent builds">
          <History entries={history} now={now} root={path} />
        </Section>
      ) : null}

      <Section
        title="Next build"
        action={
          <Touch
            onPress={() => recheck?.()}
            disabled={!canCheck}
            accessibilityLabel={`Check the next ${name} build again`}
            hitSlop={10}
            style={styles.refresh}
          >
            <Icon name="arrow.clockwise" size={14} color={canCheck ? theme.colors.primary : theme.colors.tertiary} />
            <Text variant="footnote" weight="medium" tone={canCheck ? 'brand' : 'tertiary'}>
              Check again
            </Text>
          </Touch>
        }
      >
        {building ? (
          <Note>Checked after the running build.</Note>
        ) : checking ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={theme.colors.tertiary} />
            <Note>{'Checking the next build\u2026'}</Note>
          </View>
        ) : plan?.kind === 'failed' ? (
          <Text tone="warning" selectable>
            {`Cannot plan: ${plan.message}`}
          </Text>
        ) : plan?.kind === 'done' ? (
          <>
            <Text
              variant="body"
              weight="semibold"
              tone={plan.plan.refusal || plan.plan.cacheHit === false ? 'warning' : 'success'}
              accessibilityLabel={`Next build: ${nextBuild(plan.plan, false)}${
                plan.plan.expectedMs !== null && !plan.plan.refusal
                  ? `, about ${clockDuration(plan.plan.expectedMs)}`
                  : ''
              }`}
            >
              {`Next: ${nextBuild(plan.plan, false)}`}
              {plan.plan.expectedMs !== null && !plan.plan.refusal ? (
                <Text variant="body" weight="semibold" tone="secondary" style={styles.tabular}>
                  {`  ~${clockDuration(plan.plan.expectedMs)}`}
                  <Text variant="footnote" weight="regular" tone="tertiary">
                    {' est.'}
                  </Text>
                </Text>
              ) : null}
            </Text>
            {planDetail(plan.plan) ? <Note>{planDetail(plan.plan)}</Note> : null}
            {plan.plan.refusal ? (
              <Text tone="secondary" selectable>
                {`${plan.plan.refusal.message} ${plan.plan.refusal.remedy}`}
              </Text>
            ) : null}
            {plan.plan.missReason ? <MissReason reason={plan.plan.missReason} /> : null}
          </>
        ) : (
          <Note>Not checked yet.</Note>
        )}
        {checkedAt !== null && !checking && !building ? (
          <Text variant="footnote" tone="tertiary">
            {`Checked ${shortDuration(now - checkedAt)} ago`}
          </Text>
        ) : null}
      </Section>
    </ScrollView>
  );
}

function PlatformSwitch({
  value,
  onChange,
  building,
}: {
  value: Platform;
  onChange: (platform: Platform) => void;
  building: Platform | null;
}) {
  const { theme } = useUnistyles();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const segmentWidth = (width - 2 * SWITCH_INSET) / PLATFORMS.length;
  return (
    <View
      style={styles.switch}
      accessibilityRole="tablist"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <EaseView
          animate={{ translateX: PLATFORMS.indexOf(value) * segmentWidth }}
          transition={reduceMotion ? { type: 'none' } : PILL_SPRING}
          style={[styles.pill, { width: segmentWidth, backgroundColor: theme.colors.background }]}
        />
      ) : null}
      {PLATFORMS.map((platform) => {
        const selected = platform === value;
        return (
          <Touch
            key={platform}
            onPress={() => onChange(platform)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${platformName(platform)}${building === platform ? ', building' : ''}`}
            style={styles.segment}
          >
            {[false, true].map((layerSelected) => (
              <EaseView
                key={String(layerSelected)}
                animate={{ opacity: !layerSelected || selected ? 1 : 0 }}
                transition={reduceMotion ? { type: 'none' } : LABEL_FADE}
                style={[styles.segmentLabel, layerSelected && styles.segmentLabelOverlay]}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
              >
                <PlatformGlyph
                  platform={platform}
                  size={13}
                  color={layerSelected ? theme.colors.text : theme.colors.secondary}
                  background={layerSelected ? theme.colors.background : theme.colors.raised}
                />
                <Text variant="footnote" weight="semibold" tone={layerSelected ? 'default' : 'secondary'}>
                  {platformName(platform)}
                </Text>
                {building === platform ? <View style={styles.buildingDot} /> : null}
              </EaseView>
            ))}
          </Touch>
        );
      })}
    </View>
  );
}

function RunningBuild({ build, path, history }: { build: BuildReport; path: string; history: BuildHistoryEntry[] }) {
  const now = useNow(1000);
  const { elapsed, estimate } = buildTiming(build, now);
  const output = useBuildOutput(path, build.slot, build.startedAt, OUTPUT_LINES).map((record) => record.msg);
  const reported = build.detail?.line;
  const lines = reported && output.at(-1) !== reported ? [...output, reported].slice(-OUTPUT_LINES) : output;
  const miss = build.missReason?.summary;
  return (
    <>
      <View style={styles.elapsed}>
        <Text style={styles.big}>{elapsed}</Text>
        <Text variant="callout" tone="secondary" style={styles.grow}>
          {[estimate ? `of ${estimate}` : null, miss ? `cache miss, ${miss}` : null].filter(Boolean).join(' \u00B7 ')}
        </Text>
      </View>
      <PhaseList steps={phaseSteps(build, history, now)} counts={currentPhaseLabel(build).counts} />
      {lines.length ? (
        <Section title="Live output">
          <View style={styles.output}>
            {lines.map((line, i) => (
              <Text
                key={`${i}-${line}`}
                variant="caption2"
                mono
                numberOfLines={1}
                style={i === lines.length - 1 ? styles.outputLatest : styles.outputLine}
              >
                {line}
              </Text>
            ))}
          </View>
        </Section>
      ) : null}
    </>
  );
}

const OUTPUT_LINES = 6;

function finishedSteps(entry: BuildHistoryEntry): PhaseStep[] {
  return PHASE_ORDER.filter((phase) => entry.phases[phase] !== undefined).map((phase) => ({
    phase,
    state: 'done',
    elapsedMs: entry.phases[phase] ?? null,
    expectedMs: null,
    fraction: 1,
  }));
}

function PhaseList({ steps, counts }: { steps: PhaseStep[]; counts?: string | null }) {
  const { theme } = useUnistyles();
  return (
    <ListSection>
      {steps.map((step) => (
        <View key={step.phase} style={[styles.phase, step.state === 'current' && styles.phaseCurrent]}>
          {step.state === 'done' ? (
            <View style={styles.check}>
              <Icon name="checkmark" size={11} color={theme.colors.background} />
            </View>
          ) : step.state === 'current' ? (
            <View style={styles.ring}>
              <View style={styles.ringDot} />
            </View>
          ) : (
            <View style={styles.pending} />
          )}
          <Text
            variant="callout"
            weight={step.state === 'current' ? 'semibold' : undefined}
            tone={step.state === 'pending' ? 'tertiary' : 'default'}
          >
            {phaseName(step.phase)}
          </Text>
          {step.state === 'current' && counts ? (
            <Text variant="caption" tone="secondary" numberOfLines={1} style={styles.shrink}>
              {counts}
            </Text>
          ) : null}
          <View style={styles.grow} />
          <Text variant="footnote" tone={step.state === 'pending' ? 'tertiary' : 'secondary'} style={styles.tabular}>
            {step.state === 'pending'
              ? step.expectedMs === null
                ? ''
                : `~${clockDuration(step.expectedMs)}`
              : step.elapsedMs === null
                ? ''
                : clockDuration(step.elapsedMs)}
          </Text>
        </View>
      ))}
    </ListSection>
  );
}

function LastBuildDetails({ last, now, root }: { last: LastBuild; now: number; root: string }) {
  const failed = last.status === 'failed';
  const when = [
    `Started ${new Date(last.startedAt).toLocaleString()}`,
    last.finishedAt
      ? `finished ${
          new Date(last.finishedAt).toDateString() === new Date(last.startedAt).toDateString()
            ? new Date(last.finishedAt).toLocaleTimeString()
            : new Date(last.finishedAt).toLocaleString()
        }`
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <>
      <Text variant="body" weight="semibold" tone={failed ? 'error' : 'default'}>
        {lastBuildSummary(last, now, false)}
      </Text>
      <Note>{when}</Note>
      {last.diagnostics?.length ? <Diagnostics diagnostics={last.diagnostics} root={root} /> : null}
      {last.missReason ? <MissReason reason={last.missReason} /> : null}
    </>
  );
}

function Diagnostics({ diagnostics, root }: { diagnostics: BuildDiagnostic[]; root: string }) {
  const { home } = useMacConnection();
  return (
    <ListSection>
      {diagnostics.map((d, i) => (
        <View key={i} style={styles.diagnostic}>
          {d.file ? (
            <Text variant="caption" tone="secondary" mono style={styles.source} numberOfLines={1} ellipsizeMode="head">
              {`${tildeHome(relativeTo(d.file, root), home)}${d.line === null ? '' : `:${d.line}`}${
                d.column === null ? '' : `:${d.column}`
              }`}
            </Text>
          ) : null}
          <Text variant="caption" tone="error" mono style={styles.source} selectable>
            {d.message}
          </Text>
        </View>
      ))}
    </ListSection>
  );
}

function resultColor(result: BuildHistoryEntry['result'], theme: Theme): string {
  if (result === 'succeeded') return theme.colors.success;
  if (result === 'failed') return theme.colors.error;
  return theme.colors.warning;
}

function History({ entries, now, root }: { entries: BuildHistoryEntry[]; now: number; root: string }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState<string | null>(null);
  const bars = durationBars(entries);
  return (
    <>
      {bars.length > 1 ? (
        <View style={styles.spark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {bars.map((bar, i) => (
            <View
              key={i}
              style={[
                styles.bar,
                {
                  height: `${Math.max(8, Math.round(bar.fraction * 100))}%`,
                  backgroundColor: resultColor(bar.result, theme),
                },
              ]}
            />
          ))}
        </View>
      ) : null}
      <ListSection>
        {entries.map((entry) => {
          const key = `${entry.startedAt}-${entry.slot}-${entry.result}`;
          const expanded = open === key;
          return (
            <View key={key} style={styles.historyRow}>
              <Touch
                feedback="row"
                onPress={() => setOpen(expanded ? null : key)}
                accessibilityState={{ expanded }}
                style={styles.historyHeader}
              >
                <View style={styles.row}>
                  <View style={[styles.dot, { backgroundColor: resultColor(entry.result, theme) }]} />
                  <Text style={styles.grow} numberOfLines={1}>
                    {historyTitle(entry)}
                  </Text>
                  <Text variant="footnote" tone="secondary">
                    {entry.durationMs === null ? '\u2014' : clockDuration(entry.durationMs)}
                  </Text>
                  <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
                    <Icon name="chevron.right" size={12} color={theme.colors.tertiary} />
                  </View>
                </View>
                <Text
                  variant="footnote"
                  tone="secondary"
                  style={styles.indent}
                  numberOfLines={expanded ? undefined : 1}
                >
                  {historyDetail(entry, now)}
                </Text>
              </Touch>
              {expanded ? <HistoryEntryDetails entry={entry} root={root} /> : null}
            </View>
          );
        })}
      </ListSection>
    </>
  );
}

function HistoryEntryDetails({ entry, root }: { entry: BuildHistoryEntry; root: string }) {
  const entered = PHASE_ORDER.filter((phase) => entry.phases[phase] !== undefined);
  const stoppedIn = entry.result === 'interrupted' ? entered.at(-1) : undefined;
  const phases = entered
    .map((phase) =>
      phase === stoppedIn ? `stopped in ${phase}` : `${phase} ${clockDuration(entry.phases[phase] ?? 0)}`,
    )
    .join(' \u00B7 ');
  const facts = [
    `Started ${new Date(entry.startedAt).toLocaleString()}`,
    entry.configuration,
    entry.fingerprint ? `fingerprint ${entry.fingerprint.slice(0, 8)}` : null,
  ]
    .filter(Boolean)
    .join(' \u00B7 ');
  return (
    <View style={[styles.indent, styles.expanded]}>
      <Note>{facts}</Note>
      {phases ? (
        <Text variant="footnote" tone="tertiary">
          {phases}
        </Text>
      ) : null}
      {entry.result === 'interrupted' ? (
        <Note>The run ended without recording a result; the next run in this workspace recorded it.</Note>
      ) : null}
      {entry.diagnostics?.length ? <Diagnostics diagnostics={entry.diagnostics} root={root} /> : null}
      {entry.missReason ? <MissReason reason={entry.missReason} /> : null}
    </View>
  );
}

function MissReason({ reason }: { reason: BuildMissReason }) {
  const hidden = reason.changeCount - reason.changes.length;
  const baseline = reason.baseline
    ? `Compared with ${reason.baseline.fingerprint.slice(0, 8)}, the last build ${
        reason.baseline.from === 'workspace' ? 'in this workspace' : 'of this project in another worktree'
      }.`
    : null;
  return (
    <>
      <Text>{reason.summary}</Text>
      {baseline ? <Note>{baseline}</Note> : null}
      {reason.changes.length ? (
        <ListSection>
          {reason.changes.map((change) => (
            <View key={`${change.change}-${change.source}`} style={styles.change}>
              <Text
                mono
                tone={change.change === 'added' ? 'success' : change.change === 'removed' ? 'error' : 'warning'}
                style={styles.mark}
              >
                {CHANGE_MARK[change.change]}
              </Text>
              <Text variant="caption" mono style={styles.source} numberOfLines={2}>
                {change.source}
              </Text>
            </View>
          ))}
        </ListSection>
      ) : null}
      {hidden > 0 ? <Note>{hidden === 1 ? '1 more source changed.' : `${hidden} more sources changed.`}</Note> : null}
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionHeader title={title} action={action} />
      {children}
    </View>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Text variant="footnote" tone="secondary">
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { padding: theme.space.xxl, paddingTop: theme.space.xxxl, gap: theme.space.xl, paddingBottom: 48 },
  titles: { gap: theme.space.xxs },
  switch: {
    flexDirection: 'row',
    padding: SWITCH_INSET,
    borderRadius: theme.radius.control,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.raised,
  },
  pill: {
    position: 'absolute',
    top: SWITCH_INSET,
    bottom: SWITCH_INSET,
    left: SWITCH_INSET,
    borderRadius: theme.radius.control - 2,
    borderCurve: 'continuous',
  },
  segment: { flex: 1, height: 32 },
  segmentLabel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
  },
  segmentLabelOverlay: { ...StyleSheet.absoluteFill },
  buildingDot: { width: 6, height: 6, borderRadius: theme.radius.round, backgroundColor: theme.colors.primary },
  elapsed: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.md },
  big: {
    ...theme.typography.title,
    fontSize: 28,
    lineHeight: 34,
    fontVariant: ['tabular-nums'],
    color: theme.colors.text,
  },
  phase: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md + 2,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm + 2,
  },
  phaseCurrent: { backgroundColor: withAlpha(theme.colors.primary, 0.06) },
  check: {
    width: 18,
    height: 18,
    borderRadius: theme.radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.success,
  },
  ring: {
    width: 18,
    height: 18,
    borderRadius: theme.radius.round,
    borderWidth: 2,
    borderColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringDot: { width: 8, height: 8, borderRadius: theme.radius.round, backgroundColor: theme.colors.primary },
  pending: {
    width: 18,
    height: 18,
    borderRadius: theme.radius.round,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
  },
  shrink: { flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  output: {
    padding: theme.space.lg,
    gap: 3,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    backgroundColor: theme.media.screen,
  },
  outputLine: { color: theme.media.textTertiary },
  outputLatest: { color: theme.media.text },
  section: { gap: theme.space.md },
  refresh: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  change: {
    flexDirection: 'row',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  diagnostic: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm, gap: theme.space.xxs },
  mark: { width: 12, textAlign: 'center' },
  source: { flex: 1 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 32 },
  bar: { flex: 1, maxWidth: 18, borderRadius: 2 },
  historyRow: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md },
  historyHeader: { gap: theme.space.xxs },
  dot: { width: 8, height: 8, borderRadius: theme.radius.round },
  grow: { flex: 1 },
  indent: { marginLeft: 14 },
  expanded: { gap: theme.space.sm, paddingTop: theme.space.sm },
}));
