import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BuildProgressBar } from '@/components/build-progress';
import { Icon } from '@/components/icon';
import { useBuildPlan, useMacConnection, useStatus } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { lastBuildSummary, nextBuild, planDetail, shortDuration } from '@/lib/format';
import { relativeTo, tildeHome } from '@/lib/paths';
import { planKey } from '@/lib/plan-checks';
import { runningBuild } from '@/lib/workspaces';
import type { BuildMissChange, BuildMissReason, LastBuild, Platform } from '@/protocol/types';
import { mono, useColors } from '@/theme';

const CHANGE_MARK: Record<BuildMissChange['change'], string> = { added: '+', removed: '\u2212', changed: '~' };

/** One platform's builds in a workspace: the running build, the last build, and what the next would do. */
export function BuildDetails({ path, platform }: { path: string; platform: Platform }) {
  const colors = useColors();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const last = env?.lastBuilds?.[platform];
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

      <Section
        title="Next build"
        action={
          <Pressable
            onPress={() => recheck?.()}
            disabled={!canCheck}
            accessibilityRole="button"
            accessibilityLabel={`Check the next ${name} build again`}
            hitSlop={10}
            style={styles.refresh}
          >
            <Icon name="arrow.clockwise" size={14} color={canCheck ? colors.primary : colors.tertiary} />
            <Text style={[styles.refreshText, { color: canCheck ? colors.primary : colors.tertiary }]}>
              Check again
            </Text>
          </Pressable>
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
  const { home } = useMacConnection();
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
      {last.diagnostics?.length ? (
        <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          {last.diagnostics.map((d, i) => (
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
      ) : null}
      {last.missReason ? <MissReason reason={last.missReason} /> : null}
    </>
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
});
