import { useEffect, useRef, useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import type { Replay } from '@/hooks/device-stream';
import {
  buildTimeline,
  layoutGapLabels,
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

/**
 * Live pill, play and pause, speed, and a scrubber over the device's recorded footage with its agent actions
 * and errors as markers. Without a timeline, while replay shows footage that is gone, only the Live pill. Dragging shows the frame under the finger; tapping near a marker lands just before it,
 * and tapping elsewhere shows the frame there. The track takes every touch itself, so a tap is one seek. While the
 * device runs, the track ends at the Mac's time now, estimated from the last `timeline` and the time since it came;
 * a finger on the track holds the track still until it lifts.
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
  const [received, setReceived] = useState({ timeline, at: now });
  if (received.timeline !== timeline) setReceived({ timeline, at: now });
  const [held, setHeld] = useState<Timeline | null>(null);
  const [trackLength, setTrackLength] = useState<number | undefined>(undefined);
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
  const liveEnd = canGoLive ? timeline.end + Math.max(0, now - received.at) : undefined;
  const track = held ?? buildTimeline(timeline.spans, liveEnd, trackLength) ?? timeline;
  if (track.length !== trackLength) setTrackLength(track.length);
  const shownAt = at ?? lastAt;
  const position = dragging ?? (replay ? (shownAt === null ? 1 : positionOf(track, shownAt)) : 1);
  const playing = replay !== null && replay.rate > 0 && !replay.ended;
  const showsPause = playing || isLive;
  const footageFrom = track.pieces[0]?.from ?? 0;

  const fractionAt = (x: number) => Math.min(1, Math.max(0, x / (width || 1)));
  const drag = (x: number, final: boolean) => {
    const fraction = fractionAt(x);
    setDragging(final ? null : fraction);
    const stamp = Date.now();
    if (!final && stamp - lastSeek.current < DRAG_SEEK_MS) return;
    lastSeek.current = stamp;
    onSeek(timeAt(track, fraction), 0);
  };
  const tap = (x: number) => {
    let near: ReplayMarker | null = null;
    let nearest = MARKER_REACH;
    for (const marker of markers) {
      const distance = Math.abs(positionOf(track, marker.at) * width - x);
      if (distance <= nearest) {
        near = marker;
        nearest = distance;
      }
    }
    onSeek(near ? markerSeek(track, near) : timeAt(track, fractionAt(x)), 0);
  };
  const end = () => {
    touch.current = null;
    setDragging(null);
    setHeld(null);
    onScrubbing(false);
  };
  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (event: GestureResponderEvent) => {
      touch.current = { x: event.nativeEvent.locationX, dragged: false };
      setHeld(track);
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
    if (isLive) return onSeek(track.end, 0);
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
          accessibilityLabel={showsPause ? 'Pause' : 'Play'}
          style={styles.round}
          hitSlop={6}
        >
          <Text weight="semibold" style={styles.mediaText}>
            {showsPause ? '❚❚' : '▶'}
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
        {...responder}
      >
        {track.pieces.map((piece) => (
          <View
            key={`${piece.kind}-${piece.start}`}
            pointerEvents="none"
            style={[
              piece.kind === 'span' ? styles.span : piece.collapsed ? styles.collapsedGap : styles.gap,
              { left: piece.from * width, width: Math.max(1, (piece.to - piece.from) * width) },
            ]}
          />
        ))}
        {layoutGapLabels(track.pieces, width).map((label) => (
          <Text
            key={`label-${label.start}`}
            variant="caption2"
            pointerEvents="none"
            style={[styles.gapText, { left: label.left, width: label.width }]}
            numberOfLines={1}
          >
            {label.text}
          </Text>
        ))}
        <View
          pointerEvents="none"
          style={[styles.played, { left: footageFrom * width, width: Math.max(0, position - footageFrom) * width }]}
        />
        {markers.map((marker, index) => (
          <View
            key={`${index}-${marker.at}`}
            pointerEvents="none"
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${MARKER_TITLES[marker.kind]}: ${marker.label}`}
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={() => onSeek(markerSeek(track, marker), 0)}
            style={[styles.markerHit, { left: positionOf(track, marker.at) * width - 6 }]}
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
            onSeek(timeAt(track, Math.min(1, Math.max(0, position + step))), 0);
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
    top: TRACK_HEIGHT / 2 - 0.5,
    height: 1,
    backgroundColor: theme.media.textTertiary,
  },
  collapsedGap: {
    position: 'absolute',
    top: TRACK_HEIGHT / 2 - 1,
    height: 2,
    borderStyle: 'dashed',
    borderTopWidth: 1,
    borderColor: theme.media.textTertiary,
  },
  gapText: {
    position: 'absolute',
    top: TRACK_HEIGHT / 2 + 8,
    textAlign: 'center',
    color: theme.media.textTertiary,
  },
  played: {
    position: 'absolute',
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
