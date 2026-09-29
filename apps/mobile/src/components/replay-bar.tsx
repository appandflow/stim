import { useEffect, useRef, useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import type { Replay } from '@/hooks/device-stream';
import {
  adjacentAction,
  buildTimeline,
  layoutGapLabels,
  MARKER_TITLES,
  markerSeek,
  positionOf,
  replayLabel,
  stepFrom,
  timeAt,
  type Timeline,
} from '@/lib/replay';
import { scrubEndRate, scrubMove, scrubStart, type Scrub } from '@/lib/replay-seek';
import type { ReplayMarker, ReplayRate } from '@/protocol/types';

const MARKER_REACH = 14;
const TRACK_HEIGHT = 44;
/** stim-server's `frames.seek` shows the newest frame for a time past every recording. */
const NEWEST_FRAME = Number.MAX_SAFE_INTEGER;

/**
 * Live pill, play and pause, speed, and a scrubber over the device's recorded footage with its agent actions
 * and errors as markers. Without a timeline, while replay shows footage that is gone, only the Live pill. Dragging
 * pauses and shows the frame under the finger, and lifting the finger plays on when the replay played before the drag;
 * tapping near a marker lands just before it, and tapping elsewhere shows the frame there, both keeping the replay
 * playing or paused. The thumb and time follow the finger and then the last seek, not the server's answers. The track
 * takes every touch itself, so a tap is one seek. While the device runs, the track ends at the Mac's time now,
 * estimated from the last `timeline` and the time since it came; a finger on the track holds the track still until it
 * lifts.
 */
export function ReplayBar({
  timeline,
  markers,
  replay,
  seeking,
  canGoLive,
  recording,
  onSeek,
  onLive,
  onScrubbing,
}: {
  timeline: Timeline | null;
  markers: ReplayMarker[];
  replay: Replay | null;
  /** A seek is out or waiting, so `replay.at` is not yet the frame last asked for. */
  seeking: boolean;
  /** False while the device is not running, so only its recording can be shown. */
  canGoLive: boolean;
  /** stim-server records the device now, so its newest span grows until the next `timeline`. */
  recording: boolean;
  onSeek: (at: number, rate: ReplayRate) => void;
  onLive: () => void;
  /** A finger is on the track, so gestures around the bar should wait. */
  onScrubbing: (scrubbing: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const touch = useRef<Scrub | null>(null);
  const [asked, setAsked] = useState<number | null>(null);
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
  const [stepped, setStepped] = useState<number | null>(null);
  if ((replay === null || replay.ended) && stepped !== null) setStepped(null);
  const at = replay?.at ?? null;
  if (at !== null && at !== lastAt) setLastAt(at);
  if (replay === null && lastAt !== null) setLastAt(null);
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
  const liveEnd = canGoLive && recording ? timeline.end + Math.max(0, now - received.at) : undefined;
  const track = held ?? buildTimeline(timeline.spans, liveEnd, trackLength) ?? timeline;
  if (track.length !== trackLength) setTrackLength(track.length);
  const target = dragging !== null ? timeAt(track, dragging) : seeking ? asked : null;
  const shownAt = target ?? at ?? lastAt;
  const position = dragging ?? (replay ? (shownAt === null ? 1 : positionOf(track, shownAt)) : 1);
  const labelAt = target ?? at;
  const playing = replay !== null && replay.rate > 0 && !replay.ended;
  const showsPause = playing || isLive;
  const footageFrom = track.pieces[0]?.from ?? 0;

  const seekTo = (to: number, rate: ReplayRate, action: number | null = null) => {
    setStepped(action);
    setAsked(Math.min(to, track.end));
    onSeek(to, rate);
  };
  const fractionAt = (x: number) => Math.min(1, Math.max(0, x / (width || 1)));
  const drag = (x: number, rate: ReplayRate | null) => {
    const fraction = fractionAt(x);
    setDragging(rate === null ? fraction : null);
    seekTo(timeAt(track, fraction), rate ?? 0);
  };
  const tap = (x: number, rate: ReplayRate) => {
    let near: ReplayMarker | null = null;
    let nearest = MARKER_REACH;
    for (const marker of markers) {
      const distance = Math.abs(positionOf(track, marker.at) * width - x);
      if (distance <= nearest) {
        near = marker;
        nearest = distance;
      }
    }
    seekTo(near ? markerSeek(track, near) : timeAt(track, fractionAt(x)), rate);
  };
  const release = (x: number) => {
    const current = touch.current;
    if (!current) return;
    const rate = scrubEndRate(current, playing, speed);
    if (current.drag) drag(x, rate);
    else tap(current.x, rate);
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
      touch.current = scrubStart(event.nativeEvent.locationX);
      setHeld(track);
      onScrubbing(true);
    },
    onResponderMove: (event: GestureResponderEvent) => {
      if (!touch.current) return;
      touch.current = scrubMove(touch.current, event.nativeEvent.locationX, playing);
      if (touch.current.drag) drag(event.nativeEvent.locationX, null);
    },
    onResponderRelease: (event: GestureResponderEvent) => {
      release(event.nativeEvent.locationX);
      end();
    },
    onResponderTerminate: () => {
      const current = touch.current;
      if (current?.drag && dragging !== null) seekTo(timeAt(track, dragging), scrubEndRate(current, playing, speed));
      end();
    },
  };
  const from = stepFrom(shownAt ?? track.end, stepped, playing);
  const previousAction = adjacentAction(markers, from, -1);
  const nextAction = adjacentAction(markers, from, 1);
  const step = (target: ReplayMarker | null) => {
    if (!target) return onLive();
    seekTo(markerSeek(track, target), playing ? speed : 0, target.at);
  };
  const togglePlay = () => {
    if (isLive) return seekTo(NEWEST_FRAME, 0);
    if (!replay) return seekTo(timeline.start, speed);
    if (playing) return seekTo(labelAt ?? timeline.start, 0);
    const from = replay.ended || labelAt === null ? timeline.start : labelAt;
    seekTo(from, speed);
  };
  const toggleSpeed = () => {
    const next = speed === 1 ? 2 : 1;
    setSpeed(next);
    if (playing && labelAt !== null) {
      setAsked(labelAt);
      onSeek(labelAt, next);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.controls}>
        {livePill}
        <Touch
          onPress={() => step(previousAction)}
          disabled={isLive || !previousAction}
          accessibilityRole="button"
          accessibilityLabel="Previous agent action"
          accessibilityElementsHidden={isLive}
          importantForAccessibility={isLive ? 'no-hide-descendants' : 'auto'}
          defaultOpacity={isLive ? 0 : previousAction ? 1 : theme.opacity.disabled}
          style={styles.round}
          hitSlop={4}
        >
          <Icon name="backward.end.fill" size={14} color={theme.media.text} />
        </Touch>
        <Touch
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={showsPause ? 'Pause' : 'Play'}
          style={styles.round}
          hitSlop={4}
        >
          <Text weight="semibold" style={styles.mediaText}>
            {showsPause ? '❚❚' : '▶'}
          </Text>
        </Touch>
        <Touch
          onPress={() => step(nextAction)}
          disabled={isLive || (!nextAction && !canGoLive)}
          accessibilityRole="button"
          accessibilityLabel={nextAction || !canGoLive ? 'Next agent action' : 'Next agent action, none; go live'}
          accessibilityElementsHidden={isLive}
          importantForAccessibility={isLive ? 'no-hide-descendants' : 'auto'}
          defaultOpacity={isLive ? 0 : nextAction || canGoLive ? 1 : theme.opacity.disabled}
          style={styles.round}
          hitSlop={4}
        >
          <Icon name="forward.end.fill" size={14} color={theme.media.text} />
        </Touch>
        <Touch
          onPress={toggleSpeed}
          disabled={isLive}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${speed}x`}
          accessibilityElementsHidden={isLive}
          importantForAccessibility={isLive ? 'no-hide-descendants' : 'auto'}
          defaultOpacity={isLive ? 0 : 1}
          style={styles.round}
          hitSlop={4}
        >
          <Text variant="caption" weight="semibold" style={styles.mediaText}>
            {`${speed}x`}
          </Text>
        </Touch>
      </View>
      {replay ? (
        <Text variant="caption" style={styles.time} numberOfLines={1}>
          {labelAt === null
            ? 'Loading...'
            : `${replayLabel(labelAt, now)}${replay.ended && target === null ? ' · end' : ''}`}
        </Text>
      ) : null}
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
            maxFontSizeMultiplier={1}
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
            onAccessibilityAction={() => seekTo(markerSeek(track, marker), 0)}
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
            seekTo(timeAt(track, Math.min(1, Math.max(0, position + step))), 0);
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
  time: { color: theme.media.textSecondary, fontVariant: ['tabular-nums'] },
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
