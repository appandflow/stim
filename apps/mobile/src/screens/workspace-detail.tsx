import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BuildProgressBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { Chip } from '@/components/chip';
import { ConnectionBanner } from '@/components/connection-banner';
import { DeviceTile } from '@/components/device-tile';
import { EmptyState } from '@/components/empty-state';
import { RemoteTile } from '@/components/remote-tile';
import { useMacConnection, useStatus } from '@/hooks/mac-connection';
import { tildeHome } from '@/lib/paths';
import {
  deviceWarnings,
  devicesOf,
  orderDevices,
  pathInCheckout,
  projectOf,
  repositoryRoots,
  runningBuild,
  workspaceNames,
} from '@/lib/workspaces';
import { mono, useColors } from '@/theme';

const ELLIPSIS_ICON = require('@/assets/icons/ellipsis.png');

export function WorkspaceDetail({ path }: { path: string }) {
  const colors = useColors();
  const router = useRouter();
  const { mac, state, home } = useMacConnection();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const names = workspaceNames(path);
  const macId = mac?.id ?? '';
  const project = status && env ? projectOf(env, repositoryRoots(status)).name : null;

  const openLogs = (errors: boolean) =>
    router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path, ...(errors ? { errors: '1' } : {}) } });

  const header = (
    <>
      <Stack.Screen
        options={{
          headerTransparent: Platform.OS === 'ios',
          headerBlurEffect: 'systemChromeMaterial',
          headerTitle: () => (
            <HeaderTitle title={names.title} subtitle={[project, mac?.name].filter(Boolean).join(' \u00B7 ')} />
          ),
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={Platform.OS === 'ios' ? 'ellipsis' : ELLIPSIS_ICON}
          tintColor={colors.text}
          accessibilityLabel="More"
        >
          <Stack.Toolbar.MenuAction icon="text.alignleft" onPress={() => openLogs(false)}>
            Logs
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="doc.on.doc"
            subtitle={tildeHome(path, home)}
            onPress={() => void Clipboard.setStringAsync(path)}
          >
            Copy path
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="exclamationmark.triangle" onPress={() => openLogs(true)}>
            Show errors
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="laptopcomputer"
            onPress={() => router.push({ pathname: '/mac/[id]', params: { id: macId } })}
          >
            Machine status
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );

  if (!status) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        {header}
        <ConnectionBanner state={state} />
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      </ScrollView>
    );
  }
  if (!env) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        {header}
        <EmptyState title="Workspace not found" message={`stim status no longer lists ${tildeHome(path, home)}.`} />
      </ScrollView>
    );
  }

  const build = runningBuild(env);
  const devices = orderDevices(devicesOf(env));
  const { byDevice, general } = deviceWarnings(env.warnings, devices);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const inCheckout = pathInCheckout(env, repositoryRoots(status));
  const metroHealthy = Boolean(env.metro?.running) && env.supervisor?.healthy !== false;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      {header}
      <ConnectionBanner state={state} />
      <Card>
        <View style={styles.card}>
          {env.worktree?.branch || inCheckout ? (
            <Text style={[styles.where, { color: colors.secondary }]} numberOfLines={1}>
              {env.worktree?.branch ? (
                <Text style={[styles.branch, { color: colors.text }]}>{env.worktree.branch}</Text>
              ) : null}
              {env.worktree?.branch && inCheckout ? '  ' : ''}
              {inCheckout ?? ''}
            </Text>
          ) : null}
          <View style={styles.chips}>
            {env.metro ? (
              <Chip tint={metroHealthy ? colors.live : env.metro.running ? colors.error : colors.tertiary}>
                {`Metro :${env.metro.port} \u00B7 ${env.metro.running ? (metroHealthy ? 'healthy' : 'unhealthy') : 'stopped'}`}
              </Chip>
            ) : null}
            {env.memoryMb > 0 ? <Chip>{`${(env.memoryMb / 1024).toFixed(1)} GB`}</Chip> : null}
            {env.logs ? (
              <Pressable onPress={() => openLogs(true)} accessibilityRole="button" hitSlop={6}>
                <Chip tint={errors > 0 ? colors.error : undefined}>
                  {errors === 1 ? '1 error' : `${errors} errors`}
                </Chip>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Card>
      {build ? (
        <Card>
          <View style={styles.card}>
            <BuildProgressBar build={build} />
          </View>
        </Card>
      ) : null}
      {general.map((warning) => (
        <Text key={warning} style={[styles.warning, { color: colors.warn, backgroundColor: `${colors.warn}1A` }]}>
          {tildeHome(warning, home)}
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
          warnings={byDevice.get(device) ?? []}
        />
      ))}
      {devices.length === 0 && !env.remoteDevices?.length ? (
        <Text style={[styles.none, { color: colors.tertiary }]}>No device in this workspace yet.</Text>
      ) : null}
    </ScrollView>
  );
}

function HeaderTitle({ title, subtitle }: { title: string; subtitle: string }) {
  const colors = useColors();
  return (
    <View style={styles.headerTitle}>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: colors.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { alignItems: 'center', maxWidth: 240 },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 12, marginTop: 1 },
  loading: { marginTop: 48 },
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  card: { padding: 12, gap: 8 },
  where: { fontSize: 12, fontFamily: mono },
  branch: { fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  warning: { fontSize: 13, lineHeight: 18, padding: 10, borderRadius: 8, overflow: 'hidden' },
  none: { fontSize: 14, textAlign: 'center', paddingVertical: 24 },
});
