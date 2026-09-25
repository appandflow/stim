import { Image } from 'expo-image';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { PixelRatio, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';

import { useDeviceStream, type DeviceStream } from '@/hooks/device-stream';
import type { Platform } from '@/protocol/types';
import { useColors } from '@/theme';
import { StimVideoView } from '../../modules/stim-video/src';

const VIDEO_FPS = 60;
const EDGE = { min: 240, max: 2048 };

/**
 * A live device screen, fitted to the view's bounds at the device's aspect ratio: H.264 video when the server
 * offers it, JPEG frames otherwise. `children` are laid over the fitted screen, so touch overlays share its
 * coordinates.
 */
export function DeviceScreen({
  workspace,
  platform,
  slot,
  label,
  style,
  children,
}: {
  workspace: string;
  platform: Platform;
  slot: string;
  label: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const colors = useColors();
  const streamId = useId();
  const window = useWindowDimensions();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const maxEdge = Math.round(
    Math.min(EDGE.max, Math.max(EDGE.min, Math.max(window.width, window.height) * PixelRatio.get())),
  );
  const stream = useDeviceStream(streamId, { workspace, platform, slot }, { enabled: true, fps: VIDEO_FPS, maxEdge });
  const source = stream.video ?? stream.frame;
  const aspect = source && source.height > 0 ? source.width / source.height : platform === 'ios' ? 0.46 : 0.45;
  const fitted =
    bounds.width <= 0 || bounds.height <= 0
      ? { width: 0, height: 0 }
      : bounds.width / bounds.height > aspect
        ? { width: bounds.height * aspect, height: bounds.height }
        : { width: bounds.width, height: bounds.width / aspect };
  return (
    <View
      style={[styles.root, style]}
      onLayout={(event) => setBounds(event.nativeEvent.layout)}
      accessibilityLabel={`Live screen of ${label}`}
    >
      <View style={[fitted, styles.screen]}>
        <StimVideoView streamId={streamId} style={StyleSheet.absoluteFill} onKeyframeNeeded={stream.requestKeyframe} />
        {stream.frame && !stream.video ? (
          <Image
            source={{ uri: `data:${stream.frame.mime};base64,${stream.frame.data}` }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            transition={0}
          />
        ) : null}
        {!source ? (
          <Text style={[styles.placeholder, { color: colors.tertiary }]}>{stream.error ?? 'Waiting for frames'}</Text>
        ) : null}
        {children}
        {__DEV__ ? (
          <StreamStats meter={stream.meter} mode={stream.video ? 'video' : stream.frame ? 'jpeg' : null} />
        ) : null}
      </View>
    </View>
  );
}

function StreamStats({ meter, mode }: { meter: DeviceStream['meter']; mode: 'video' | 'jpeg' | null }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const show = () => {
      if (mode !== 'video') return setText(mode === 'jpeg' ? 'JPEG' : '');
      const { fps, kbps, latencyMs } = meter.stats();
      setText(`H.264 ${fps.toFixed(0)} fps ${kbps.toFixed(0)} kbps ${latencyMs?.toFixed(0) ?? '-'} ms`);
    };
    show();
    const timer = setInterval(show, 500);
    return () => clearInterval(timer);
  }, [meter, mode]);
  return text ? (
    <Text style={styles.stats} pointerEvents="none">
      {text}
    </Text>
  ) : null;
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  screen: { backgroundColor: 'black', overflow: 'hidden', justifyContent: 'center' },
  placeholder: { fontSize: 13, textAlign: 'center', position: 'absolute', left: 12, right: 12 },
  stats: {
    position: 'absolute',
    top: 4,
    left: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    color: 'white',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
});
