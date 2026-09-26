import { useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BuildProgressBar } from '@/components/build-progress';
import { Icon } from '@/components/icon';
import { ListSection, SectionHeader } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import type { Theme } from '@/design/theme';
import { useBuildPlan, useMacConnection, useStatus } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
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
import { runningBuild } from '@/lib/workspaces';
import type {
  BuildDiagnostic,
  BuildHistoryEntry,
  BuildMissChange,
  BuildMissReason,
  BuildPhase,
  LastBuild,
  Platform,
} from '@/protocol/types';

const CHANGE_MARK: Record<BuildMissChange['change'], string> = { added: '+', removed: '\u2212', changed: '~' };

const PHASE_ORDER: readonly BuildPhase[] = [
  'prepare',
  'cache-lookup',
  'wait',
  'prebuild',
  'pods',
  'compile',
  'install',
  'launch',
];

/** One platform's builds in a workspace: the running build, the last build, recent runs, and what the next would do. */
export function BuildDetails({ path, platform }: { path: string; platform: Platform }) {
  const { theme } = useUnistyles();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const last = env?.lastBuilds?.[platform];
  const history = env?.builds?.[platform] ?? [];
  const running = env ? runningBuild(env) : null;
  const { plan, checkedAt, recheck } = useBuildPlan(path, platform, planKey(last), running !== null);
  const now = useNow(30_000);
  const name = platform === 'ios' ? 'iOS' : 'Android';
  const checking = plan?.kind === 'checking';
  const canCheck = recheck !== null && !checking;
  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={styles.container}>
      <Text variant="title">{`${name} builds`}</Text>
      {running?.platform === platform ? <BuildProgressBar build={running} /> : null}

      <Section title="Last build">
        {last ? <LastBuildDetails last={last} now={now} root={path} /> : <Note>No build recorded.</Note>}
      </Section>

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
        {running ? (
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
            >
              {`Next: ${nextBuild(plan.plan, false)}`}
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
        {checkedAt !== null && !checking && !running ? (
          <Text variant="footnote" tone="tertiary">
            {`Checked ${shortDuration(now - checkedAt)} ago`}
          </Text>
        ) : null}
      </Section>
    </ScrollView>
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
  container: { padding: theme.space.xxl, paddingTop: theme.space.xxxl, gap: theme.space.xxl, paddingBottom: 48 },
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
