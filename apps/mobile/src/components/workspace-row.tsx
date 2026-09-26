import { Fragment, memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActivityChip } from '@/components/activity-chip';
import { BuildProgressBar } from '@/components/build-progress';
import { Chip } from '@/components/chip';
import { GitIndicator } from '@/components/git-indicator';
import { Icon } from '@/components/icon';
import { Touch } from '@/components/touch';
import { useMachinePresence } from '@/hooks/mac-connection';
import { shortDuration } from '@/lib/format';
import type { HomeItem } from '@/lib/home';
import { devicesOf, isActive, runningBuild } from '@/lib/workspaces';
import { useColors } from '@/theme';

export const WorkspaceRow = memo(function WorkspaceRow({
  item,
  now,
  onOpen,
}: {
  item: HomeItem;
  now: number;
  onOpen: (item: HomeItem, errors: boolean) => void;
}) {
  const colors = useColors();
  const { online, cached, lastSeenAt } = useMachinePresence(item.macId);
  const macOnline = online && !cached;
  const offline = !macOnline;
  const { env } = item;
  const build = runningBuild(env);
  const active = isActive(env);
  const running = devicesOf(env).filter((d) => d.running);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const where = [item.project, item.inCheckout].filter(Boolean).join(' \u00B7 ');
  const tint = offline ? colors.tertiary : build ? colors.accent : active ? colors.live : colors.tertiary;
  const lastSeen = offline
    ? lastSeenAt === null
      ? 'Offline'
      : `Last seen ${shortDuration(now - lastSeenAt)} ago`
    : null;
  return (
    <Touch
      feedback="row"
      onPress={() => onOpen(item, false)}
      accessibilityLabel={`Workspace ${item.title} on ${item.macName}${lastSeen ? `, ${lastSeen}` : ''}`}
      style={styles.row}
    >
      <View style={[styles.lead, offline && styles.dimmed]}>
        <View
          style={[styles.ring, { borderColor: tint, backgroundColor: active && !offline ? tint : 'transparent' }]}
        />
      </View>
      <View style={[styles.body, offline && styles.dimmed]}>
        <Text
          style={[styles.title, { color: active ? colors.text : colors.secondary }]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {item.title}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: colors.tertiary }]} numberOfLines={1} ellipsizeMode="middle">
            {where}
          </Text>
          <GitIndicator git={env.worktree?.git} />
          <View style={styles.macIcon}>
            <Icon name="laptopcomputer" size={14} color={macOnline ? colors.live : colors.tertiary} />
          </View>
          <Text style={[styles.metaText, styles.mac, { color: colors.tertiary }]} numberOfLines={1}>
            {item.macName}
          </Text>
        </View>
        {lastSeen || active || errors > 0 || env.warnings.length > 0 ? (
          <View style={styles.chips}>
            {lastSeen ? <Chip>{lastSeen}</Chip> : null}
            {env.metro?.running ? <Chip mono={`:${env.metro.port}`}>{'Metro '}</Chip> : null}
            {env.supervisor && !env.supervisor.healthy ? <Chip tint={colors.warn}>supervisor unhealthy</Chip> : null}
            {running.map((d) => (
              <Fragment key={`${d.platform}-${d.slot}`}>
                <Chip tint={offline ? undefined : colors.live}>
                  {`${d.platform === 'ios' ? 'iOS' : 'Android'}${d.slot === 'default' ? '' : ` \u00B7 ${d.slot}`}`}
                </Chip>
                <ActivityChip activity={d.activity} frozenAt={offline ? (lastSeenAt ?? now) : null} />
              </Fragment>
            ))}
            {(env.remoteDevices ?? []).map((r) => (
              <Chip key={r.sessionId} tint={colors.remote}>
                EAS session
              </Chip>
            ))}
            {errors > 0 ? (
              <Touch onPress={() => onOpen(item, true)} hitSlop={6}>
                <Chip tint={colors.error}>{errors === 1 ? '1 error' : `${errors} errors`}</Chip>
              </Touch>
            ) : null}
            {env.warnings.length > 0 ? (
              <Chip tint={colors.warn}>
                {env.warnings.length === 1 ? '1 warning' : `${env.warnings.length} warnings`}
              </Chip>
            ) : null}
          </View>
        ) : null}
        {build ? <BuildProgressBar build={build} frozenAt={offline ? (lastSeenAt ?? now) : null} /> : null}
      </View>
    </Touch>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, paddingHorizontal: 20, paddingVertical: 12 },
  lead: { width: 20, alignItems: 'center', paddingTop: 5 },
  ring: { width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
  body: { flex: 1, gap: 6 },
  dimmed: { opacity: 0.5 },
  title: { fontSize: 18, fontWeight: '500' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -2 },
  macIcon: { marginLeft: 6 },
  metaText: { fontSize: 14, flexShrink: 1 },
  mac: { flexShrink: 0, maxWidth: 140 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
