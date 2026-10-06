import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { EaseView, type Transition } from 'react-native-ease';
import { useReducedMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Collapsible, DisclosureChevron } from '@/components/collapsible';
import { Icon } from '@/components/icon';
import { ListRow, ListSection, SectionHeader } from '@/components/list';
import { PlatformGlyph } from '@/components/platform-glyph';
import { SheetScreen, type SheetScreenProps } from '@/components/sheet-screen';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useBuildPlan } from '@/hooks/build-plans';
import { useMacConnection, useStatus } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { useBuildOutput } from '@/hooks/workspace-logs';
import { formatDateTime, formatDuration } from '@/intl/format';
import {
  clockDuration,
  durationBars,
  historyDetail,
  historyTitle,
  lastBuildSummary,
  nextBuild,
  planDetail,
  buildTiming,
  macosBuildLabel,
  recheckNote,
} from '@/lib/format';
import { relativeTo, tildeHome } from '@/lib/paths';
import { planKey } from '@/lib/plan-checks';
import {
  currentPhaseLabel,
  deviceTitle,
  fallbackLine,
  PHASE_ORDER,
  phaseName,
  phaseSteps,
  remoteBuild,
  type PhaseStep,
  type RemoteBuild,
} from '@/lib/workspace-view';
import { buildEntries, worktreeApps, worktreePage } from '@/lib/worktree-page';
import { workspaceTitleAt } from '@/lib/workspace-names';
import { devicesOf, platformName, runningBuild } from '@/lib/workspaces';
import type {
  BuildDiagnostic,
  BuildHistoryEntry,
  BuildMissChange,
  BuildMissReason,
  BuildReport,
  LastBuild,
  Platform,
  DevicePlatform,
} from '@/protocol/types';

const CHANGE_MARK: Record<BuildMissChange['change'], string> = { added: '+', removed: '\u2212', changed: '~' };

const PLATFORMS: Platform[] = ['ios', 'android'];

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
};
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

const SWITCH_INSET = 3;
const PILL_SPRING: Transition = { type: 'spring', damping: 33, stiffness: 260, mass: 1 };
const LABEL_FADE: Transition = { type: 'timing', duration: 180, easing: 'easeInOut' };

export function BuildDetails({ path, platform }: { path: string; platform: Platform | 'macos' }) {
  const status = useStatus();
  const apps = worktreeApps(path, status?.environments ?? []);
  if (apps.length < 2) return <NativeBuildDetails path={path} platform={platform === 'android' ? 'android' : 'ios'} />;
  return <WorktreeBuildDetails key={`${path}:${platform}`} path={path} platform={platform} />;
}

function WorktreeBuildDetails({ path, platform }: { path: string; platform: Platform | 'macos' }) {
  const status = useStatus();
  const { mac } = useMacConnection();
  const router = useRouter();
  const apps = worktreeApps(path, status?.environments ?? []);
  const now = useNow(apps.some((app) => runningBuild(app) !== null) ? 1000 : 30_000);
  const entries = buildEntries(apps, true);
  const [selected, setSelected] = useState(`${path}\n${platform}`);
  const active = entries.find((entry) => `${entry.path}\n${entry.platform}` === selected) ?? entries[0];
  const subtitles = worktreePage({ path, environments: apps, entries, now }).subtitles;
  const switcher = (
    <PlatformSwitch
      value={active ? `${active.path}\n${active.platform}` : selected}
      onChange={setSelected}
      building={null}
      entries={entries.map((entry, i) => ({
        key: `${entry.path}\n${entry.platform}`,
        platform: entry.platform,
        project: subtitles[i],
        building:
          entry.platform === 'macos'
            ? entry.env.macos?.build.state === 'running'
            : runningBuild(entry.env)?.platform === entry.platform,
      }))}
    />
  );
  const app = active?.env.macos;
  const build = active ? runningBuild(active.env) : null;
  const running = build?.platform === active?.platform ? build : null;
  const target =
    active && running
      ? devicesOf(active.env).find((device) => device.platform === active.platform && device.slot === running.slot)
      : null;
  const remote = running ? remoteBuild(running, now) : null;
  const remoteHost = remote?.host ?? '';
  const startedAge = running ? formatDuration(Math.max(0, now - Date.parse(running.startedAt))) : '';
  const state = app ? macosBuildLabel(app) : '';
  return (
    <SheetScreen
      title={t`Build`}
      subtitle={
        running
          ? [
              target ? deviceTitle(target).name : null,
              remote ? t`on ${remoteHost}` : null,
              t`started ${startedAge} ago`,
            ]
              .filter(Boolean)
              .join(' \u00B7 ')
          : undefined
      }
    >
      {switcher}
      {active?.platform === 'macos' && app ? (
        <>
          <Section title={t`Last build`}>
            <Text variant="body" weight="semibold">
              {app.product}
            </Text>
            <Text tone={app.build.state === 'failed' ? 'error' : 'secondary'}>{state}</Text>
            {app.build.durationMs === undefined ? null : <Note>{formatDuration(app.build.durationMs)}</Note>}
            {app.build.error ? (
              <Text tone="error" selectable>
                {app.build.error}
              </Text>
            ) : null}
          </Section>
          <ListSection>
            <ListRow
              title={t`Build logs`}
              accessory="chevron"
              onPress={() =>
                router.push({
                  pathname: '/mac/[id]/logs',
                  params: { id: mac?.id ?? '', path: active.path, source: 'build' },
                })
              }
            />
          </ListSection>
        </>
      ) : active && active.platform !== 'macos' ? (
        <NativeBuildDetails
          key={`${active.path}:${active.platform}`}
          path={active.path}
          platform={active.platform}
          embedded
        />
      ) : null}
    </SheetScreen>
  );
}

function BuildContainer({ embedded, ...props }: SheetScreenProps & { embedded?: boolean }) {
  return embedded ? <>{props.children}</> : <SheetScreen {...props} />;
}

function NativeBuildDetails({
  path,
  platform: initial,
  embedded,
}: {
  path: string;
  platform: Platform;
  embedded?: boolean;
}) {
  const { theme } = useUnistyles();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const [platform, setPlatform] = useState<Platform>(initial === 'android' ? 'android' : 'ios');
  const last = env?.lastBuilds?.[platform];
  const history = env?.builds?.[platform] ?? [];
  const building = env ? runningBuild(env) : null;
  const running = building?.platform === platform ? building : null;
  const { plan, checkedAt, recheck } = useBuildPlan(path, platform, planKey(last), building !== null);
  const now = useNow(building?.platform === platform ? 1000 : 30_000);
  const name = platformName(platform);
  const checking = plan?.kind === 'checking';
  const canCheck = recheck !== null && !checking;
  const target = running && env ? devicesOf(env).find((d) => d.platform === platform && d.slot === running.slot) : null;
  const started = running ? Date.parse(running.startedAt) : NaN;
  const remote = running ? remoteBuild(running, now) : null;
  const lastRun = history.find(
    (entry) =>
      entry.startedAt === last?.startedAt && entry.result === 'succeeded' && Object.keys(entry.phases).length > 0,
  );
  const remoteHost = remote?.host ?? '';
  const startedAge = formatDuration(Math.max(0, now - started));
  const planned = plan?.kind === 'done' ? plan.plan : null;
  const planMessage = plan?.kind === 'failed' ? plan.message : null;
  const next = planned ? nextBuild(planned, false) : '';
  const estimated =
    planned && planned.expectedMs !== null && !planned.refusal ? clockDuration(planned.expectedMs) : null;
  const checkedAge = checkedAt === null ? '' : formatDuration(now - checkedAt);
  return (
    <BuildContainer
      embedded={embedded}
      title={t`Build`}
      subtitle={
        running
          ? [
              target ? deviceTitle(target).name : null,
              remote ? t`on ${remoteHost}` : null,
              Number.isFinite(started) ? t`started ${startedAge} ago` : null,
            ]
              .filter(Boolean)
              .join(' \u00B7 ')
          : undefined
      }
    >
      {embedded ? null : (
        <PlatformSwitch
          value={platform}
          onChange={(value) => setPlatform(value as Platform)}
          building={building?.platform === 'ios' || building?.platform === 'android' ? building.platform : null}
        />
      )}

      {running ? <RunningBuild build={running} path={path} history={history} now={now} /> : null}

      {running ? null : (
        <Section title={t`Last build`}>
          {last ? (
            <LastBuildDetails last={last} now={now} root={path} />
          ) : (
            <Note>
              <Trans>No {name} build recorded.</Trans>
            </Note>
          )}
          {lastRun ? <PhaseList steps={finishedSteps(lastRun)} /> : null}
        </Section>
      )}

      {history.length ? (
        <Section title={t`Recent builds`}>
          <History entries={history} now={now} root={path} />
        </Section>
      ) : null}

      <Section
        title={t`Next build`}
        action={
          <Touch
            onPress={() => recheck?.()}
            disabled={!canCheck}
            accessibilityLabel={t`Check the next ${name} build again`}
            hitSlop={10}
            style={styles.refresh}
          >
            <Icon name="arrow.clockwise" size={14} color={canCheck ? theme.colors.primary : theme.colors.tertiary} />
            <Text variant="footnote" weight="medium" tone={canCheck ? 'brand' : 'tertiary'}>
              <Trans>Check again</Trans>
            </Text>
          </Touch>
        }
      >
        {building ? (
          <Note>
            <Trans>Checked after the running build.</Trans>
          </Note>
        ) : checking ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={theme.colors.tertiary} />
            <Note>{t`Checking the next build\u2026`}</Note>
          </View>
        ) : plan?.kind === 'failed' ? (
          <Text tone="warning" selectable>
            <Trans>Cannot plan: {planMessage}</Trans>
          </Text>
        ) : plan?.kind === 'done' ? (
          <>
            <Text
              variant="body"
              weight="semibold"
              tone={
                plan.plan.refusal || plan.plan.cacheHit === false
                  ? 'warning'
                  : plan.plan.cacheHit === 'local' || plan.plan.cacheHit === 'remote'
                    ? 'success'
                    : 'tertiary'
              }
              accessibilityLabel={estimated ? t`Next build: ${next}, about ${estimated}` : t`Next build: ${next}`}
            >
              {t`Next: ${next}`}
              {estimated ? (
                <Text variant="body" weight="semibold" tone="secondary" style={styles.tabular}>
                  {t`  ~${estimated}`}
                  <Text variant="footnote" weight="regular" tone="tertiary">
                    {t` est.`}
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
          <Note>
            <Trans>Not checked yet.</Trans>
          </Note>
        )}
        {checkedAt !== null && !checking && !building ? (
          <Text variant="footnote" tone="tertiary">
            {t`Checked ${checkedAge} ago`}
          </Text>
        ) : null}
      </Section>
    </BuildContainer>
  );
}

function PlatformSwitch({
  value,
  onChange,
  building,
  entries: suppliedEntries,
}: {
  value: string;
  onChange: (key: string) => void;
  building: Platform | null;
  entries?: { key: string; platform: DevicePlatform; project: string | null; building: boolean }[];
}) {
  const { theme } = useUnistyles();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const entries =
    suppliedEntries ??
    PLATFORMS.map((platform) => ({ key: platform, platform, project: null, building: building === platform }));
  const segmentWidth = (width - 2 * SWITCH_INSET) / entries.length;
  return (
    <View
      style={styles.switch}
      accessibilityRole="tablist"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <EaseView
          animate={{ translateX: entries.findIndex((entry) => entry.key === value) * segmentWidth }}
          transition={reduceMotion ? { type: 'none' } : PILL_SPRING}
          style={[styles.pill, { width: segmentWidth, backgroundColor: theme.colors.background }]}
        />
      ) : null}
      {entries.map(({ key, platform, project, building: running }) => {
        const selected = key === value;
        const label = [platformName(platform), project].filter(Boolean).join(', ');
        return (
          <Touch
            key={key}
            onPress={() => onChange(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={running ? t`${label}, building` : label}
            style={[styles.segment, entries.some((entry) => entry.project) && styles.segmentTall]}
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
                {project ? (
                  <View style={styles.segmentProject}>
                    <Text variant="footnote" weight="semibold" tone={layerSelected ? 'default' : 'secondary'}>
                      {platformName(platform)}
                    </Text>
                    <Text testID="project-subtitle" variant="caption2" tone="secondary" numberOfLines={1}>
                      {project}
                    </Text>
                  </View>
                ) : (
                  <Text variant="footnote" weight="semibold" tone={layerSelected ? 'default' : 'secondary'}>
                    {platformName(platform)}
                  </Text>
                )}
                {running ? <View style={styles.buildingDot} /> : null}
              </EaseView>
            ))}
          </Touch>
        );
      })}
    </View>
  );
}

function RunningBuild({
  build,
  path,
  history,
  now,
}: {
  build: BuildReport;
  path: string;
  history: BuildHistoryEntry[];
  now: number;
}) {
  const { elapsed, estimate } = buildTiming(build, now);
  const remote = remoteBuild(build, now);
  const output = useBuildOutput(path, build.slot, build.startedAt, OUTPUT_LINES).map((record) => record.msg);
  const reported = build.detail?.line;
  const lines = reported && output.at(-1) !== reported ? [...output, reported].slice(-OUTPUT_LINES) : output;
  const miss = build.missReason?.summary;
  return (
    <>
      <View style={styles.elapsed}>
        <Text style={styles.big}>{elapsed}</Text>
        <Text variant="callout" tone="secondary" style={styles.grow}>
          {[estimate ? t`of ${estimate}` : null, miss ? t`cache miss, ${miss}` : null, recheckNote(build)]
            .filter(Boolean)
            .join(' \u00B7 ')}
        </Text>
      </View>
      {build.phase === 'wait' && build.waitingOn ? <WaitingOn path={build.waitingOn.path} current={path} /> : null}
      <PhaseList
        steps={phaseSteps(build, history, now)}
        counts={remote ? remoteStep(remote, build) : currentPhaseLabel(build).counts}
      />
      {lines.length ? (
        <Section title={t`Live output`}>
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

function WaitingOn({ path, current }: { path: string; current: string }) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { mac } = useMacConnection();
  const status = useStatus();
  const name = workspaceTitleAt(path, status);
  const line = t`Waiting for ${name}'s build of the same app`;
  if (!mac || path === current || !status?.environments.some((e) => e.path === path)) {
    return (
      <Text variant="callout" tone="secondary">
        <Trans>Waiting for another build of the same app</Trans>
      </Text>
    );
  }
  const open = () => {
    router.dismiss();
    router.push({ pathname: '/mac/[id]/workspace', params: { id: mac.id, path } });
  };
  return (
    <Touch
      onPress={open}
      accessibilityRole="link"
      accessibilityLabel={line}
      accessibilityHint={t`Opens ${name}`}
      style={styles.refresh}
    >
      <Text variant="callout" tone="brand" style={styles.grow}>
        {line}
      </Text>
      <Icon name="chevron.right" size={12} color={theme.colors.primary} />
    </Touch>
  );
}

const OUTPUT_LINES = 6;

const remoteStep = (remote: RemoteBuild, build: BuildReport) =>
  remote.phase === phaseName(build.phase) ? null : remote.phase;

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

export function LastBuildDetails({ last, now, root }: { last: LastBuild; now: number; root: string }) {
  const failed = last.status === 'failed';
  const startedAt = formatDateTime(last.startedAt, DATE_TIME);
  const finishedAt = last.finishedAt
    ? formatDateTime(last.finishedAt, sameDay(last.finishedAt, last.startedAt) ? TIME : DATE_TIME)
    : null;
  const when = [t`Started ${startedAt}`, finishedAt ? t`finished ${finishedAt}` : null].filter(Boolean).join(', ');
  return (
    <>
      <Text variant="body" weight="semibold" tone={failed ? 'error' : 'default'}>
        {lastBuildSummary(last, now, false)}
      </Text>
      <Note>{when}</Note>
      <Fallback build={last} />
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
  return result === 'cancelled' || result === 'interrupted' ? theme.colors.warning : theme.colors.tertiary;
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
                  <DisclosureChevron open={expanded} size={12} />
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
              <Collapsible open={expanded}>
                <HistoryEntryDetails entry={entry} root={root} />
              </Collapsible>
            </View>
          );
        })}
      </ListSection>
    </>
  );
}

function HistoryEntryDetails({ entry, root }: { entry: BuildHistoryEntry; root: string }) {
  const entered = PHASE_ORDER.filter((phase) => entry.phases[phase] !== undefined);
  const stoppedIn =
    entry.result === 'interrupted'
      ? (entered.findLast((phase) => entry.phases[phase] === 0) ?? entered.at(-1))
      : undefined;
  const phases = entered
    .map((phase) =>
      phase === stoppedIn ? t`stopped in ${phase}` : `${phase} ${clockDuration(entry.phases[phase] ?? 0)}`,
    )
    .join(' \u00B7 ');
  const startedAt = formatDateTime(entry.startedAt, DATE_TIME);
  const fingerprint = entry.fingerprint?.slice(0, 8);
  const facts = [t`Started ${startedAt}`, entry.configuration, fingerprint ? t`fingerprint ${fingerprint}` : null]
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
        <Note>
          <Trans>The run ended without recording a result; the next run in this workspace recorded it.</Trans>
        </Note>
      ) : null}
      <Fallback build={entry} />
      {entry.diagnostics?.length ? <Diagnostics diagnostics={entry.diagnostics} root={root} /> : null}
      {entry.missReason ? <MissReason reason={entry.missReason} /> : null}
    </View>
  );
}

/** Why a run that considered offloading built here, in a few words; a tap shows the whole reason. */
function Fallback({ build }: { build: LastBuild }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = useState(false);
  const line = fallbackLine(build);
  if (!line) return null;
  const { text } = line;
  return (
    <Touch
      onPress={() => setOpen(!open)}
      accessibilityState={{ expanded: open }}
      accessibilityLabel={open ? line.reason : t`${text}. Shows why.`}
    >
      <View style={styles.row}>
        <Icon name="desktopcomputer" size={12} color={theme.colors.tertiary} />
        <Text variant="footnote" tone="secondary" style={styles.grow}>
          {line.text}
        </Text>
      </View>
      <Collapsible open={open}>
        <View style={styles.fallbackReason}>
          <Text variant="footnote" tone="tertiary" selectable>
            {line.reason}
          </Text>
        </View>
      </Collapsible>
    </Touch>
  );
}

function MissReason({ reason }: { reason: BuildMissReason }) {
  const hidden = reason.changeCount - reason.changes.length;
  const fingerprint = reason.baseline?.fingerprint.slice(0, 8) ?? '';
  const baseline = reason.baseline
    ? reason.baseline.from === 'workspace'
      ? t`Compared with ${fingerprint}, the last build in this workspace.`
      : reason.baseline.from === 'project'
        ? t`Compared with ${fingerprint}, the last build of this project in another worktree.`
        : null
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
                tone={
                  change.change === 'added'
                    ? 'success'
                    : change.change === 'removed'
                      ? 'error'
                      : change.change === 'changed'
                        ? 'warning'
                        : 'tertiary'
                }
                style={styles.mark}
              >
                {Object.hasOwn(CHANGE_MARK, change.change) ? CHANGE_MARK[change.change] : '?'}
              </Text>
              <Text variant="caption" mono style={styles.source} numberOfLines={2}>
                {change.source}
              </Text>
            </View>
          ))}
        </ListSection>
      ) : null}
      {hidden > 0 ? (
        <Note>{plural(hidden, { one: '# more source changed.', other: '# more sources changed.' })}</Note>
      ) : null}
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
  fallbackReason: { paddingTop: theme.space.xxs },
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
  segmentTall: { height: 50 },
  segmentProject: { flexShrink: 1, alignItems: 'center' },
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
