import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import { View, type ViewInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivityChip } from '@/components/activity-chip';
import { AgentFeed } from '@/components/agent-feed';
import { Card } from '@/components/card';
import { Pill, StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useFrame, useMacConnection } from '@/hooks/mac-connection';
import { tildeHome } from '@/lib/paths';
import type { DeviceRef } from '@/lib/workspaces';

const SCREEN_HEIGHT = 420;
const SCREEN_PADDING = 12;

export function DeviceTile({
  workspace,
  device,
  warnings,
}: {
  workspace: string;
  device: DeviceRef;
  warnings: string[];
}) {
  const { theme } = useUnistyles();
  const { home, mac } = useMacConnection();
  const [screenWidth, setScreenWidth] = useState(0);
  const streams = device.running && device.owned && !device.physical;
  const { frame, error, delayed } = useFrame(workspace, device.platform, device.slot, streams);
  const thumbnail = useRef<ViewInstance>(null);
  const target = { macId: mac?.id ?? '', workspace, platform: device.platform, slot: device.slot };
  const zoomedAway = useZoomedAway(zoomKey(target));
  const notes = warnings.map((warning) => (
    <Text key={warning} variant="caption" tone="warning" style={styles.note}>
      {tildeHome(warning, home)}
    </Text>
  ));
  if (!device.running) {
    return (
      <Card>
        <View style={styles.compact}>
          <View style={styles.header}>
            <StatusDot color={theme.colors.tertiary} filled={false} />
            <Text variant="footnote" tone="secondary" style={styles.shrink} numberOfLines={1}>
              <Text variant="footnote" weight="semibold">
                {device.slot}
              </Text>
              {` \u00B7 ${device.model} \u00B7 ${device.state}`}
            </Text>
          </View>
          {notes}
        </View>
      </Card>
    );
  }
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : device.platform === 'ios' ? 0.46 : 0.45;
  const imageHeight = Math.min(SCREEN_HEIGHT - SCREEN_PADDING * 2, (screenWidth - SCREEN_PADDING * 2) / aspect);
  return (
    <Card>
      <View style={styles.header}>
        <StatusDot color={device.running ? theme.colors.success : theme.colors.tertiary} filled={device.running} />
        <Text variant="footnote" weight="semibold" style={styles.shrink} numberOfLines={1}>
          {device.slot}
        </Text>
        <Text variant="footnote" tone="secondary" style={styles.shrink} numberOfLines={1}>
          {device.model}
        </Text>
        <View style={styles.spacer} />
        <Text variant="caption2" tone="tertiary" style={styles.shrink} numberOfLines={1}>
          {device.platform === 'ios' ? 'iOS Simulator' : device.physical ? 'Android device' : 'Android Emulator'}
        </Text>
      </View>
      <View style={styles.badges}>
        <ActivityChip activity={device.activity} />
        {streams && frame?.posture ? <Pill>{frame.posture === 'folded' ? 'Folded' : 'Unfolded'}</Pill> : null}
        {streams && delayed ? <Pill tone="warning">Screen updates delayed</Pill> : null}
      </View>
      {notes.length ? <View style={styles.notes}>{notes}</View> : null}
      <View
        onLayout={(event) => setScreenWidth(event.nativeEvent.layout.width)}
        style={[
          styles.screen,
          streams && frame && screenWidth > 0 && { height: imageHeight + SCREEN_PADDING * 2 },
          !streams && styles.screenOff,
        ]}
      >
        {streams && frame ? (
          <Touch
            ref={thumbnail}
            onPress={() => mac && openDeviceViewer(thumbnail.current, target, frame)}
            accessibilityLabel={`Open the live screen of ${device.name}`}
          >
            <Image
              source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
              style={[
                { height: Math.max(imageHeight, 0), aspectRatio: aspect, borderRadius: theme.radius.small },
                zoomedAway && styles.away,
              ]}
              contentFit="contain"
              transition={0}
              accessibilityLabel={`Latest frame of ${device.name}`}
            />
          </Touch>
        ) : (
          <Text variant="footnote" tone="tertiary" style={styles.placeholder}>
            {streams
              ? (error ?? 'Waiting for frames')
              : device.running
                ? 'Frames are only served for devices Stim owns.'
                : device.state}
          </Text>
        )}
      </View>
      {streams && device.id ? <AgentFeed workspace={workspace} slot={device.slot} deviceId={device.id} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
  },
  compact: { paddingBottom: theme.space.md, gap: theme.space.sm },
  shrink: { flexShrink: 1 },
  note: { paddingHorizontal: theme.space.lg },
  notes: { gap: theme.space.xs, paddingBottom: theme.space.md },
  spacer: { flex: 1 },
  badges: {
    flexDirection: 'row',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
    paddingBottom: theme.space.md,
  },
  screen: {
    height: SCREEN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.media.screen,
    padding: SCREEN_PADDING,
  },
  screenOff: { height: 64 },
  placeholder: { textAlign: 'center' },
  away: { opacity: 0 },
}));
