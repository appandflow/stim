import { t } from '@lingui/core/macro';
import { Stack, useIsFocused } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { DeviceScreen } from '@/components/device-screen';
import { ReplayBar } from '@/components/replay-bar';
import { Text } from '@/components/text';
import { useAppForeground } from '@/hooks/app-foreground';
import { useDeviceStream } from '@/hooks/device-stream';
import { useStatus } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { archivedPage } from '@/lib/archived-page';
import { useReplayRangeState } from '@/hooks/replay-range';
import { archiveError } from '@/lib/archived';
import { buildTimeline, clampReplayTime } from '@/lib/replay';
import { platformName } from '@/lib/workspaces';
import { aspectOf, fitRect, type Rect } from '@/lib/zoom';
import type { DevicePlatform, ReplayRange } from '@/protocol/types';

export function ArchivedReplay({
  archive,
  platform,
  openAt,
  slot = 'default',
}: {
  archive: string;
  platform: DevicePlatform;
  openAt?: number;
  slot?: string;
}) {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const entry = useStatus()?.archived?.find((entry) => entry.id === archive);
  const now = useNow(30_000);
  const expired = entry ? archivedPage(entry, null, now).recordingsExpired : false;
  const range = useReplayRangeState({ archive, platform, slot }, focused && foreground && !expired);
  const title = t`Archived replay`;
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.replay}>
      <Stack.Screen options={{ title }} />
      {expired ? <Text tone="tertiary">{t`Expired`}</Text> : null}
      {!expired && range.error ? <Text tone="secondary">{archiveError(range.error, 'replay')}</Text> : null}
      {expired ? null : range.data?.spans.length ? (
        <RecordedDevice archive={archive} slot={slot} platform={platform} range={range.data} openAt={openAt} />
      ) : !range.error ? (
        <Text tone="secondary">{range.data ? t`No recording available.` : t`Loading...`}</Text>
      ) : null}
    </SafeAreaView>
  );
}

function RecordedDevice({
  archive,
  slot,
  platform,
  range,
  openAt,
}: {
  archive: string;
  platform: DevicePlatform;
  slot: string;
  range: ReplayRange;
  openAt?: number;
}) {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const timeline = buildTimeline(range.spans)!;
  const [startAt] = useState(() => (openAt === undefined ? timeline.start : clampReplayTime(timeline, openAt)));
  const stream = useDeviceStream(
    { archive, platform, slot },
    { enabled: focused && foreground, fps: 5, maxEdge: 1280, video: VIDEO, startAt },
  );
  const [stage, setStage] = useState<Rect>([0, 0, 0, 0]);
  const [, , width, height] = fitRect(aspectOf(stream.video ?? stream.frame) ?? 0.5, stage);
  return (
    <View style={styles.recording}>
      <View
        style={styles.stage}
        onLayout={({ nativeEvent: { layout } }) => setStage([0, 0, layout.width, layout.height])}
      >
        <DeviceScreen stream={stream} recorded label={platformName(platform)} style={{ width, height }} />
      </View>
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
  replay: { flex: 1, padding: theme.space.lg, backgroundColor: theme.colors.background },
  recording: { flex: 1, gap: theme.space.md },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
}));
