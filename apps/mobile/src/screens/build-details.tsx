import { useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BuildProgressBar } from '@/components/build-progress';
import { Icon } from '@/components/icon';
import { Touch } from '@/components/touch';
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
import { mono, useColors, type Colors } from '@/theme';

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
  const colors = useColors();
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
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>{`${name} builds`}</Text>
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
            <Icon name="arrow.clockwise" size={14} color={canCheck ? colors.primary : colors.tertiary} />
            <Text style={[styles.refreshText, { color: canCheck ? colors.primary : colors.tertiary }]}>
              Check again
            </Text>
          </Touch>
        }
      >
        {running ? (
          <Note>Checked after the running build.</Note>
        ) : checking ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={colors.tertiary} />
            <Note>{'Checking the next build\u2026'}</Note>
          </View>
        ) : plan?.kind === 'failed' ? (
          <Text style={[styles.line, { color: colors.warn }]} selectable>
            {`Cannot plan: ${plan.message}`}
          </Text>
        ) : plan?.kind === 'done' ? (
          <>
            <Text
              style={[
                styles.headline,
                { color: plan.plan.refusal || plan.plan.cacheHit === false ? colors.warn : colors.live },
              ]}
            >
              {`Next: ${nextBuild(plan.plan, false)}`}
            </Text>
            {planDetail(plan.plan) ? <Note>{planDetail(plan.plan)}</Note> : null}
            {plan.plan.refusal ? (
              <Text style={[styles.line, { color: colors.secondary }]} selectable>
                {`${plan.plan.refusal.message} ${plan.plan.refusal.remedy}`}
              </Text>
            ) : null}
            {plan.plan.missReason ? <MissReason reason={plan.plan.missReason} /> : null}
          </>
        ) : (
          <Note>Not checked yet.</Note>
        )}
        {checkedAt !== null && !checking && !running ? (
          <Text style={[styles.detail, { color: colors.tertiary }]}>
            {`Checked ${shortDuration(now - checkedAt)} ago`}
          </Text>
        ) : null}
      </Section>
    </ScrollView>
  );
}

function LastBuildDetails({ last, now, root }: { last: LastBuild; now: number; root: string }) {
  const colors = useColors();
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
      <Text style={[styles.headline, { color: failed ? colors.error : colors.text }]}>
        {lastBuildSummary(last, now, false)}
      </Text>
      <Note>{when}</Note>
      {last.diagnostics?.length ? <Diagnostics diagnostics={last.diagnostics} root={root} /> : null}
      {last.missReason ? <MissReason reason={last.missReason} /> : null}
    </>
  );
}

function Diagnostics({ diagnostics, root }: { diagnostics: BuildDiagnostic[]; root: string }) {
  const colors = useColors();
  const { home } = useMacConnection();
  return (
    <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {diagnostics.map((d, i) => (
        <View key={i} style={styles.diagnostic}>
          {d.file ? (
            <Text style={[styles.source, { color: colors.secondary }]} numberOfLines={1} ellipsizeMode="head">
              {`${tildeHome(relativeTo(d.file, root), home)}${d.line === null ? '' : `:${d.line}`}${
                d.column === null ? '' : `:${d.column}`
              }`}
            </Text>
          ) : null}
          <Text style={[styles.source, { color: colors.error }]} selectable>
            {d.message}
          </Text>
        </View>
      ))}
    </View>
  );
}

function resultColor(result: BuildHistoryEntry['result'], colors: Colors): string {
  if (result === 'succeeded') return colors.live;
  if (result === 'failed') return colors.error;
  return colors.warn;
}

function History({ entries, now, root }: { entries: BuildHistoryEntry[]; now: number; root: string }) {
  const colors = useColors();
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
                  backgroundColor: resultColor(bar.result, colors),
                },
              ]}
            />
          ))}
        </View>
      ) : null}
      <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}>
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
                  <View style={[styles.dot, { backgroundColor: resultColor(entry.result, colors) }]} />
                  <Text style={[styles.line, styles.grow, { color: colors.text }]} numberOfLines={1}>
                    {historyTitle(entry)}
                  </Text>
                  <Text style={[styles.detail, { color: colors.secondary }]}>
                    {entry.durationMs === null ? '\u2014' : clockDuration(entry.durationMs)}
                  </Text>
                  <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
                    <Icon name="chevron.right" size={12} color={colors.tertiary} />
                  </View>
                </View>
                <Text
                  style={[styles.detail, styles.indent, { color: colors.secondary }]}
                  numberOfLines={expanded ? undefined : 1}
                >
                  {historyDetail(entry, now)}
                </Text>
              </Touch>
              {expanded ? <HistoryEntryDetails entry={entry} root={root} /> : null}
            </View>
          );
        })}
      </View>
    </>
  );
}

function HistoryEntryDetails({ entry, root }: { entry: BuildHistoryEntry; root: string }) {
  const colors = useColors();
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
      {phases ? <Text style={[styles.detail, { color: colors.tertiary }]}>{phases}</Text> : null}
      {entry.result === 'interrupted' ? (
        <Note>The run ended without recording a result; the next run in this workspace recorded it.</Note>
      ) : null}
      {entry.diagnostics?.length ? <Diagnostics diagnostics={entry.diagnostics} root={root} /> : null}
      {entry.missReason ? <MissReason reason={entry.missReason} /> : null}
    </View>
  );
}

function MissReason({ reason }: { reason: BuildMissReason }) {
  const colors = useColors();
  const hidden = reason.changeCount - reason.changes.length;
  const baseline = reason.baseline
    ? `Compared with ${reason.baseline.fingerprint.slice(0, 8)}, the last build ${
        reason.baseline.from === 'workspace' ? 'in this workspace' : 'of this project in another worktree'
      }.`
    : null;
  return (
    <>
      <Text style={[styles.line, { color: colors.text }]}>{reason.summary}</Text>
      {baseline ? <Note>{baseline}</Note> : null}
      {reason.changes.length ? (
        <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          {reason.changes.map((change) => (
            <View key={`${change.change}-${change.source}`} style={styles.change}>
              <Text
                style={[
                  styles.mark,
                  {
                    color:
                      change.change === 'added'
                        ? colors.live
                        : change.change === 'removed'
                          ? colors.error
                          : colors.warn,
                  },
                ]}
              >
                {CHANGE_MARK[change.change]}
              </Text>
              <Text style={[styles.source, { color: colors.text }]} numberOfLines={2}>
                {change.source}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {hidden > 0 ? <Note>{hidden === 1 ? '1 more source changed.' : `${hidden} more sources changed.`}</Note> : null}
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.secondary }]}>{title.toUpperCase()}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function Note({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <Text style={[styles.detail, { color: colors.secondary }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 28, gap: 20, paddingBottom: 48 },
  title: { fontSize: 20, fontWeight: '700' },
  section: { gap: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 12, fontWeight: '600' },
  refresh: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  refreshText: { fontSize: 13, fontWeight: '500' },
  headline: { fontSize: 16, fontWeight: '600' },
  line: { fontSize: 14, lineHeight: 19 },
  detail: { fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  list: { borderWidth: 1, borderRadius: 12, borderCurve: 'continuous', paddingVertical: 6 },
  change: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
  diagnostic: { paddingHorizontal: 12, paddingVertical: 6, gap: 2 },
  mark: { fontFamily: mono, fontSize: 14, width: 12, textAlign: 'center' },
  source: { fontFamily: mono, fontSize: 12, flex: 1 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 32 },
  bar: { flex: 1, maxWidth: 18, borderRadius: 2 },
  historyRow: { paddingHorizontal: 12, paddingVertical: 8 },
  historyHeader: { gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  grow: { flex: 1 },
  indent: { marginLeft: 14 },
  expanded: { gap: 6, paddingTop: 6 },
});
