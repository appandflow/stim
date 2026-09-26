import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View, type ViewInstance } from 'react-native';

import { ActivityChip } from '@/components/activity-chip';
import { AgentFeed } from '@/components/agent-feed';
import { Card } from '@/components/card';
import { Chip, StatusDot } from '@/components/chip';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useFrame, useMacConnection } from '@/hooks/mac-connection';
import { tildeHome } from '@/lib/paths';
import type { DeviceRef } from '@/lib/workspaces';
import { useColors } from '@/theme';

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
  const colors = useColors();
  const { home, mac } = useMacConnection();
  const [screenWidth, setScreenWidth] = useState(0);
  const streams = device.running && device.owned && !device.physical;
  const { frame, error, delayed } = useFrame(workspace, device.platform, device.slot, streams);
  const thumbnail = useRef<ViewInstance>(null);
  const target = { macId: mac?.id ?? '', workspace, platform: device.platform, slot: device.slot };
  const zoomedAway = useZoomedAway(zoomKey(target));
  const notes = warnings.map((warning) => (
    <Text key={warning} style={[styles.note, { color: colors.warn }]}>
      {tildeHome(warning, home)}
    </Text>
  ));
  if (!device.running) {
    return (
      <Card>
        <View style={styles.compact}>
          <View style={styles.header}>
            <StatusDot color={colors.tertiary} filled={false} />
            <Text style={[styles.line, { color: colors.secondary }]} numberOfLines={1}>
              <Text style={[styles.slot, { color: colors.text }]}>{device.slot}</Text>
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
        <StatusDot color={device.running ? colors.live : colors.tertiary} filled={device.running} />
        <Text style={[styles.slot, { color: colors.text }]} numberOfLines={1}>
          {device.slot}
        </Text>
        <Text style={[styles.model, { color: colors.secondary }]} numberOfLines={1}>
          {device.model}
        </Text>
        <View style={styles.spacer} />
        <Text style={[styles.source, { color: colors.tertiary }]} numberOfLines={1}>
          {device.platform === 'ios' ? 'iOS Simulator' : device.physical ? 'Android device' : 'Android Emulator'}
        </Text>
      </View>
      <View style={styles.badges}>
        <ActivityChip activity={device.activity} />
        {streams && frame?.posture ? <Chip>{frame.posture === 'folded' ? 'Folded' : 'Unfolded'}</Chip> : null}
        {streams && delayed ? <Chip tint={colors.warn}>Screen updates delayed</Chip> : null}
      </View>
      {notes.length ? <View style={styles.notes}>{notes}</View> : null}
      <View
        onLayout={(event) => setScreenWidth(event.nativeEvent.layout.width)}
        style={[
          styles.screen,
          { backgroundColor: colors.screen, borderTopColor: colors.border },
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
                { height: Math.max(imageHeight, 0), aspectRatio: aspect, borderRadius: 6 },
                zoomedAway && styles.away,
              ]}
              contentFit="contain"
              transition={0}
              accessibilityLabel={`Latest frame of ${device.name}`}
            />
          </Touch>
        ) : (
          <Text style={[styles.placeholder, { color: colors.tertiary }]}>
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

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  compact: { paddingBottom: 10, gap: 6 },
  line: { fontSize: 13, flexShrink: 1 },
  note: { fontSize: 12, lineHeight: 16, paddingHorizontal: 12 },
  notes: { gap: 4, paddingBottom: 10 },
  slot: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  model: { fontSize: 13, flexShrink: 1 },
  spacer: { flex: 1 },
  source: { fontSize: 11, flexShrink: 1 },
  badges: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 },
  screen: {
    height: SCREEN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: SCREEN_PADDING,
  },
  screenOff: { height: 64 },
  placeholder: { fontSize: 13, textAlign: 'center' },
  away: { opacity: 0 },
});
