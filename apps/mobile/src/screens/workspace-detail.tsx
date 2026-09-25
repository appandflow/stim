import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionToast, type Toast } from '@/components/action-toast';
import { BuildCacheCard } from '@/components/build-cache-card';
import { BuildProgressBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { Chip } from '@/components/chip';
import { ConnectionBanner } from '@/components/connection-banner';
import { DeviceTile } from '@/components/device-tile';
import { EmptyState } from '@/components/empty-state';
import { RemoteTile } from '@/components/remote-tile';
import { useAction, useMacConnection, useStatus } from '@/hooks/mac-connection';
import { tildeHome } from '@/lib/paths';
import {
  deviceWarnings,
  devicesOf,
  livePlatforms,
  orderDevices,
  pathInCheckout,
  projectOf,
  repositoryRoots,
  runningBuild,
  workspaceNames,
} from '@/lib/workspaces';
import type { ActionName, Platform as DevicePlatform } from '@/protocol/types';
import { mono, useColors } from '@/theme';

const ELLIPSIS_ICON = require('@/assets/icons/ellipsis.png');

const PLATFORM_NAMES: Record<DevicePlatform, string> = { ios: 'iOS', android: 'Android' };

export function WorkspaceDetail({ path }: { path: string }) {
  const colors = useColors();
  const router = useRouter();
  const { mac, state, home, connection } = useMacConnection();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const names = workspaceNames(path);
  const macId = mac?.id ?? '';
  const project = status && env ? projectOf(env, repositoryRoots(status)).name : null;
  const actions = useAction(path);
  const [toast, setToast] = useState<Toast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  const perform = async (action: ActionName, platform?: DevicePlatform) => {
    const app = platform ? ` the ${PLATFORM_NAMES[platform]} app` : '';
    setToast({ kind: 'pending', message: action === 'stop' ? `Stopping ${names.title}` : `Reloading${app}` });
    const error = await actions.run(action, platform ? { platform } : {});
    setToast(
      error === null
        ? { kind: 'success', message: action === 'stop' ? `Stopped ${names.title}` : `Reloaded${app}` }
        : { kind: 'error', message: error },
    );
  };

  const reload = () => {
    if (!env || livePlatforms(env).length < 2) return void perform('reload');
    Alert.alert('Reload which app?', 'Both the iOS and Android apps are running.', [
      { text: 'iOS', onPress: () => void perform('reload', 'ios') },
      { text: 'Android', onPress: () => void perform('reload', 'android') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const stop = () =>
    Alert.alert(`Stop ${names.title}?`, "Stim stops Metro and shuts down this workspace's simulators and emulators.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => void perform('stop') },
    ]);

  const explainReadOnly = () =>
    Alert.alert(
      'This phone can only read',
      `To let it reload and stop workspaces, run this on ${mac?.name ?? 'the machine'}:\n\nstim-server devices grant <id> --control\n\nstim-server devices lists this phone's id. Then reconnect.`,
      [
        { text: 'Reconnect', onPress: () => connection?.reconnect() },
        { text: 'OK', style: 'cancel' },
      ],
    );

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
          {env && actions.available?.length ? (
            <Stack.Toolbar.Menu inline>
              {actions.available.includes('reload') ? (
                <Stack.Toolbar.MenuAction icon="arrow.clockwise" disabled={actions.pending !== null} onPress={reload}>
                  Reload
                </Stack.Toolbar.MenuAction>
              ) : null}
              {actions.available.includes('stop') ? (
                <Stack.Toolbar.MenuAction
                  icon="stop.circle"
                  destructive
                  disabled={actions.pending !== null}
                  onPress={stop}
                >
                  Stop
                </Stack.Toolbar.MenuAction>
              ) : null}
            </Stack.Toolbar.Menu>
          ) : env && actions.available ? (
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction icon="lock" subtitle="This phone can only read" onPress={explainReadOnly}>
                Reload and Stop
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          ) : null}
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
      <>
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          {header}
          <ConnectionBanner state={state} />
          <ActivityIndicator style={styles.loading} color={colors.primary} />
        </ScrollView>
        <ActionToast toast={toast} onDismiss={dismissToast} />
      </>
    );
  }
  if (!env) {
    return (
      <>
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          {header}
          <EmptyState title="Workspace not found" message={`stim status no longer lists ${tildeHome(path, home)}.`} />
        </ScrollView>
        <ActionToast toast={toast} onDismiss={dismissToast} />
      </>
    );
  }

  const build = runningBuild(env);
  const devices = orderDevices(devicesOf(env));
  const { byDevice, general } = deviceWarnings(env.warnings, devices);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const inCheckout = pathInCheckout(env, repositoryRoots(status));
  const metroHealthy = Boolean(env.metro?.running) && env.supervisor?.healthy !== false;
  return (
    <>
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
        <BuildCacheCard env={env} />
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
            warnings={byDevice.get(device) ?? []}
          />
        ))}
        {devices.length === 0 && !env.remoteDevices?.length ? (
          <Text style={[styles.none, { color: colors.tertiary }]}>No device in this workspace yet.</Text>
        ) : null}
      </ScrollView>
      <ActionToast toast={toast} onDismiss={dismissToast} />
    </>
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
