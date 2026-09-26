import { Image } from 'expo-image';
import { memo, useEffect, useRef } from 'react';
import { View, type ViewInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivityChip } from '@/components/activity-chip';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useFrameSnapshot, useMachineLink } from '@/hooks/mac-connection';
import type { DeviceTileItem, HomeItem } from '@/lib/home';

const SCREEN_HEIGHT = 250;
const REFRESH_MS = 2000;

interface TileProps {
  tile: DeviceTileItem;
  wide: boolean;
  visible: boolean;
  onAspect: (key: string, aspect: number) => void;
  onOpen: (item: HomeItem, errors: boolean) => void;
}

const sameTile = (a: TileProps, b: TileProps) =>
  a.tile.key === b.tile.key &&
  a.tile.item === b.tile.item &&
  a.wide === b.wide &&
  a.visible === b.visible &&
  a.onAspect === b.onAspect &&
  a.onOpen === b.onOpen;

export const DeviceGridTile = memo(function DeviceGridTile({ tile, wide, visible, onAspect, onOpen }: TileProps) {
  const { theme } = useUnistyles();
  const { connection } = useMachineLink(tile.item.macId);
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
  const where = [...new Set([item.title, item.project])].join(' \u00B7 ');
  const thumbnail = useRef<ViewInstance>(null);
  const target = { macId: item.macId, workspace: item.env.path, platform: device.platform, slot: device.slot };
  const zoomedAway = useZoomedAway(zoomKey(target));
  return (
    <Card
      onPress={() => onOpen(item, false)}
      accessibilityLabel={`${device.model}, ${where}, on ${item.macName}`}
      style={[styles.tile, wide && styles.wide]}
    >
      <View style={styles.screen}>
        {frame ? (
          <Touch
            ref={thumbnail}
            onPress={() => openDeviceViewer(thumbnail.current, target, frame)}
            accessibilityLabel={`Open the live screen of ${device.model}`}
            style={{ height: SCREEN_HEIGHT - 16, maxWidth: '100%', aspectRatio: aspect }}
          >
            <Image
              source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
              style={[styles.frame, zoomedAway && styles.away]}
              contentFit="contain"
              transition={0}
            />
          </Touch>
        ) : (
          <Text variant="caption" tone="tertiary" style={styles.placeholder}>
            {streams ? (error ?? 'Waiting for a frame') : 'Frames are only served for devices Stim owns.'}
          </Text>
        )}
      </View>
      {frame && error ? (
        <Text variant="caption2" tone="warning" style={styles.stale} numberOfLines={2}>
          {error}
        </Text>
      ) : null}
      <View style={styles.meta}>
        <Text variant="callout" weight="semibold" numberOfLines={1}>
          {device.model}
        </Text>
        <Text variant="caption" tone="secondary" style={styles.shrink} numberOfLines={1} ellipsizeMode="middle">
          {item.title}
        </Text>
        <View style={styles.mac}>
          <Icon name="laptopcomputer" size={13} color={theme.colors.tertiary} />
          <Text variant="caption" tone="tertiary" style={styles.shrink} numberOfLines={1}>
            {item.macName}
          </Text>
        </View>
        <View style={styles.badge}>
          <ActivityChip activity={device.activity} />
        </View>
      </View>
    </Card>
  );
}, sameTile);

const styles = StyleSheet.create((theme) => ({
  tile: { flex: 1, maxWidth: '50%' },
  wide: { maxWidth: '100%' },
  away: { opacity: 0 },
  screen: {
    height: SCREEN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.md,
    backgroundColor: theme.media.screen,
  },
  frame: { ...StyleSheet.absoluteFillObject, borderRadius: theme.radius.small },
  placeholder: { textAlign: 'center', paddingHorizontal: theme.space.md },
  meta: { padding: theme.space.md, gap: theme.space.xxs },
  stale: { paddingHorizontal: theme.space.md, paddingTop: theme.space.md },
  shrink: { flexShrink: 1 },
  mac: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  badge: { flexDirection: 'row', marginTop: theme.space.xs },
}));
