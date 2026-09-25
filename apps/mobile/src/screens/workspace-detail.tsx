import { Stack, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BuildProgressBar } from '@/components/build-progress';
import { Chip } from '@/components/chip';
import { ConnectionBanner } from '@/components/connection-banner';
import { DeviceTile } from '@/components/device-tile';
import { EmptyState } from '@/components/empty-state';
import { RemoteTile } from '@/components/remote-tile';
import { useMacConnection, useStatus } from '@/hooks/mac-connection';
import { devicesOf, projectOf, repositoryRoots, runningBuild, workspaceNames } from '@/lib/workspaces';
import { mono, useColors } from '@/theme';

export function WorkspaceDetail({ path }: { path: string }) {
  const colors = useColors();
  const router = useRouter();
  const { mac, state } = useMacConnection();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const names = workspaceNames(path);
  const macId = mac?.id ?? '';

  const openLogs = (errors: boolean) =>
    router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path, ...(errors ? { errors: '1' } : {}) } });

  const header = (
    <Stack.Screen
      options={{
        title: names.title,
        headerRight: () => (
          <Pressable onPress={() => openLogs(false)} accessibilityRole="button" hitSlop={8}>
            <Text style={[styles.headerButton, { color: colors.primary }]}>Logs</Text>
          </Pressable>
        ),
      }}
    />
  );

  if (!status) {
    return (
      <>
        {header}
        <ConnectionBanner state={state} />
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      </>
    );
  }
  if (!env) {
    return (
      <>
        {header}
        <EmptyState title="Workspace not found" message={`stim status no longer lists ${path}.`} />
      </>
    );
  }

  const build = runningBuild(env);
  const devices = devicesOf(env);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  return (
    <>
      {header}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
        <ConnectionBanner state={state} />
        <View style={styles.section}>
          <Text style={[styles.project, { color: colors.primary }]}>
            {projectOf(env, repositoryRoots(status)).name}
          </Text>
          {env.worktree?.branch ? (
            <Text style={[styles.branch, { color: colors.text }]}>{env.worktree.branch}</Text>
          ) : null}
          <Text style={[styles.path, { color: colors.tertiary }]} selectable>
            {env.path}
          </Text>
        </View>
        <View style={styles.chips}>
          {env.metro ? (
            <Chip tint={env.metro.running ? colors.live : colors.tertiary} mono={`:${env.metro.port}`}>
              {env.metro.running ? 'Metro ' : 'Metro stopped '}
            </Chip>
          ) : null}
          {env.supervisor ? (
            <Chip tint={env.supervisor.healthy ? undefined : colors.warn}>
              {`${env.supervisor.mode ?? 'supervisor'} \u00B7 ${env.supervisor.healthy ? 'healthy' : 'unhealthy'}`}
            </Chip>
          ) : null}
          {env.memoryMb > 0 ? <Chip>{`${(env.memoryMb / 1024).toFixed(1)} GB committed`}</Chip> : null}
          {env.logs ? (
            <Pressable onPress={() => openLogs(true)} accessibilityRole="button" hitSlop={6}>
              <Chip tint={errors > 0 ? colors.error : undefined}>{errors === 1 ? '1 error' : `${errors} errors`}</Chip>
            </Pressable>
          ) : null}
        </View>
        {build ? <BuildProgressBar build={build} /> : null}
        {env.warnings.map((warning) => (
          <Text key={warning} style={[styles.warning, { color: colors.warn, backgroundColor: `${colors.warn}1A` }]}>
            {warning}
          </Text>
        ))}
        {(env.remoteDevices ?? []).map((session) => (
          <RemoteTile key={session.sessionId} session={session} />
        ))}
        {devices.map((device) => (
          <DeviceTile
            key={`${device.platform}-${device.slot}`}
            workspace={env.path}
            device={device}
            build={runningBuild(env, device)}
          />
        ))}
        {devices.length === 0 && !env.remoteDevices?.length ? (
          <Text style={[styles.none, { color: colors.tertiary }]}>No device in this workspace yet.</Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  headerButton: { fontSize: 15, fontWeight: '600', paddingHorizontal: 4 },
  loading: { marginTop: 48 },
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  section: { gap: 4 },
  project: { fontSize: 13, fontWeight: '600' },
  branch: { fontSize: 15, fontFamily: mono },
  path: { fontSize: 12, fontFamily: mono },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  warning: { fontSize: 13, lineHeight: 18, padding: 10, borderRadius: 8, overflow: 'hidden' },
  none: { fontSize: 14, textAlign: 'center', paddingVertical: 24 },
});
