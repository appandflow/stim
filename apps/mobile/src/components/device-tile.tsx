import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { ActivityChip } from '@/components/activity-chip';
import { BuildProgressBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { StatusDot } from '@/components/chip';
import { useFrame } from '@/hooks/mac-connection';
import type { DeviceRef } from '@/lib/workspaces';
import type { BuildReport } from '@/protocol/types';
import { useColors } from '@/theme';

const SCREEN_HEIGHT = 420;

export function DeviceTile({
  workspace,
  device,
  build,
}: {
  workspace: string;
  device: DeviceRef;
  build: BuildReport | null;
}) {
  const colors = useColors();
  const streams = device.running && device.owned && !device.physical;
  const { frame, error } = useFrame(workspace, device.platform, device.slot, streams);
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : device.platform === 'ios' ? 0.46 : 0.45;
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
        <Text style={[styles.source, { color: colors.tertiary }]}>
          {device.platform === 'ios' ? 'iOS Simulator' : device.physical ? 'Android device' : 'Android Emulator'}
        </Text>
      </View>
      <View style={styles.badges}>
        <ActivityChip activity={device.activity} />
      </View>
      {build ? (
        <View style={styles.build}>
          <BuildProgressBar build={build} compact />
        </View>
      ) : null}
      <View
        style={[
          styles.screen,
          { backgroundColor: colors.screen, borderTopColor: colors.border },
          !streams && styles.screenOff,
        ]}
      >
        {streams && frame ? (
          <Image
            source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
            style={{ height: SCREEN_HEIGHT - 24, aspectRatio: aspect, borderRadius: 6 }}
            contentFit="contain"
            transition={0}
            accessibilityLabel={`Latest frame of ${device.name}`}
          />
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
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  slot: { fontSize: 13, fontWeight: '600' },
  model: { fontSize: 13, flexShrink: 1 },
  spacer: { flex: 1 },
  source: { fontSize: 11 },
  badges: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 },
  build: { paddingHorizontal: 12, paddingBottom: 10 },
  screen: {
    height: SCREEN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  screenOff: { height: 64 },
  placeholder: { fontSize: 13, textAlign: 'center' },
});
