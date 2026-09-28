import { useEffect, useRef, useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import type { Replay } from '@/hooks/device-stream';
import {
  MARKER_TITLES,
  markerSeek,
  positionOf,
  recordedLength,
  replayLabel,
  shortDuration,
  timeAt,
  type Timeline,
} from '@/lib/replay';
import type { ReplayMarker, ReplayRate } from '@/protocol/types';

const DRAG_SEEK_MS = 120;
const DRAG_SLOP = 6;
const MARKER_REACH = 14;
const TRACK_HEIGHT = 44;
const GAP_LABEL_WIDTH = 96;

/**
 * Live pill, play and pause, speed, and a scrubber over the device's recorded footage with its agent actions
 * and errors as markers. Without a timeline, while replay shows footage that is gone, only the Live pill. Dragging shows the frame under the finger; tapping near a marker lands just before it,
 * and tapping elsewhere shows the frame there. The track takes every touch itself, so a tap is one seek.
 */
export function ReplayBar({
  timeline,
  markers,
  replay,
  canGoLive,
  onSeek,
  onLive,
  onScrubbing,
}: {
  timeline: Timeline | null;
  markers: ReplayMarker[];
  replay: Replay | null;
  /** False while the device is not running, so only its recording can be shown. */
  canGoLive: boolean;
  onSeek: (at: number, rate: ReplayRate) => void;
  onLive: () => void;
  /** A finger is on the track, so gestures around the bar should wait. */
  onScrubbing: (scrubbing: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const lastSeek = useRef(0);
  const touch = useRef<{ x: number; dragged: boolean } | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const at = replay?.at ?? null;
  if (at !== null && at !== lastAt) setLastAt(at);
  const isLive = replay === null && canGoLive;
  const livePill = (
    <Touch
      onPress={onLive}
      disabled={!replay || !canGoLive}
      defaultOpacity={canGoLive ? 1 : theme.opacity.disabled}
      accessibilityRole="button"
      accessibilityLabel={isLive ? 'Live' : canGoLive ? 'Go live' : 'Live, device stopped'}
      accessibilityState={{ selected: isLive, disabled: !replay || !canGoLive }}
      style={styles.live(isLive)}
      hitSlop={6}
    >
      <View style={styles.liveDot(isLive)} />
      <Text variant="caption" weight="semibold" style={styles.liveText(isLive)}>
        Live
      </Text>
    </Touch>
  );
  if (!timeline) {
    return (
      <View style={styles.root}>
        <View style={styles.controls}>{livePill}</View>
      </View>
    );
  }
  const shownAt = at ?? lastAt;
  const position = dragging ?? (replay ? (shownAt === null ? 1 : positionOf(timeline, shownAt)) : 1);
  const playing = replay !== null && replay.rate > 0 && !replay.ended;

  const fractionAt = (x: number) => Math.min(1, Math.max(0, x / (width || 1)));
  const drag = (x: number, final: boolean) => {
    const fraction = fractionAt(x);
    setDragging(final ? null : fraction);
    const stamp = Date.now();
    if (!final && stamp - lastSeek.current < DRAG_SEEK_MS) return;
    lastSeek.current = stamp;
    onSeek(timeAt(timeline, fraction), 0);
  };
  const tap = (x: number) => {
    let near: ReplayMarker | null = null;
    let nearest = MARKER_REACH;
    for (const marker of markers) {
      const distance = Math.abs(positionOf(timeline, marker.at) * width - x);
      if (distance <= nearest) {
        near = marker;
        nearest = distance;
      }
    }
    onSeek(near ? markerSeek(timeline, near) : timeAt(timeline, fractionAt(x)), 0);
  };
  const end = () => {
    touch.current = null;
    setDragging(null);
    onScrubbing(false);
  };
  const track = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (event: GestureResponderEvent) => {
      touch.current = { x: event.nativeEvent.locationX, dragged: false };
      onScrubbing(true);
    },
    onResponderMove: (event: GestureResponderEvent) => {
      const current = touch.current;
      if (!current) return;
      if (!current.dragged && Math.abs(event.nativeEvent.locationX - current.x) < DRAG_SLOP) return;
      current.dragged = true;
      drag(event.nativeEvent.locationX, false);
    },
    onResponderRelease: (event: GestureResponderEvent) => {
      if (touch.current?.dragged) drag(event.nativeEvent.locationX, true);
      else if (touch.current) tap(touch.current.x);
      end();
    },
    onResponderTerminate: end,
  };
  const togglePlay = () => {
    if (!replay) return onSeek(timeline.start, speed);
    if (playing) return onSeek(at ?? timeline.start, 0);
    const from = replay.ended || at === null ? timeline.start : at;
    onSeek(from, speed);
  };
  const toggleSpeed = () => {
    const next = speed === 1 ? 2 : 1;
    setSpeed(next);
    if (playing && at !== null) onSeek(at, next);
  };

  return (
    <View style={styles.root}>
      <View style={styles.controls}>
        {livePill}
        <Touch
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          style={styles.round}
          hitSlop={6}
        >
          <Text weight="semibold" style={styles.mediaText}>
            {playing ? '❚❚' : '▶'}
          </Text>
        </Touch>
        <Touch
          onPress={toggleSpeed}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${speed}x`}
          style={styles.round}
          hitSlop={6}
        >
          <Text variant="caption" weight="semibold" style={styles.mediaText}>
            {`${speed}x`}
          </Text>
        </Touch>
        <Text variant="caption" style={styles.time} numberOfLines={1}>
          {replay
            ? at === null
              ? 'Loading...'
              : `${replayLabel(at, now)}${replay.ended ? ' · end' : ''}`
            : `Replay ${shortDuration(recordedLength(timeline))} recorded`}
        </Text>
      </View>
      <View
        style={styles.track}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        {...track}
      >
        {timeline.pieces.map((piece) => (
          <View
            key={`${piece.kind}-${piece.start}`}
            pointerEvents="none"
            style={[
              piece.kind === 'span' ? styles.span : styles.gap,
              { left: piece.from * width, width: Math.max(1, (piece.to - piece.from) * width) },
            ]}
          >
            {piece.kind === 'gap' ? (
              <Text variant="caption2" style={styles.gapText} numberOfLines={1}>
                {`stopped ${shortDuration(piece.end - piece.start)}`}
              </Text>
            ) : null}
          </View>
        ))}
        <View pointerEvents="none" style={[styles.played, { width: position * width }]} />
        {markers.map((marker, index) => (
          <View
            key={`${index}-${marker.at}`}
            pointerEvents="none"
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${MARKER_TITLES[marker.kind]}: ${marker.label}`}
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={() => onSeek(markerSeek(timeline, marker), 0)}
            style={[styles.markerHit, { left: positionOf(timeline, marker.at) * width - 6 }]}
          >
            <View
              style={[
                styles.marker,
                {
                  backgroundColor:
                    marker.kind === 'action'
                      ? theme.colors.accent
                      : marker.kind === 'crash'
                        ? theme.colors.error
                        : theme.colors.warning,
                },
              ]}
            />
          </View>
        ))}
        <View
          pointerEvents="none"
          style={[styles.thumb, { left: position * width - 7 }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Recording timeline"
          accessibilityValue={{ text: at !== null ? replayLabel(at, now) : 'Live' }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            const step = event.nativeEvent.actionName === 'increment' ? 0.05 : -0.05;
            onSeek(timeAt(timeline, Math.min(1, Math.max(0, position + step))), 0);
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { paddingHorizontal: theme.space.xl, paddingVertical: theme.space.sm, gap: theme.space.sm },
  controls: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  mediaText: { color: theme.media.text },
  live: (on: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    height: 28,
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.round,
    backgroundColor: on ? theme.colors.error : theme.media.fill,
  }),
  liveDot: (on: boolean) => ({
    width: 6,
    height: 6,
    borderRadius: theme.radius.round,
    backgroundColor: on ? theme.media.text : theme.media.textTertiary,
  }),
  liveText: (on: boolean) => ({ color: on ? theme.media.text : theme.media.textSecondary }),
  round: {
    minWidth: 36,
    height: 28,
    paddingHorizontal: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.round,
    backgroundColor: theme.media.fill,
  },
  time: { flex: 1, color: theme.media.textSecondary, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: TRACK_HEIGHT, justifyContent: 'center' },
  span: {
    position: 'absolute',
    top: TRACK_HEIGHT / 2 - 3,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.media.fill,
  },
  gap: {
    position: 'absolute',
    top: TRACK_HEIGHT / 2 - 1,
    height: 2,
    alignItems: 'center',
    borderStyle: 'dashed',
    borderTopWidth: 1,
    borderColor: theme.media.textTertiary,
  },
  gapText: {
    position: 'absolute',
    top: 6,
    width: GAP_LABEL_WIDTH,
    textAlign: 'center',
    color: theme.media.textTertiary,
  },
  played: {
    position: 'absolute',
    left: 0,
    top: TRACK_HEIGHT / 2 - 1,
    height: 2,
    backgroundColor: theme.media.textSecondary,
  },
  markerHit: { position: 'absolute', top: TRACK_HEIGHT / 2 - 10, width: 12, height: 20, alignItems: 'center' },
  marker: { width: 3, height: 20, borderRadius: 1.5 },
  thumb: {
    position: 'absolute',
    top: TRACK_HEIGHT / 2 - 7,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.media.text,
  },
}));
