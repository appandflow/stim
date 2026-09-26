import { Fragment, memo } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivityChip } from '@/components/activity-chip';
import { BuildProgressBar } from '@/components/build-progress';
import { GitIndicator } from '@/components/git-indicator';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useMachinePresence } from '@/hooks/mac-connection';
import { drivenLabel, driversSummary, shortDuration } from '@/lib/format';
import type { HomeItem } from '@/lib/home';
import { devicesOf, isActive, runningBuild } from '@/lib/workspaces';

export const WorkspaceRow = memo(function WorkspaceRow({
  item,
  now,
  onOpen,
}: {
  item: HomeItem;
  now: number;
  onOpen: (item: HomeItem, errors: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const { online, cached, lastSeenAt } = useMachinePresence(item.macId);
  const macOnline = online && !cached;
  const offline = !macOnline;
  const { env } = item;
  const build = runningBuild(env);
  const active = isActive(env);
  const running = devicesOf(env).filter((d) => d.running);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const activityAt = offline ? (lastSeenAt ?? now) : now;
  const platformName = (d: (typeof running)[number]) =>
    `${d.platform === 'ios' ? 'iOS' : 'Android'}${d.slot === 'default' ? '' : ` \u00B7 ${d.slot}`}`;
  const drivenLabels = running.flatMap((d) =>
    d.activity?.state === 'driven' ? [drivenLabel(platformName(d), d.activity, activityAt)] : [],
  );
  const drivers = driversSummary(
    running.map((d) => d.activity),
    activityAt,
  );
  const where = [item.project, item.inCheckout].filter(Boolean).join(' \u00B7 ');
  const tint = offline
    ? theme.colors.tertiary
    : build
      ? theme.colors.accent
      : active
        ? theme.colors.success
        : theme.colors.tertiary;
  const lastSeen = offline
    ? lastSeenAt === null
      ? 'Offline'
      : `Last seen ${shortDuration(now - lastSeenAt)} ago`
    : null;
  return (
    <Touch
      feedback="row"
      onPress={() => onOpen(item, false)}
      accessibilityLabel={[`Workspace ${item.title} on ${item.macName}`, lastSeen, ...drivenLabels]
        .filter(Boolean)
        .join(', ')}
      style={styles.row}
    >
      <View style={[styles.lead, offline && styles.dimmed]}>
        <View
          style={[styles.ring, { borderColor: tint, backgroundColor: active && !offline ? tint : 'transparent' }]}
        />
      </View>
      <View style={[styles.body, offline && styles.dimmed]}>
        <Text
          variant="headline"
          weight="medium"
          tone={active ? 'default' : 'secondary'}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {item.title}
        </Text>
        <View style={styles.meta}>
          <Text variant="callout" tone="tertiary" style={styles.shrink} numberOfLines={1} ellipsizeMode="middle">
            {where}
          </Text>
          <GitIndicator git={env.worktree?.git} />
          <View style={styles.macIcon}>
            <Icon name="laptopcomputer" size={14} color={macOnline ? theme.colors.success : theme.colors.tertiary} />
          </View>
          <Text variant="callout" tone="tertiary" style={styles.mac} numberOfLines={1}>
            {item.macName}
          </Text>
        </View>
        {lastSeen || active || errors > 0 || env.warnings.length > 0 ? (
          <View style={styles.chips}>
            {lastSeen ? <Pill>{lastSeen}</Pill> : null}
            {env.metro?.running ? <Pill tabular={`:${env.metro.port}`}>{'Metro '}</Pill> : null}
            {env.supervisor && !env.supervisor.healthy ? <Pill tone="warning">supervisor unhealthy</Pill> : null}
            {running.map((d) => {
              const driven = d.activity?.state === 'driven';
              return (
                <Fragment key={`${d.platform}-${d.slot}`}>
                  <Pill tone={offline ? 'neutral' : driven ? 'accent' : 'success'} dot={driven}>
                    {platformName(d)}
                  </Pill>
                  {driven ? null : (
                    <ActivityChip activity={d.activity} frozenAt={offline ? (lastSeenAt ?? now) : null} />
                  )}
                </Fragment>
              );
            })}
            {drivers ? (
              <Pill tone={offline ? 'neutral' : 'accent'} dot>
                {drivers}
              </Pill>
            ) : null}
            {(env.remoteDevices ?? []).map((r) => (
              <Pill key={r.sessionId} tone="info">
                EAS session
              </Pill>
            ))}
            {errors > 0 ? (
              <Pill tone="error" onPress={() => onOpen(item, true)}>
                {errors === 1 ? '1 error' : `${errors} errors`}
              </Pill>
            ) : null}
            {env.warnings.length > 0 ? (
              <Pill tone="warning">{env.warnings.length === 1 ? '1 warning' : `${env.warnings.length} warnings`}</Pill>
            ) : null}
          </View>
        ) : null}
        {build ? <BuildProgressBar build={build} frozenAt={offline ? (lastSeenAt ?? now) : null} /> : null}
      </View>
    </Touch>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.xxl,
    paddingVertical: theme.space.lg,
  },
  lead: { width: 20, alignItems: 'center', paddingTop: theme.space.sm },
  ring: { width: 13, height: 13, borderRadius: theme.radius.round, borderWidth: 2 },
  body: { flex: 1, gap: theme.space.sm },
  dimmed: { opacity: 0.5 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, marginTop: -theme.space.xxs },
  macIcon: { marginLeft: theme.space.sm },
  shrink: { flexShrink: 1 },
  mac: { flexShrink: 0, maxWidth: 140 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
}));
