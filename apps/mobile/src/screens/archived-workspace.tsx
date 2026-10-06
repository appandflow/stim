import { plural, t } from '@lingui/core/macro';
import * as Linking from 'expo-linking';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentSessionRow } from '@/components/agent-sessions';
import { ConnectionBanner } from '@/components/connection-banner';
import { DeviceScreen } from '@/components/device-screen';
import { HeaderTitle } from '@/components/header-title';
import { ListRow, ListSection } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { ReplayBar } from '@/components/replay-bar';
import { SheetScreen } from '@/components/sheet-screen';
import { Text } from '@/components/text';
import { BuildCard } from '@/components/workspace-cards';
import { useAppForeground } from '@/hooks/app-foreground';
import { useDeviceStream } from '@/hooks/device-stream';
import { useMacConnection, useStatus } from '@/hooks/machines';
import { useReplayRangeState } from '@/hooks/replay-range';
import { useNow } from '@/hooks/use-now';
import { archiveError, archivedView } from '@/lib/archived';
import { buildTimeline } from '@/lib/replay';
import { buildLine } from '@/lib/workspace-view';
import { platformName } from '@/lib/workspaces';
import type { DevicePlatform, ReplayRange } from '@/protocol/types';
import { LastBuildDetails } from '@/screens/build-details';

export function ArchivedWorkspace({ archive: id }: { archive: string }) {
  const router = useRouter();
  const { mac, state } = useMacConnection();
  const status = useStatus();
  const archive = status?.archived?.find((item) => item.id === id);
  const now = useNow(30_000);
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const enabled = focused && foreground && (archive?.bytes.recordings ?? 0) > 0;
  const ios = useReplayRangeState({ archive: id, platform: 'ios', slot: 'default' }, enabled);
  const android = useReplayRangeState({ archive: id, platform: 'android', slot: 'default' }, enabled);
  const web = useReplayRangeState({ archive: id, platform: 'web', slot: 'default' }, enabled);
  if (!archive)
    return (
      <SheetScreen title={t`Archived workspace`}>
        <Text tone="secondary">{t`This archive is no longer available.`}</Text>
      </SheetScreen>
    );
  const view = archivedView(archive, now);
  const pr = archive.worktree.pullRequest;
  const last = archive.builds.last;
  const builds = plural(archive.builds.count, { one: '# build', other: '# builds' });
  const open = (pathname: '/mac/[id]/logs' | '/mac/[id]/archived-build') =>
    router.push({ pathname, params: { id: mac!.id, archive: id, path: archive.projectRoot } });
  const probes = [
    { platform: 'ios' as const, ...ios },
    { platform: 'android' as const, ...android },
    { platform: 'web' as const, ...web },
  ];
  const problem = probes.find((probe) => probe.error)?.error;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{ headerTitle: () => <HeaderTitle title={view.title} subtitle={t`Archived workspace`} /> }}
      />
      <ConnectionBanner state={state} />
      <Text variant="title" weight="semibold">
        {view.title}
      </Text>
      {pr ? (
        <ListRow title={`${view.pr}: ${pr.title}`} accessory="chevron" onPress={() => void Linking.openURL(pr.url)} />
      ) : null}
      <Text tone="secondary">{view.removedBy}</Text>
      <Text variant="footnote" tone="tertiary">
        {view.size}
      </Text>
      {archive.replacedBy ? (
        <ListSection>
          <ListRow
            title={t`Replaced by`}
            subtitle={archive.replacedBy}
            accessory="chevron"
            onPress={() =>
              router.push({ pathname: '/mac/[id]/workspace', params: { id: mac!.id, path: archive.replacedBy! } })
            }
          />
        </ListSection>
      ) : null}
      <ListSection title={builds} bare>
        {last && (last.platform === 'ios' || last.platform === 'android') ? (
          <BuildCard
            lines={[buildLine(last.platform, last, undefined)]}
            onPress={() => open('/mac/[id]/archived-build')}
          />
        ) : (
          <ListRow
            title={t`Build`}
            subtitle={last ? platformName(last.platform) : t`No build`}
            onPress={last ? () => open('/mac/[id]/archived-build') : undefined}
            accessory={last ? 'chevron' : undefined}
          />
        )}
      </ListSection>
      <ListSection>
        <ListRow
          title={t`Logs`}
          subtitle={t`Saved logs from this workspace`}
          accessory="chevron"
          onPress={() => open('/mac/[id]/logs')}
        />
      </ListSection>
      {problem ? <Text tone="secondary">{archiveError(problem, 'replay')}</Text> : null}
      {probes.map(({ platform, data }) =>
        data?.spans.length ? (
          <ListSection key={platform} title={t`Replay`}>
            <ListRow
              title={platformName(platform)}
              accessory="chevron"
              onPress={() =>
                router.push({ pathname: '/mac/[id]/archived-replay', params: { id: mac!.id, archive: id, platform } })
              }
            />
          </ListSection>
        ) : null,
      )}
      {archive.agents.length ? (
        <ListSection title={t`Agents`}>
          {archive.agents.map((agent) => (
            <AgentSessionRow key={agent.sessionId} agent={agent} />
          ))}
        </ListSection>
      ) : null}
    </ScrollView>
  );
}

export function ArchivedBuild({ archive: id }: { archive: string }) {
  const archive = useStatus()?.archived?.find((item) => item.id === id);
  const now = useNow(30_000);
  const last = archive?.builds.last;
  return (
    <SheetScreen title={t`Build`} subtitle={archive ? archivedView(archive, now).title : undefined}>
      <Text tone="secondary">{plural(archive?.builds.count ?? 0, { one: '# build', other: '# builds' })}</Text>
      {last && archive ? (
        <LastBuildDetails last={last} root={archive.projectRoot} now={now} />
      ) : (
        <Text tone="secondary">{t`No build`}</Text>
      )}
    </SheetScreen>
  );
}

export function ArchivedReplay({ archive, platform }: { archive: string; platform: DevicePlatform }) {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const range = useReplayRangeState({ archive, platform, slot: 'default' }, focused && foreground);
  const title = t`Archived replay`;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title }} />
      {range.error ? <Text tone="secondary">{archiveError(range.error, 'replay')}</Text> : null}
      {range.data?.spans.length ? (
        <RecordedDevice archive={archive} platform={platform} range={range.data} />
      ) : !range.error ? (
        <Text tone="secondary">{range.data ? t`No recording available.` : t`Loading...`}</Text>
      ) : null}
    </ScrollView>
  );
}

function RecordedDevice({
  archive,
  platform,
  range,
}: {
  archive: string;
  platform: DevicePlatform;
  range: ReplayRange;
}) {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const stream = useDeviceStream(
    { archive, platform, slot: 'default' },
    { enabled: focused && foreground, fps: 5, maxEdge: 1280, video: VIDEO, startAt: range.spans[0].start },
  );
  const source = stream.video ?? stream.frame;
  const timeline = buildTimeline(range.spans);
  return (
    <View style={styles.recording}>
      <DeviceScreen
        stream={stream}
        recorded
        label={platformName(platform)}
        style={{ aspectRatio: source ? source.width / source.height : 0.5 }}
      />
      <ReplayBar
        archived
        timeline={timeline}
        markers={range.markers}
        replay={stream.replay}
        playhead={stream.playhead}
        seeking={stream.seeking}
        canGoLive={false}
        recording={false}
        onSeek={stream.seek}
        onLive={stream.live}
        onScrubbing={() => {}}
      />
    </View>
  );
}

const VIDEO: 'h264'[] = ['h264'];
const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.space.lg, gap: theme.space.lg, backgroundColor: theme.colors.background },
  recording: { gap: theme.space.md },
}));
