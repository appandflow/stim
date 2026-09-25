import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActivityChip } from '@/components/activity-chip';
import { BuildProgressBar } from '@/components/build-progress';
import { Chip } from '@/components/chip';
import { Icon } from '@/components/icon';
import type { HomeItem } from '@/lib/home';
import { tildeHome } from '@/lib/paths';
import { devicesOf, isActive, runningBuild } from '@/lib/workspaces';
import { useColors } from '@/theme';

export function WorkspaceRow({
  item,
  home,
  macOnline,
  onPress,
  onErrors,
}: {
  item: HomeItem;
  home: string | null;
  macOnline: boolean;
  onPress: () => void;
  onErrors: () => void;
}) {
  const colors = useColors();
  const { env } = item;
  const build = runningBuild(env);
  const active = isActive(env);
  const running = devicesOf(env).filter((d) => d.running);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const where = env.worktree?.branch ?? tildeHome(env.path, home);
  const tint = build ? colors.accent : active ? colors.live : colors.tertiary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Workspace ${item.title} on ${item.macName}`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.raised }]}
    >
      <View style={styles.lead}>
        <View style={[styles.ring, { borderColor: tint, backgroundColor: active ? tint : 'transparent' }]} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: active ? colors.text : colors.secondary }]} numberOfLines={1}>
          {item.title}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: colors.tertiary }]} numberOfLines={1} ellipsizeMode="middle">
            {`${item.project} \u00B7 ${where}`}
          </Text>
          <View style={styles.macIcon}>
            <Icon name="laptopcomputer" size={14} color={macOnline ? colors.live : colors.tertiary} />
          </View>
          <Text style={[styles.metaText, styles.mac, { color: colors.tertiary }]} numberOfLines={1}>
            {item.macName}
          </Text>
        </View>
        {active || errors > 0 || env.warnings.length > 0 ? (
          <View style={styles.chips}>
            {env.metro?.running ? <Chip mono={`:${env.metro.port}`}>{'Metro '}</Chip> : null}
            {env.supervisor && !env.supervisor.healthy ? <Chip tint={colors.warn}>supervisor unhealthy</Chip> : null}
            {running.map((d) => (
              <Fragment key={`${d.platform}-${d.slot}`}>
                <Chip tint={colors.live}>
                  {`${d.platform === 'ios' ? 'iOS' : 'Android'}${d.slot === 'default' ? '' : ` \u00B7 ${d.slot}`}`}
                </Chip>
                <ActivityChip activity={d.activity} />
              </Fragment>
            ))}
            {(env.remoteDevices ?? []).map((r) => (
              <Chip key={r.sessionId} tint={colors.remote}>
                EAS session
              </Chip>
            ))}
            {errors > 0 ? (
              <Pressable onPress={onErrors} accessibilityRole="button" hitSlop={6}>
                <Chip tint={colors.error}>{errors === 1 ? '1 error' : `${errors} errors`}</Chip>
              </Pressable>
            ) : null}
            {env.warnings.length > 0 ? (
              <Chip tint={colors.warn}>
                {env.warnings.length === 1 ? '1 warning' : `${env.warnings.length} warnings`}
              </Chip>
            ) : null}
          </View>
        ) : null}
        {build ? <BuildProgressBar build={build} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, paddingHorizontal: 20, paddingVertical: 12 },
  lead: { width: 20, alignItems: 'center', paddingTop: 5 },
  ring: { width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
  body: { flex: 1, gap: 6 },
  title: { fontSize: 18, fontWeight: '500' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -2 },
  macIcon: { marginLeft: 6 },
  metaText: { fontSize: 14, flexShrink: 1 },
  mac: { flexShrink: 0, maxWidth: 140 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
