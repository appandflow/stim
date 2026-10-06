import { t } from '@lingui/core/macro';
import * as Clipboard from 'expo-clipboard';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform as OS,
  type ScrollViewInstance,
  View,
  type ViewInstance,
} from 'react-native';
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
import {
  BuildCard,
  BuildInProgressCard,
  CardGrid,
  LogsCard,
  MacosBuildCard,
  StatusCard,
  WorkCard,
  type BuildCardLine,
} from '@/components/workspace-cards';
import { withAlpha } from '@/design/color';
import { useWorkspaceBuildPlans } from '@/hooks/build-plans';
import { useHasStatus, useMacConnection, useMachineStatus, useWorkspace } from '@/hooks/machines';
import { useAnnounce } from '@/hooks/screen-reader';
import { useAction } from '@/hooks/workspace-actions';
import { useNow } from '@/hooks/use-now';
import { useRecents } from '@/hooks/recents';
import { formatDuration } from '@/intl/format';
import { macosBuildLabel } from '@/lib/format';
import {
  buildEntries,
  sumMeasured,
  worktreeApps,
  worktreeDevices,
  worktreeMetro,
  worktreePage,
  worktreeSessions,
  worktreeUsage,
} from '@/lib/worktree-page';
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
  supportedPlatforms,
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
import type { ActionName, DevicePlatform, Platform, EnvironmentState, MachineUsageState } from '@/protocol/types';

function reloadMessage(platform: DevicePlatform | undefined, done: boolean): string {
  if (!platform) return done ? t`Reloaded` : t`Reloading`;
  if (platform === 'web') return done ? t`Reloaded the web page` : t`Reloading the web page`;
  const name = platformName(platform);
  return done ? t`Reloaded the ${name} app` : t`Reloading the ${name} app`;
}

const ELLIPSIS_ICON = require('@/assets/icons/ellipsis.png');

/** `scrollsToApp` scrolls a multi-app worktree to the devices of the app at `path`. */
export function WorkspaceDetail({ path, scrollsToApp = true }: { path: string; scrollsToApp?: boolean }) {
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
  useAnnounce(toast?.message);
  const now = useNow(30_000);
  const status = useMachineStatus(macId);
  const machine = status?.machine;
  const platforms: Platform[] = env
    ? supportedPlatforms(env).filter((platform): platform is Platform => platform === 'ios' || platform === 'android')
    : [];
  const apps = worktreeApps(path, status?.environments ?? []);
  const multi = apps.length > 1;
  const entries = buildEntries(apps);
  const page = worktreePage({
    path,
    environments: apps,
    entries: [
      ...entries,
      ...apps.flatMap((app) => devicesOf(app).map((device) => ({ path: app.path, platform: device.platform }))),
    ],
    now,
  });
  const planFor = useWorkspaceBuildPlans(
    multi
      ? apps.map((app) => ({
          workspace: app.path,
          builds: Object.fromEntries(
            entries
              .filter((entry) => entry.path === app.path)
              .flatMap((entry) =>
                entry.platform === 'macos' ? [] : [[entry.platform, planKey(app.lastBuilds?.[entry.platform])]],
              ),
          ),
          building: runningBuild(app) !== null,
        }))
      : [
          {
            workspace: path,
            builds: Object.fromEntries(platforms.map((platform) => [platform, planKey(env?.lastBuilds?.[platform])])),
            building: !env || runningBuild(env) !== null,
          },
        ],
  );
  const plan = (platform: Platform) => planFor(path, platform);
  const scroll = useRef<ScrollViewInstance>(null);
  const target = useRef<ViewInstance>(null);
  const settled = useRef(false);
  const scrolledTo = useRef<string | null>(null);
  const scrollToApp = () => {
    const view = scroll.current;
    const content = view?.getInnerViewRef();
    const tile = target.current;
    if (!multi || !scrollsToApp || !settled.current || scrolledTo.current === path || !view || !content || !tile)
      return;
    scrolledTo.current = path;
    view.measureInWindow((_x, viewY) =>
      content.measureInWindow((_cx, contentY) => {
        const inset = contentY - viewY;
        tile.measureLayout(content, (_tx, y) =>
          view.scrollTo({ y: Math.max(-inset, y - inset - bannerHeight - theme.space.md), animated: false }),
        );
      }),
    );
  };
  const navigation = useNavigation();
  const scrollAfterTransition = useRef(scrollToApp);
  useEffect(() => {
    scrollAfterTransition.current = scrollToApp;
  });
  useEffect(() => {
    if (navigation.canGoBack()) return;
    settled.current = true;
    requestAnimationFrame(() => scrollAfterTransition.current());
  }, [navigation]);
  useEffect(
    () =>
      navigation.addListener('transitionEnd' as never, (event: { data?: { closing?: boolean } }) => {
        if (event.data?.closing || settled.current) return;
        settled.current = true;
        scrollAfterTransition.current();
      }),
    [navigation],
  );
  const { touch } = useRecents();
  useEffect(() => {
    if (macId) touch({ macId, path });
  }, [macId, path, touch]);

  const perform = async (
    action: ActionName,
    platform?: Exclude<DevicePlatform, 'macos'>,
    workspace: string | string[] = path,
  ) => {
    if (actions.pending !== null) return;
    setToast({ kind: 'pending', message: action === 'stop' ? t`Stopping ${title}` : reloadMessage(platform, false) });
    const error = await actions.run(action, { workspace, ...(platform ? { platform } : {}) });
    setToast(
      error === null
        ? { kind: 'success', message: action === 'stop' ? t`Stopped ${title}` : reloadMessage(platform, true) }
        : { kind: 'error', message: error },
    );
  };

  const choose = (title: string, buttons: { text: string; onPress: () => void; style?: 'destructive' }[]) => {
    if (OS.OS === 'android' && buttons.length > 3) {
      Alert.alert(
        title,
        undefined,
        [...buttons.slice(0, 2), { text: t`More...`, onPress: () => choose(title, buttons.slice(2)) }],
        { cancelable: true },
      );
    } else
      Alert.alert(
        title,
        undefined,
        [
          ...buttons,
          ...(OS.OS === 'android' && buttons.length === 3 ? [] : [{ text: t`Cancel`, style: 'cancel' as const }]),
        ],
        { cancelable: true },
      );
  };
  const reload = () => {
    if (multi) {
      const live = apps.flatMap((app) =>
        livePlatforms(app)
          .filter((platform) => platform !== 'macos')
          .map((platform) => ({ path: app.path, platform })),
      );
      if (live.length === 1) return void perform('reload', live[0].platform, live[0].path);
      const subtitles = worktreePage({ path, environments: apps, entries: live, now }).subtitles;
      choose(
        t`Reload which app?`,
        live.map((entry, i) => ({
          text: platformName(entry.platform) + (subtitles[i] ? ` (${subtitles[i]})` : ''),
          onPress: () => void perform('reload', entry.platform, entry.path),
        })),
      );
      return;
    }
    const platforms = env ? livePlatforms(env).filter((platform) => platform !== 'macos') : [];
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
    multi
      ? choose(
          t`Stop which app?`,
          apps.map((app, i) => ({
            text: page.appLabels[i],
            style: 'destructive',
            onPress: () => void perform('stop', undefined, app.path),
          })),
        )
      : Alert.alert(t`Stop ${title}?`, t`Stim stops Metro and shuts down this workspace's simulators and emulators.`, [
          { text: t`Cancel`, style: 'cancel' },
          { text: t`Stop`, style: 'destructive', onPress: () => void perform('stop') },
        ]);

  const logsFor = (app: EnvironmentState, errors: boolean) =>
    router.push({
      pathname: '/mac/[id]/logs',
      params: {
        id: macId,
        path: app.path,
        ...(errors ? { errors: '1' } : {}),
        ...(app.macos ? { source: 'macos' } : {}),
      },
    });
  const openLogs = (errors: boolean) => {
    if (!multi)
      return router.push({
        pathname: '/mac/[id]/logs',
        params: { id: macId, path, ...(errors ? { errors: '1' } : {}) },
      });
    const errored = apps.filter((app) => (app.logs?.errorsSinceMarker ?? 0) > 0);
    if (errored.length === 1) return logsFor(errored[0], errors);
    choose(
      t`Logs for which app?`,
      apps.map((app, i) => ({
        text: page.appLabels[i],
        onPress: () => logsFor(app, errors && (app.logs?.errorsSinceMarker ?? 0) > 0),
      })),
    );
  };
  const copyPath = multi ? (env?.worktree?.path ?? path) : path;

  const header = (
    <>
      <Stack.Screen
        options={{
          scrollEdgeEffects: { top: 'soft' },
          headerTitle: () => (
            <HeaderTitle
              title={title}
              subtitle={[project, multi ? null : inCheckout, mac?.name].filter(Boolean).join(' \u00B7 ')}
            />
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
              {actions.available.includes('reload') &&
              (multi
                ? apps.some((app) => livePlatforms(app).some((platform) => platform !== 'macos'))
                : !env.macos || livePlatforms(env).some((platform) => platform !== 'macos')) ? (
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
              {multi && actions.available.includes('stop') ? (
                <Stack.Toolbar.MenuAction
                  icon="stop.circle"
                  destructive
                  disabled={actions.pending !== null}
                  onPress={() =>
                    Alert.alert(t`Stop all apps?`, t`Stim stops every app in this worktree.`, [
                      { text: t`Cancel`, style: 'cancel' },
                      {
                        text: t`Stop all`,
                        style: 'destructive',
                        onPress: () =>
                          void perform(
                            'stop',
                            undefined,
                            apps.map((app) => app.path),
                          ),
                      },
                    ])
                  }
                >{t`Stop all`}</Stack.Toolbar.MenuAction>
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
            subtitle={tildeHome(copyPath, home)}
            onPress={() => void Clipboard.setStringAsync(copyPath)}
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
  const devices = stage.kind === 'stopped' ? all.filter((device) => device.platform === 'macos') : all;
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
        ref={scroll}
        contentContainerStyle={[styles.container, { paddingTop: theme.space.md + bannerHeight }]}
        onScrollBeginDrag={multi ? () => (scrolledTo.current = path) : undefined}
      >
        {header}
        {multi ? (
          <WorktreeContent
            key={path}
            apps={apps}
            path={path}
            now={now}
            machine={machine}
            home={home}
            reportsBundles={reportsBundles}
            plan={planFor}
            open={(pathname, appPath, platform) =>
              router.push({ pathname, params: { id: macId, path: appPath, ...(platform ? { platform } : {}) } })
            }
            openLogs={openLogs}
            target={target}
            onTargetLayout={() => requestAnimationFrame(scrollToApp)}
          />
        ) : (
          <>
            <CardGrid>
              <StatusCard
                stage={stage}
                usage={workspaceUsage(env, machine)}
                onPress={() => open('/mac/[id]/resources')}
              />
              {env.macos ? (
                <MacosBuildCard
                  app={env.macos}
                  onPress={() =>
                    router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path, source: 'build' } })
                  }
                />
              ) : null}
              {!build && lines.length > 0 && (
                <BuildCard lines={lines} onPress={() => open('/mac/[id]/build', failed ?? lines[0]?.platform)} />
              )}
              <LogsCard
                errors={env.logs ? env.logs.errorsSinceMarker : null}
                metro={health}
                bundle={bundleLine(env, now, reportsBundles)}
                onPress={() =>
                  env.macos
                    ? router.push({ pathname: '/mac/[id]/logs', params: { id: macId, path, source: 'macos' } })
                    : openLogs((env.logs?.errorsSinceMarker ?? 0) > 0)
                }
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
                onPress={() =>
                  open(
                    '/mac/[id]/build',
                    build.platform === 'ios' || build.platform === 'android' ? build.platform : undefined,
                  )
                }
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
            {devices.length ? (
              <View style={styles.deviceGrid}>
                {devices.map((device) => (
                  <View key={deviceKey(device)} style={styles.device}>
                    <DeviceTile
                      env={env}
                      device={device}
                      warnings={byDevice.get(device) ?? []}
                      usage={device.running ? deviceUsage(device, env.path, machine, device.diskBytes) : null}
                    />
                  </View>
                ))}
              </View>
            ) : null}
            {devices.length === 0 && stage.kind === 'warming' ? <WarmingPlaceholder subtitle={stage.subtitle} /> : null}
            {devices.length === 0 && !env.remoteDevices?.length && stage.kind !== 'warming' ? (
              <Text variant="footnote" tone="secondary" style={styles.none}>
                {stage.kind === 'stopped'
                  ? t`Nothing is running. Ask your agent to run the app.`
                  : t`No device in this workspace yet.`}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
      <PinnedBanner state={state} onHeight={setBannerHeight} />
      <ActionToast toast={toast} onDismiss={dismissToast} />
    </>
  );
}

function WorktreeContent({
  apps,
  path,
  now,
  machine,
  home,
  reportsBundles,
  plan,
  open,
  openLogs,
  target,
  onTargetLayout,
}: {
  apps: EnvironmentState[];
  path: string;
  now: number;
  machine: MachineUsageState | null | undefined;
  home: string | null;
  reportsBundles: boolean;
  plan: ReturnType<typeof useWorkspaceBuildPlans>;
  open: (
    route: '/mac/[id]/resources' | '/mac/[id]/build' | '/mac/[id]/work',
    path: string,
    platform?: DevicePlatform,
  ) => void;
  openLogs: (errors: boolean) => void;
  target: RefObject<ViewInstance | null>;
  onTargetLayout: () => void;
}) {
  const entries = buildEntries(apps);
  const page = worktreePage({ path, environments: apps, entries, now });
  const lead = apps.find((app) => app.path === page.lead)!;
  const stage = workspaceStage(lead, orderDevices(devicesOf(lead)), now);
  const devices = worktreeDevices(apps, now);
  const captions = worktreePage({ path, environments: apps, entries: devices, now }).subtitles;
  const firstDevice = devices.findIndex((entry) => entry.path === path);
  const warnings = new Map(
    apps.map((app) => {
      const { general, byDevice } = deviceWarnings(app.warnings, devicesOf(app));
      return [
        app.path,
        { general, byDevice: new Map([...byDevice].map(([device, notes]) => [deviceKey(device), notes])) },
      ];
    }),
  );
  const builds = apps.flatMap((app) => {
    const build = runningBuild(app);
    return build ? [{ env: app, build }] : [];
  });
  const lines: BuildCardLine[] = entries.map((entry, i) => {
    const key = `${entry.path}\n${entry.platform}`;
    if (entry.platform !== 'macos') {
      const line = buildLine(entry.platform, entry.env.lastBuilds?.[entry.platform], plan(entry.path, entry.platform));
      const project = page.subtitles[i];
      return { ...line, key, project, spoken: project ? `${line.spoken}, ${project}` : line.spoken };
    }
    const build = entry.env.macos!.build;
    const state = macosBuildLabel(entry.env.macos!);
    return {
      platform: 'macos',
      key,
      project: page.subtitles[i],
      main: state,
      sub: build.durationMs === undefined ? null : formatDuration(build.durationMs),
      tone: build.state === 'failed' ? 'error' : 'default',
      spoken: page.subtitles[i] ? `${t`macOS build: ${state}`}, ${page.subtitles[i]}` : t`macOS build: ${state}`,
    };
  });
  const chosenBuild = entries[lines.findIndex((line) => line.tone === 'error')] ?? entries[0];
  const metro = worktreeMetro(apps);
  const remote = apps.flatMap((env) => (env.remoteDevices ?? []).map((session) => ({ env, session })));
  const firstRemote = remote.findIndex(({ env }) => env.path === path);
  const scrollsToDevice = firstRemote < 0 && (remote.length > 0 || firstDevice > 0);
  return (
    <>
      <CardGrid>
        <StatusCard
          stage={stage}
          usage={worktreeUsage(apps, machine)}
          onPress={() => open('/mac/[id]/resources', path)}
        />
        {builds.length || !lines.length ? null : (
          <BuildCard
            lines={lines}
            onPress={() => chosenBuild && open('/mac/[id]/build', chosenBuild.path, chosenBuild.platform)}
          />
        )}
        <LogsCard
          errors={sumMeasured(apps.map((app) => app.logs?.errorsSinceMarker))}
          metro={metro ? metroHealth(metro) : null}
          bundle={metro ? bundleLine(metro, now, reportsBundles) : null}
          onPress={() => openLogs(apps.some((app) => (app.logs?.errorsSinceMarker ?? 0) > 0))}
        />
        <WorkCard
          sessions={worktreeSessions(apps)}
          git={gitChip(apps[0].worktree)}
          onPress={() => open('/mac/[id]/work', path)}
        />
      </CardGrid>
      {builds.map(({ env, build }) => {
        const target = devices.find(
          (entry) =>
            entry.path === env.path &&
            entry.device.platform === build.platform &&
            entry.device.slot === build.slot &&
            !entry.device.physical,
        )?.device;
        return (
          <BuildInProgressCard
            key={env.path}
            env={env}
            build={build}
            target={target ? deviceTitle(target).name : null}
            onPress={() =>
              open(
                '/mac/[id]/build',
                env.path,
                build.platform === 'ios' || build.platform === 'android' ? build.platform : undefined,
              )
            }
          />
        );
      })}
      {apps.flatMap((app) =>
        warnings.get(app.path)!.general.map((warning, i) => (
          <Text key={`${app.path}:${i}`} variant="footnote" tone="warning" style={styles.warning}>
            {tildeHome(warning, home)}
          </Text>
        )),
      )}
      {devices.length || remote.length || stage.kind === 'warming' ? <SectionHeader title={t`Devices`} /> : null}
      {remote.map(({ env, session }, i) => (
        <View
          key={`${env.path}:${session.sessionId}`}
          ref={i === firstRemote && i > 0 ? target : undefined}
          onLayout={i === firstRemote && i > 0 ? onTargetLayout : undefined}
        >
          <RemoteTile session={session} />
        </View>
      ))}
      {devices.length ? (
        <View style={styles.deviceGrid}>
          {devices.map(({ device, env }, i) => (
            <View
              key={`${env.path}\n${deviceKey(device)}`}
              style={styles.device}
              ref={scrollsToDevice && i === firstDevice ? target : undefined}
              onLayout={scrollsToDevice && i === firstDevice ? onTargetLayout : undefined}
            >
              <DeviceTile
                env={env}
                device={device}
                project={captions[i]}
                warnings={warnings.get(env.path)!.byDevice.get(deviceKey(device)) ?? []}
                usage={device.running ? deviceUsage(device, env.path, machine, device.diskBytes) : null}
              />
            </View>
          ))}
        </View>
      ) : stage.kind === 'warming' ? (
        <WarmingPlaceholder subtitle={stage.subtitle} />
      ) : remote.length ? null : (
        <Text variant="footnote" tone="secondary" style={styles.none}>
          {stage.kind === 'stopped'
            ? t`Nothing is running. Ask your agent to run the app.`
            : t`No device in this workspace yet.`}
        </Text>
      )}
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
  deviceGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.space.lg },
  device: { width: '100%', maxWidth: 640 },
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
