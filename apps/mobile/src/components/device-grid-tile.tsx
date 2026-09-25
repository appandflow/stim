import { Image } from 'expo-image';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActivityChip } from '@/components/activity-chip';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { useFrameSnapshot } from '@/hooks/mac-connection';
import type { StimConnection } from '@/lib/connection';
import type { DeviceTileItem } from '@/lib/home';
import { useColors } from '@/theme';

const SCREEN_HEIGHT = 250;
const REFRESH_MS = 2000;

export function DeviceGridTile({
  tile,
  wide,
  connection,
  visible,
  onAspect,
  onPress,
}: {
  tile: DeviceTileItem;
  wide: boolean;
  connection: StimConnection | null;
  visible: boolean;
  onAspect: (key: string, aspect: number) => void;
  onPress: () => void;
}) {
  const colors = useColors();
  const { item, device } = tile;
  const streams = device.owned && !device.physical;
  const { frame, error } = useFrameSnapshot(
    connection,
    item.env.path,
    device.platform,
    device.slot,
    visible && streams,
    REFRESH_MS,
  );
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : 0.46;
  useEffect(() => {
    if (frame) onAspect(tile.key, aspect);
  }, [frame, aspect, tile.key, onAspect]);
  const where = [item.title, item.env.worktree?.branch].filter(Boolean).join(' \u00B7 ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${device.model}, ${where}, on ${item.macName}`}
      style={({ pressed }) => [styles.tile, wide && styles.wide, pressed && styles.pressed]}
    >
      <Card style={styles.card}>
        <View style={[styles.screen, { backgroundColor: colors.screen }]}>
          {frame ? (
            <Image
              source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
              style={{ height: SCREEN_HEIGHT - 16, maxWidth: '100%', aspectRatio: aspect, borderRadius: 6 }}
              contentFit="contain"
              transition={0}
            />
          ) : (
            <Text style={[styles.placeholder, { color: colors.tertiary }]}>
              {streams ? (error ?? 'Waiting for a frame') : 'Frames are only served for devices Stim owns.'}
            </Text>
          )}
        </View>
        {frame && error ? (
          <Text style={[styles.stale, { color: colors.warn }]} numberOfLines={2}>
            {error}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Text style={[styles.model, { color: colors.text }]} numberOfLines={1}>
            {device.model}
          </Text>
          <Text style={[styles.detail, { color: colors.secondary }]} numberOfLines={1}>
            {where}
          </Text>
          <View style={styles.mac}>
            <Icon name="laptopcomputer" size={13} color={colors.tertiary} />
            <Text style={[styles.detail, { color: colors.tertiary }]} numberOfLines={1}>
              {item.macName}
            </Text>
          </View>
          <View style={styles.badge}>
            <ActivityChip activity={device.activity} />
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, maxWidth: '50%' },
  wide: { maxWidth: '100%' },
  card: { flex: 1 },
  pressed: { opacity: 0.7 },
  screen: { height: SCREEN_HEIGHT, alignItems: 'center', justifyContent: 'center', padding: 8 },
  placeholder: { fontSize: 12, textAlign: 'center', paddingHorizontal: 8 },
  meta: { padding: 10, gap: 2 },
  stale: { fontSize: 11, paddingHorizontal: 10, paddingTop: 8 },
  model: { fontSize: 14, fontWeight: '600' },
  detail: { fontSize: 12, flexShrink: 1 },
  mac: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  badge: { flexDirection: 'row', marginTop: 4 },
});
