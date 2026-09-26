import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActionToast, type Toast } from '@/components/action-toast';
import { BuildCards } from '@/components/build-card';
import { Card } from '@/components/card';
import { ConnectionBanner } from '@/components/connection-banner';
import { DeviceTile } from '@/components/device-tile';
import { EmptyState } from '@/components/empty-state';
import { GitIndicator } from '@/components/git-indicator';
import { ScrollView } from '@/components/lists';
import { Pill } from '@/components/pill';
import { explainReadOnly, READ_ONLY_REASON } from '@/components/read-only';
import { RemoteTile } from '@/components/remote-tile';
import { Text } from '@/components/text';
import { withAlpha } from '@/design/color';
import { useAction, useHasStatus, useMacConnection, useWorkspace } from '@/hooks/mac-connection';
import { useRecents } from '@/hooks/recents';
import type { ConnectionState } from '@/lib/connection';
import { tildeHome } from '@/lib/paths';
import { deviceWarnings, devicesOf, livePlatforms, orderDevices, workspaceTitleAt } from '@/lib/workspaces';
import type { ActionName, Platform as DevicePlatform } from '@/protocol/types';

const ELLIPSIS_ICON = require('@/assets/icons/ellipsis.png');

const PLATFORM_NAMES: Record<DevicePlatform, string> = { ios: 'iOS', android: 'Android' };

export function WorkspaceDetail({ path }: { path: string }) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { mac, state, home, connection } = useMacConnection();
  const macId = mac?.id ?? '';
  const hasStatus = useHasStatus(macId);
  const item = useWorkspace(macId, path);
  const env = item?.env;
  const title = item?.title ?? workspaceTitleAt(path, null);
  const project = item?.project ?? null;
  const inCheckout = item?.inCheckout ?? null;
  const actions = useAction(path);
  const [toast, setToast] = useState<Toast | null>(null);
  const [bannerHeight, setBannerHeight] = useState(0);
  const dismissToast = useCallback(() => setToast(null), []);
  const { touch } = useRecents();
  useEffect(() => {
    if (macId) touch({ macId, path });
  }, [macId, path, touch]);

  const perform = async (action: ActionName, platform?: DevicePlatform) => {
    const app = platform ? ` the ${PLATFORM_NAMES[platform]} app` : '';
    setToast({ kind: 'pending', message: action === 'stop' ? `Stopping ${title}` : `Reloading${app}` });
    const error = await actions.run(action, platform ? { platform } : {});
    setToast(
      error === null
        ? { kind: 'success', message: action === 'stop' ? `Stopped ${title}` : `Reloaded${app}` }
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
    Alert.alert(`Stop ${title}?`, "Stim stops Metro and shuts down this workspace's simulators and emulators.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => void perform('stop') },
    ]);

  const openLogs = (errors: boolean) =>
    router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path, ...(errors ? { errors: '1' } : {}) } });

  const header = (
    <>
      <Stack.Screen
        options={{
          headerTransparent: Platform.OS === 'ios',
          headerBlurEffect: 'systemChromeMaterial',
          headerTitle: () => (
            <HeaderTitle title={title} subtitle={[project, inCheckout, mac?.name].filter(Boolean).join(' \u00B7 ')} />
          ),
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={Platform.OS === 'ios' ? 'ellipsis' : ELLIPSIS_ICON}
          tintColor={theme.colors.text}
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
              <Stack.Toolbar.MenuAction icon="arrow.clockwise" disabled subtitle={READ_ONLY_REASON}>
                Reload
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="stop.circle" disabled subtitle={READ_ONLY_REASON}>
                Stop
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="lock.open" onPress={() => explainReadOnly(mac?.name, state, connection)}>
                Allow control...
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

  if (!hasStatus) {
    return (
      <>
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingTop: bannerHeight }}>
          {header}
          <ActivityIndicator style={styles.loading} color={theme.colors.primary} />
        </ScrollView>
        <PinnedBanner state={state} onHeight={setBannerHeight} />
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

  const devices = orderDevices(devicesOf(env));
  const { byDevice, general } = deviceWarnings(env.warnings, devices);
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const metroHealthy = Boolean(env.metro?.running) && env.supervisor?.healthy !== false;
  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.container, { paddingTop: theme.space.xl + bannerHeight }]}
      >
        {header}
        <Card>
          <View style={styles.card}>
            {env.worktree?.branch || inCheckout ? (
              <Text variant="caption" tone="secondary" mono numberOfLines={1}>
                {env.worktree?.branch ? (
                  <Text variant="footnote" weight="semibold">
                    {env.worktree.branch}
                  </Text>
                ) : null}
                {env.worktree?.branch && inCheckout ? '  ' : ''}
                {inCheckout ?? ''}
              </Text>
            ) : null}
            <View style={styles.chips}>
              {env.metro ? (
                <Pill tone={metroHealthy ? 'success' : env.metro.running ? 'error' : 'neutral'}>
                  {`Metro :${env.metro.port} \u00B7 ${env.metro.running ? (metroHealthy ? 'healthy' : 'unhealthy') : 'stopped'}`}
                </Pill>
              ) : null}
              <GitIndicator git={env.worktree?.git} chips />
              {env.memoryMb > 0 ? (
                <Pill
                  icon="memorychip"
                  accessibilityLabel={`Estimated to use about ${(env.memoryMb / 1024).toFixed(1)} GB of memory`}
                >
                  {`${(env.memoryMb / 1024).toFixed(1)} GB`}
                </Pill>
              ) : null}
              {env.logs ? (
                <Pill tone={errors > 0 ? 'error' : 'neutral'} onPress={() => openLogs(true)}>
                  {errors === 1 ? '1 error' : `${errors} errors`}
                </Pill>
              ) : null}
            </View>
          </View>
        </Card>
        <BuildCards env={env} />
        {general.map((warning) => (
          <Text key={warning} variant="footnote" tone="warning" style={styles.warning}>
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
          <Text tone="tertiary" style={styles.none}>
            No device in this workspace yet.
          </Text>
        ) : null}
      </ScrollView>
      <PinnedBanner state={state} onHeight={setBannerHeight} />
      <ActionToast toast={toast} onDismiss={dismissToast} />
    </>
  );
}

function PinnedBanner({ state, onHeight }: { state: ConnectionState; onHeight: (height: number) => void }) {
  const headerHeight = useHeaderHeight();
  return (
    <View
      pointerEvents="box-none"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={[styles.pinned, { top: Platform.OS === 'ios' ? headerHeight : 0 }]}
    >
      <ConnectionBanner state={state} />
    </View>
  );
}

function HeaderTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.headerTitle}>
      <Text variant="headline" numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={1.3}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="caption" tone="secondary" style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerTitle: { alignItems: 'center', maxWidth: 240 },
  subtitle: { marginTop: 1 },
  loading: { marginTop: 48 },
  pinned: { position: 'absolute', left: 0, right: 0 },
  container: { padding: theme.space.xl, gap: theme.space.lg, paddingBottom: 40 },
  card: { padding: theme.space.lg, gap: theme.space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  warning: {
    padding: theme.space.md,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: withAlpha(theme.colors.warning, theme.opacity.subtle),
  },
  none: { textAlign: 'center', paddingVertical: theme.space.xxxl },
}));
