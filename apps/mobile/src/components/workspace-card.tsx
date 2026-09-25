import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActivityChip } from '@/components/activity-chip';
import { BuildProgressBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { Chip, StatusDot } from '@/components/chip';
import { devicesOf, isActive, runningBuild, workspaceNames } from '@/lib/workspaces';
import type { EnvironmentState } from '@/protocol/types';
import { useColors } from '@/theme';

export function WorkspaceCard({
  env,
  onPress,
  onErrors,
}: {
  env: EnvironmentState;
  onPress: () => void;
  onErrors: () => void;
}) {
  const colors = useColors();
  const names = workspaceNames(env.path);
  const build = runningBuild(env);
  const active = isActive(env);
  const running = devicesOf(env).filter((d) => d.running);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Workspace ${names.title}`}>
      <Card style={!active && styles.idle}>
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <StatusDot color={active ? colors.live : colors.tertiary} filled={active} />
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
              {names.title}
            </Text>
            <Text style={[styles.subtitle, { color: colors.tertiary }]} numberOfLines={1}>
              {env.worktree?.branch ?? names.subtitle}
            </Text>
          </View>
          <View style={styles.chips}>
            {env.metro ? (
              <Chip tint={env.metro.running ? undefined : colors.tertiary} mono={`:${env.metro.port}`}>
                {env.metro.running ? 'Metro ' : 'Metro stopped '}
              </Chip>
            ) : null}
            {env.supervisor ? (
              <Chip tint={env.supervisor.healthy ? undefined : colors.warn}>
                {`${env.supervisor.mode ?? 'supervisor'} \u00B7 ${env.supervisor.healthy ? 'healthy' : 'unhealthy'}`}
              </Chip>
            ) : null}
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
            {env.logs ? (
              <Pressable onPress={onErrors} accessibilityRole="button" hitSlop={6}>
                <Chip tint={errors > 0 ? colors.error : undefined}>
                  {errors === 1 ? '1 error' : `${errors} errors`}
                </Chip>
              </Pressable>
            ) : null}
            {env.warnings.length > 0 ? (
              <Chip tint={colors.warn}>
                {env.warnings.length === 1 ? '1 warning' : `${env.warnings.length} warnings`}
              </Chip>
            ) : null}
          </View>
          {build ? <BuildProgressBar build={build} /> : null}
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  idle: { opacity: 0.75 },
  body: { padding: 14, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  subtitle: { fontSize: 13, flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
