import { t } from '@lingui/core/macro';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform as OS, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActionToast, type Toast } from '@/components/action-toast';
import { ConnectionBanner } from '@/components/connection-banner';
import { DeviceTile, WarmingPlaceholder } from '@/components/device-tile';
import { EmptyState } from '@/components/empty-state';
import { HeaderTitle } from '@/components/header-title';
import { SectionHeader } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { explainReadOnly, readOnlyReason } from '@/components/read-only';
import { RemoteTile } from '@/components/remote-tile';
import { Text } from '@/components/text';
import { BuildCard, BuildInProgressCard, CardGrid, LogsCard, StatusCard, WorkCard } from '@/components/workspace-cards';
import { withAlpha } from '@/design/color';
import { useBuildPlans } from '@/hooks/build-plans';
import { useHasStatus, useMacConnection, useMachineStatus, useWorkspace } from '@/hooks/machines';
import { useAction } from '@/hooks/workspace-actions';
import { useNow } from '@/hooks/use-now';
import { useRecents } from '@/hooks/recents';
import { workspaceAgentSessions } from '@/lib/agents';
import type { ConnectionState } from '@/lib/connection';
import { tildeHome } from '@/lib/paths';
import { planKey } from '@/lib/plan-checks';
import {
  buildLine,
  bundleLine,
  deviceTitle,
  deviceUsage,
  gitChip,
  metroHealth,
  usedPlatforms,
  workspaceStage,
  workspaceUsage,
} from '@/lib/workspace-view';
import { workspaceTitleAt } from '@/lib/workspace-names';
import {
  deviceWarnings,
  deviceKey,
  devicesOf,
  livePlatforms,
  orderDevices,
  platformName,
  runningBuild,
} from '@/lib/workspaces';
import type { ActionName, DevicePlatform, Platform } from '@/protocol/types';

function reloadMessage(platform: DevicePlatform | undefined, done: boolean): string {
  if (!platform) return done ? t`Reloaded` : t`Reloading`;
  if (platform === 'web') return done ? t`Reloaded the web page` : t`Reloading the web page`;
  const name = platformName(platform);
  return done ? t`Reloaded the ${name} app` : t`Reloading the ${name} app`;
}

const ELLIPSIS_ICON = require('@/assets/icons/ellipsis.png');

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
  const now = useNow(30_000);
  const status = useMachineStatus(macId);
  const machine = status?.machine;
  const used = env ? usedPlatforms(env) : [];
  const platforms: Platform[] = used.length ? used : ['ios', 'android'];
  const plan = useBuildPlans(
    path,
    Object.fromEntries(platforms.map((platform) => [platform, planKey(env?.lastBuilds?.[platform])])),
    !env || runningBuild(env) !== null,
  );
  const { touch } = useRecents();
  useEffect(() => {
    if (macId) touch({ macId, path });
  }, [macId, path, touch]);

  const perform = async (action: ActionName, platform?: DevicePlatform) => {
    setToast({ kind: 'pending', message: action === 'stop' ? t`Stopping ${title}` : reloadMessage(platform, false) });
    const error = await actions.run(action, platform ? { platform } : {});
    setToast(
      error === null
        ? { kind: 'success', message: action === 'stop' ? t`Stopped ${title}` : reloadMessage(platform, true) }
        : { kind: 'error', message: error },
    );
  };

  const reload = () => {
    const platforms = env ? livePlatforms(env) : [];
    if (platforms.length < 2) return void perform('reload', platforms[0] === 'web' ? 'web' : undefined);
    const names = platforms.map(platformName);
    const rest = names.slice(0, -1).join(', ');
    const last = names.at(-1)!;
    Alert.alert(
      t`Reload which app?`,
      t`${rest} and ${last} are running.`,
      [
        ...platforms.map((platform) => ({
          text: platformName(platform),
          onPress: () => void perform('reload', platform),
        })),
        { text: t`Cancel`, style: 'cancel' as const },
      ],
      // Android's Alert shows at most three buttons, so with three platforms it drops Cancel; tapping outside closes it.
      { cancelable: true },
    );
  };

  const stop = () =>
    Alert.alert(t`Stop ${title}?`, t`Stim stops Metro and shuts down this workspace's simulators and emulators.`, [
      { text: t`Cancel`, style: 'cancel' },
      { text: t`Stop`, style: 'destructive', onPress: () => void perform('stop') },
    ]);

  const openLogs = (errors: boolean) =>
    router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path, ...(errors ? { errors: '1' } : {}) } });

  const header = (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <HeaderTitle title={title} subtitle={[project, inCheckout, mac?.name].filter(Boolean).join(' \u00B7 ')} />
          ),
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={OS.OS === 'ios' ? 'ellipsis' : ELLIPSIS_ICON}
          tintColor={theme.colors.text}
          accessibilityLabel={t`More`}
        >
          {env && actions.available?.length ? (
            <Stack.Toolbar.Menu inline>
              {actions.available.includes('reload') ? (
                <Stack.Toolbar.MenuAction icon="arrow.clockwise" disabled={actions.pending !== null} onPress={reload}>
                  {t`Reload`}
                </Stack.Toolbar.MenuAction>
              ) : null}
              {actions.available.includes('stop') ? (
                <Stack.Toolbar.MenuAction
                  icon="stop.circle"
                  destructive
                  disabled={actions.pending !== null}
                  onPress={stop}
                >
                  {t`Stop`}
                </Stack.Toolbar.MenuAction>
              ) : null}
            </Stack.Toolbar.Menu>
          ) : env && actions.available ? (
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction icon="arrow.clockwise" disabled subtitle={readOnlyReason()}>
                {t`Reload`}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="stop.circle" disabled subtitle={readOnlyReason()}>
                {t`Stop`}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="lock.open" onPress={() => explainReadOnly(mac?.name, state, connection)}>
                {t`Allow control...`}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          ) : null}
          <Stack.Toolbar.MenuAction icon="text.alignleft" onPress={() => openLogs(false)}>
            {t`Logs`}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="doc.on.doc"
            subtitle={tildeHome(path, home)}
            onPress={() => void Clipboard.setStringAsync(path)}
          >
            {t`Copy path`}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="exclamationmark.triangle" onPress={() => openLogs(true)}>
            {t`Show errors`}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="laptopcomputer"
            onPress={() => router.push({ pathname: '/mac/[id]', params: { id: macId } })}
          >
            {t`Machine status`}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );

  if (!hasStatus) {
    return (
      <>
        <ScrollView
          style={{ backgroundColor: theme.colors.background }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingTop: bannerHeight }}
        >
          {header}
          <ActivityIndicator style={styles.loading} color={theme.colors.primary} />
        </ScrollView>
        <PinnedBanner state={state} onHeight={setBannerHeight} />
        <ActionToast toast={toast} onDismiss={dismissToast} />
      </>
    );
  }
  if (!env) {
    const displayPath = tildeHome(path, home);
    return (
      <>
        <ScrollView style={{ backgroundColor: theme.colors.background }} contentInsetAdjustmentBehavior="automatic">
          {header}
          <EmptyState title={t`Workspace not found`} message={t`stim status no longer lists ${displayPath}.`} />
        </ScrollView>
        <ActionToast toast={toast} onDismiss={dismissToast} />
      </>
    );
  }

  const all = orderDevices(devicesOf(env));
  const { byDevice, general } = deviceWarnings(env.warnings, all);
  const build = runningBuild(env);
  const stage = workspaceStage(env, all, now);
  const devices = stage.kind === 'stopped' ? [] : all;
  const open = (pathname: '/mac/[id]/resources' | '/mac/[id]/build' | '/mac/[id]/work', platform?: Platform) =>
    router.push({ pathname, params: { id: macId, path, ...(platform ? { platform } : {}) } });
  const lines = platforms.map((platform) => buildLine(platform, env.lastBuilds?.[platform], plan(platform)));
  const failed = lines.find((line) => line.tone === 'error')?.platform;
  const health = metroHealth(env);
  const reportsBundles = status?.environments.some((e) => e.metro?.bundle) ?? false;
  const buildTarget = build
    ? devices.find((d) => d.platform === build.platform && d.slot === build.slot && !d.physical)
    : undefined;
  return (
    <>
      <ScrollView
        style={{ backgroundColor: theme.colors.background }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.container, { paddingTop: theme.space.md + bannerHeight }]}
      >
        {header}
        <CardGrid>
          <StatusCard stage={stage} usage={workspaceUsage(env, machine)} onPress={() => open('/mac/[id]/resources')} />
          <BuildCard
            lines={lines}
            building={build}
            onPress={() => open('/mac/[id]/build', build?.platform ?? failed ?? lines[0]?.platform)}
          />
          <LogsCard
            errors={env.logs ? env.logs.errorsSinceMarker : null}
            metro={health}
            bundle={bundleLine(env, now, reportsBundles)}
            onPress={() => openLogs((env.logs?.errorsSinceMarker ?? 0) > 0)}
          />
          <WorkCard
            sessions={workspaceAgentSessions(env)}
            git={gitChip(env.worktree)}
            onPress={() => open('/mac/[id]/work')}
          />
        </CardGrid>
        {build ? (
          <BuildInProgressCard
            env={env}
            build={build}
            target={buildTarget ? deviceTitle(buildTarget).name : null}
            onPress={() => open('/mac/[id]/build', build.platform)}
          />
        ) : null}
        {general.map((warning) => (
          <Text key={warning} variant="footnote" tone="warning" style={styles.warning}>
            {tildeHome(warning, home)}
          </Text>
        ))}
        {devices.length || env.remoteDevices?.length || stage.kind === 'warming' ? (
          <SectionHeader title={t`Devices`} />
        ) : null}
        {(env.remoteDevices ?? []).map((session) => (
          <RemoteTile key={session.sessionId} session={session} />
        ))}
        {devices.map((device) => (
          <DeviceTile
            key={deviceKey(device)}
            env={env}
            device={device}
            warnings={byDevice.get(device) ?? []}
            usage={device.running ? deviceUsage(device, env.path, machine, device.diskBytes) : null}
          />
        ))}
        {devices.length === 0 && stage.kind === 'warming' ? <WarmingPlaceholder subtitle={stage.subtitle} /> : null}
        {devices.length === 0 && !env.remoteDevices?.length && stage.kind !== 'warming' ? (
          <Text variant="footnote" tone="secondary" style={styles.none}>
            {stage.kind === 'stopped'
              ? t`Nothing is running. Ask your agent to run the app.`
              : t`No device in this workspace yet.`}
          </Text>
        ) : null}
      </ScrollView>
      <PinnedBanner state={state} onHeight={setBannerHeight} />
      <ActionToast toast={toast} onDismiss={dismissToast} />
    </>
  );
}

function PinnedBanner({ state, onHeight }: { state: ConnectionState; onHeight: (height: number) => void }) {
  return (
    <View
      pointerEvents="box-none"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={styles.pinned}
    >
      <ConnectionBanner state={state} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: { marginTop: 48 },
  pinned: { position: 'absolute', top: 0, left: 0, right: 0 },
  container: { padding: theme.space.xl, gap: theme.space.lg, paddingBottom: 40 },
  warning: {
    padding: theme.space.md,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: withAlpha(theme.colors.warning, theme.opacity.subtle),
  },
  none: {
    padding: theme.space.lg,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: theme.colors.grouped,
  },
}));
