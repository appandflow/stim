import { t } from '@lingui/core/macro';
import { Image } from 'expo-image';
import { useEffect, useState, type ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { BrandAnimation, deviceWaitAnimation } from '@/components/brand-animation';
import { Text } from '@/components/text';
import type { DeviceStream } from '@/hooks/device-stream';
import type { DevicePlatform } from '@/protocol/types';
import { StimVideoView, supportsFrameOrientation } from '../../modules/stim-video/src';

/**
 * A device's live `stream`, filling the view, which the caller sizes to the device's aspect ratio: H.264 video
 * when the server offers it, JPEG frames otherwise. `children` are laid over the screen, so touch overlays share
 * its coordinates.
 */
export function DeviceScreen({
  stream,
  recorded = false,
  label,
  style,
  children,
  requested,
  platform,
}: {
  stream: DeviceStream;
  recorded?: boolean;
  label: string;
  style?: ViewProps['style'];
  children?: ReactNode;
  /** The fps and max edge asked of the server, shown in the dev-only stats overlay next to the measured rate. */
  requested?: { fps: number; maxEdge: number };
  platform?: DevicePlatform;
}) {
  const [animationFits, setAnimationFits] = useState(false);
  const source = stream.video ?? stream.frame;
  const screenLabel = recorded ? t`Recorded screen of ${label}` : t`Live screen of ${label}`;
  return (
    <View
      style={[styles.screen, style]}
      accessibilityLabel={screenLabel}
      onLayout={({ nativeEvent: { layout } }) => setAnimationFits(layout.width >= 150 && layout.height >= 230)}
    >
      <StimVideoView
        streamId={stream.streamId}
        style={StyleSheet.absoluteFill}
        onKeyframeNeeded={stream.requestKeyframe}
        {...(supportsFrameOrientation ? { onOrientationCleared: stream.orientationCleared } : {})}
      />
      {stream.frame && !stream.video ? (
        <Image
          key={stream.frame.duo?.revision ?? 'raw'}
          source={{ uri: `data:${stream.frame.mime};base64,${stream.frame.data}` }}
          recyclingKey={`${stream.streamId}/${stream.frame.duo?.revision ?? stream.frame.artworkTurns ?? ''}/${stream.frame.width}x${stream.frame.height}`}
          onDisplay={stream.frame.duo ? () => stream.frameDisplayed(stream.frame!.duo!.revision) : undefined}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={0}
        />
      ) : null}
      {!source ? (
        <View style={styles.placeholder} pointerEvents="none">
          {!stream.error && animationFits ? (
            <BrandAnimation name={deviceWaitAnimation(platform)} playing width={112} onDark />
          ) : null}
          <Text variant="footnote" tone="tertiary" style={styles.placeholderText}>
            {stream.error ?? t`Waiting for frames`}
          </Text>
        </View>
      ) : null}
      {children}
      {__DEV__ ? (
        <StreamStats
          meter={stream.meter}
          mode={stream.video ? 'video' : stream.frame ? 'jpeg' : null}
          requested={requested}
        />
      ) : null}
    </View>
  );
}

function StreamStats({
  meter,
  mode,
  requested,
}: {
  meter: DeviceStream['meter'];
  mode: 'video' | 'jpeg' | null;
  requested?: { fps: number; maxEdge: number };
}) {
  const [text, setText] = useState('');
  const asked = requested ? askedLabel(requested.fps, requested.maxEdge) : '';
  useEffect(() => {
    const show = () => {
      if (mode !== 'video') return setText(mode === 'jpeg' ? t`JPEG${asked}` : '');
      const { fps, kbps, latencyMs } = meter.stats();
      const rate = fps.toFixed(0);
      const bitrate = kbps.toFixed(0);
      const latency = latencyMs?.toFixed(0) ?? '-';
      setText(t`H.264 ${rate} fps ${bitrate} kbps ${latency} ms${asked}`);
    };
    show();
    const timer = setInterval(show, 500);
    return () => clearInterval(timer);
  }, [meter, mode, asked]);
  return text ? (
    <Text variant="caption2" style={styles.stats} pointerEvents="none">
      {text}
    </Text>
  ) : null;
}

const askedLabel = (fps: number, edge: number) => t` (asked ${fps}fps/${edge}px)`;

const styles = StyleSheet.create((theme) => ({
  screen: { backgroundColor: theme.media.frame, overflow: 'hidden', justifyContent: 'center' },
  placeholder: {
    position: 'absolute',
    left: theme.space.lg,
    right: theme.space.lg,
    alignItems: 'center',
    gap: theme.space.sm,
  },
  placeholderText: { textAlign: 'center' },
  stats: {
    position: 'absolute',
    top: theme.space.xs,
    left: theme.space.xs,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xxs,
    borderRadius: theme.radius.small,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
    color: theme.media.text,
    backgroundColor: theme.media.badge,
  },
}));
