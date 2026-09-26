import { Image } from 'expo-image';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type ViewProps } from 'react-native';

import type { DeviceStream } from '@/hooks/device-stream';
import { useColors } from '@/theme';
import { StimVideoView } from '../../modules/stim-video/src';

/**
 * A device's live `stream`, filling the view, which the caller sizes to the device's aspect ratio: H.264 video
 * when the server offers it, JPEG frames otherwise. `children` are laid over the screen, so touch overlays share
 * its coordinates.
 */
export function DeviceScreen({
  stream,
  label,
  style,
  children,
  requested,
}: {
  stream: DeviceStream;
  label: string;
  style?: ViewProps['style'];
  children?: ReactNode;
  /** The fps and max edge asked of the server, shown in the dev-only stats overlay next to the measured rate. */
  requested?: { fps: number; maxEdge: number };
}) {
  const colors = useColors();
  const source = stream.video ?? stream.frame;
  return (
    <View style={[styles.screen, style]} accessibilityLabel={`Live screen of ${label}`}>
      <StimVideoView
        streamId={stream.streamId}
        style={StyleSheet.absoluteFill}
        onKeyframeNeeded={stream.requestKeyframe}
      />
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
  const asked = requested ? ` (asked ${requested.fps}fps/${requested.maxEdge}px)` : '';
  useEffect(() => {
    const show = () => {
      if (mode !== 'video') return setText(mode === 'jpeg' ? `JPEG${asked}` : '');
      const { fps, kbps, latencyMs } = meter.stats();
      setText(`H.264 ${fps.toFixed(0)} fps ${kbps.toFixed(0)} kbps ${latencyMs?.toFixed(0) ?? '-'} ms${asked}`);
    };
    show();
    const timer = setInterval(show, 500);
    return () => clearInterval(timer);
  }, [meter, mode, asked]);
  return text ? (
    <Text style={styles.stats} pointerEvents="none">
      {text}
    </Text>
  ) : null;
}

const styles = StyleSheet.create({
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
