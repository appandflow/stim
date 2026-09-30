import { t } from '@lingui/core/macro';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { memo, useEffect, useRef } from 'react';
import { View, type ViewInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentSessionLine } from '@/components/agent-sessions';
import { Card } from '@/components/card';
import { PlatformLogo } from '@/components/platform-logo';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useFrameSnapshot } from '@/hooks/frames';
import { useMachineLink, usePairedMacs } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { agentWebUrl, agentsSummary, workspaceAgentSessions } from '@/lib/agents';
import { deviceTileName, deviceTileState } from '@/lib/device-tile';
import type { DeviceTileItem, HomeItem } from '@/lib/home';
import { deviceTileStatusLabels } from '@/lib/spoken-status';
import { runningBuild, streamsFrames, unservedReason } from '@/lib/workspaces';

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
  const showsMachine = (usePairedMacs()?.length ?? 0) > 1;
  const { connection, state: link } = useMachineLink(tile.item.macId);
  const { item, device } = tile;
  const now = useNow(runningBuild(item.env, device) ? 1_000 : 30_000);
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
  const { name, detail } = deviceTileName(device);
  const state = deviceTileState(device, item.env, now);
  const context = [item.project !== item.title ? item.project : null, showsMachine ? item.macName : null]
    .filter(Boolean)
    .join(' \u00B7 ');
  const sessions = workspaceAgentSessions(item.env);
  const sessionUrl = sessions[0] ? agentWebUrl(sessions[0]) : null;
  const thumbnail = useRef<ViewInstance>(null);
  const target = {
    macId: item.macId,
    workspace: item.env.path,
    platform: device.platform,
    slot: device.slot,
    physical: device.physical,
  };
  const zoomedAway = useZoomedAway(zoomKey(target));
  const { macName } = item;
  const where = [...new Set([item.title, item.project])].join(', ');
  const deviceLabel = detail ? `${name}, ${detail}` : name;
  const workspaceLabel = showsMachine ? t`workspace ${where}, on ${macName}` : t`workspace ${where}`;
  const tileLabel = [
    deviceLabel,
    ...deviceTileStatusLabels(device, now, item.env),
    workspaceLabel,
    agentsSummary(sessions),
  ]
    .filter(Boolean)
    .join(', ');
  const openLabel = t`Open the live screen of ${name}`;
  const openSessionLabel = t`Open the agent session`;
  const openLive = () => {
    if (frame) openDeviceViewer(thumbnail.current, target, frame);
  };
  const openSession = () => {
    if (sessionUrl) void Linking.openURL(sessionUrl);
  };
  const actions = [
    ...(frame ? [{ name: 'live', label: openLabel }] : []),
    ...(sessionUrl ? [{ name: 'session', label: openSessionLabel }] : []),
  ];
  return (
    <Card
      onPress={() => onOpen(item, false)}
      accessibilityLabel={tileLabel}
      accessibilityActions={actions.length ? actions : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'live') openLive();
        if (event.nativeEvent.actionName === 'session') openSession();
      }}
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
        <View style={styles.name}>
          <PlatformLogo platform={device.platform} size={14} color={theme.colors.text} />
          <Text variant="callout" weight="semibold" style={styles.shrink} numberOfLines={1}>
            {name}
            {detail ? (
              <Text variant="callout" tone="secondary">
                {` \u00B7 ${detail}`}
              </Text>
            ) : null}
          </Text>
        </View>
        <Text variant="caption" weight="medium" tone={state.tone} style={styles.state} numberOfLines={2}>
          {state.text}
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={1} ellipsizeMode="middle">
          {item.title}
        </Text>
        {context ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {context}
          </Text>
        ) : null}
        {sessions.length ? (
          sessionUrl ? (
            <Touch onPress={openSession} accessibilityRole="link" accessibilityLabel={openSessionLabel}>
              <AgentSessionLine sessions={sessions} variant="caption" tone="secondary" />
            </Touch>
          ) : (
            <AgentSessionLine sessions={sessions} variant="caption" tone="secondary" />
          )
        ) : null}
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
  name: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  state: { marginVertical: theme.space.xs },
}));
