import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Image } from 'expo-image';
import { memo, useEffect, useRef } from 'react';
import { View, type ViewInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivityChip } from '@/components/activity-chip';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useFrameSnapshot } from '@/hooks/frames';
import { useMachineLink } from '@/hooks/machines';
import type { DeviceTileItem, HomeItem } from '@/lib/home';
import { shortUrl, streamsFrames, unservedReason } from '@/lib/workspaces';

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
  const { connection, state: link } = useMachineLink(tile.item.macId);
  const { item, device } = tile;
  const streams = streamsFrames(device, link.kind === 'open' ? link.features : null);
  const { frame, error } = useFrameSnapshot(
    connection,
    item.env.path,
    device.platform,
    device.slot,
    visible && streams,
    REFRESH_MS,
    device.physical,
  );
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : device.platform === 'web' ? 1.6 : 0.46;
  useEffect(() => {
    if (frame) onAspect(tile.key, aspect);
  }, [frame, aspect, tile.key, onAspect]);
  const where = [...new Set([item.title, item.project])].join(' \u00B7 ');
  const thumbnail = useRef<ViewInstance>(null);
  const target = {
    macId: item.macId,
    workspace: item.env.path,
    platform: device.platform,
    slot: device.slot,
    physical: device.physical,
  };
  const zoomedAway = useZoomedAway(zoomKey(target));
  const { model } = device;
  const { macName } = item;
  const tileLabel = t`${model}, ${where}, on ${macName}`;
  const openLabel = t`Open the live screen of ${model}`;
  const openLive = () => {
    if (frame) openDeviceViewer(thumbnail.current, target, frame);
  };
  return (
    <Card
      onPress={() => onOpen(item, false)}
      accessibilityLabel={tileLabel}
      accessibilityActions={frame ? [{ name: 'live', label: openLabel }] : undefined}
      onAccessibilityAction={openLive}
      style={[styles.tile, wide && styles.wide]}
    >
      {/*
        Fabric hoists the children of a View with only a background into the Card, a Gesture Handler button on iOS.
        The button keeps its underlay CALayer at sublayer index 0, and UIKit's insertSubview:atIndex: counts that
        layer, so a frame mounted after the placeholder lands below this background. collapsable={false} keeps the
        frame inside this View.
      */}
      <View style={styles.screen} collapsable={false}>
        {frame ? (
          <Touch
            ref={thumbnail}
            onPress={openLive}
            accessibilityLabel={openLabel}
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
            {streams ? (error ?? t`Waiting for a frame`) : unservedReason(device)}
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
          {device.physical ? device.name : device.model}
        </Text>
        {device.physical && device.name !== device.model ? (
          <Text variant="caption" tone="secondary" style={styles.shrink} numberOfLines={1}>
            {device.model}
          </Text>
        ) : null}
        {device.page ? (
          <Text variant="caption" tone="secondary" style={styles.shrink} numberOfLines={1} ellipsizeMode="middle">
            {shortUrl(device.page.url)}
          </Text>
        ) : null}
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
          {device.physical ? (
            <Pill>
              <Trans>Physical</Trans>
            </Pill>
          ) : null}
          {device.page?.error ? (
            <Pill tone="warning">
              <Trans>Page failed to load</Trans>
            </Pill>
          ) : null}
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
  badge: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs, marginTop: theme.space.xs },
}));
