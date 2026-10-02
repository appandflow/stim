import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  PixelRatio,
  Platform as OS,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type TextInputInstance,
  type ViewInstance,
} from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  useExclusiveGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { scheduleOnRN } from 'react-native-worklets';
import { useHinges } from 'react-native-hinges';
import { useReservedRegions } from 'react-native-reserved-regions';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';

import { Button } from '@/components/button';
import { AgentFeed } from '@/components/agent-feed';
import { DeviceScreen } from '@/components/device-screen';
import { Icon } from '@/components/icon';
import { ScrollView } from '@/components/lists';
import { Pill } from '@/components/pill';
import { ReplayBar } from '@/components/replay-bar';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { ViewerBackdrop } from '@/components/viewer-backdrop';
import { withAlpha } from '@/design/color';
import { useAutoHide } from '@/hooks/auto-hide';
import { useDeviceStream, useReplayAt } from '@/hooks/device-stream';
import { useReplayRange } from '@/hooks/replay-range';
import { useAnnounce, useScreenReaderEnabled } from '@/hooks/screen-reader';
import { LANDED_SCREEN_RADIUS, useDeviceZoom, zoomKey } from '@/hooks/device-zoom';
import { useScreenZoom } from '@/hooks/screen-zoom';
import { grantCommand, readOnlyReason, allowControlSteps } from '@/components/read-only';
import { useDeviceControl } from '@/hooks/device-control';
import { useMacConnection, useWorkspace } from '@/hooks/machines';
import { useSettings, type VideoQuality } from '@/hooks/settings';
import { framePoint, keyboardDelta, orientationOf, otherDriver } from '@/lib/device-control';
import { foldOf } from '@/lib/fold';
import { buildTimeline } from '@/lib/replay';
import { LIVE_VIEW, replayView } from '@/lib/replay-view';
import { aspectOf, liftAbove } from '@/lib/zoom';
import { workspaceTitleAt } from '@/lib/workspace-names';
import { devicesOf, shortUrl, streamsFrames, unservedReason } from '@/lib/workspaces';
import type { DevicePlatform, DevicePosture, InputButton, ReplayRate, RotateDirection } from '@/protocol/types';

const LIVE_FPS = 60;
const MAX_EDGE = 1600;
const MOVE_INTERVAL_MS = 16;

const DATA_SAVER_FPS = 10;
const DATA_SAVER_MAX_EDGE = 640;
const TYPING_BAR_HEIGHT = 56;
const MIN_TARGET = 44;
const ROTATE_WAIT_MS = 2500;
const ROTATE_NOTE_MS = 4000;
const ROTATE_NOTE_SCREEN_READER_MS = 16_000;
const NOTE_INSET = 64;
const SIDE_WIDTH = 208;
const CONTROLS_FADE_MS = 200;
const CONTROLS_MIN_WIDTH = 320;

/** Maps the Settings screen's video quality choice to the fps, max edge and codecs requested from the server. */
const QUALITY_PRESETS: Record<VideoQuality, { fps: number; maxEdge: number | null; video: 'h264'[] }> = {
  auto: { fps: LIVE_FPS, maxEdge: null, video: ['h264'] },
  high: { fps: LIVE_FPS, maxEdge: MAX_EDGE, video: ['h264'] },
  dataSaver: { fps: DATA_SAVER_FPS, maxEdge: DATA_SAVER_MAX_EDGE, video: [] },
};

function postureLabel(posture: DevicePosture): string {
  switch (posture) {
    case 'folded':
      return t`Fold`;
    case 'half-open':
      return t`Half open`;
    case 'unfolded':
      return t`Unfold`;
  }
}

function orientationName(orientation: 'landscape' | 'portrait'): string {
  return orientation === 'landscape' ? t`landscape` : t`portrait`;
}

export function DeviceView({
  workspace,
  platform,
  slot,
  physical = false,
}: {
  workspace: string;
  platform: DevicePlatform;
  slot: string;
  physical?: boolean;
}) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const window = useWindowDimensions();
  const landscape = window.width > window.height;
  const [rootHeight, setRootHeight] = useState(0);
  const [rootWidth, setRootWidth] = useState(0);
  const fold = foldOf(useReservedRegions(), rootWidth || window.width, rootHeight || window.height);
  const book = fold?.axis === 'vertical' ? fold : null;
  const halfOpen = useHinges()[0]?.status === 'partiallyOpen';
  const table = fold?.axis === 'horizontal' && halfOpen ? fold : null;
  const sideBySide = (landscape && !table) || book !== null;
  const { videoQuality } = useSettings();
  const preset = QUALITY_PRESETS[videoQuality];
  const windowMaxEdge = Math.min(MAX_EDGE, Math.round(Math.max(window.width, window.height) * PixelRatio.get()));
  const maxEdge = preset.maxEdge ?? windowMaxEdge;
  const { id: macId } = useLocalSearchParams<{ id?: string }>();
  const item = useWorkspace(macId ?? '', workspace);
  const env = item?.env;
  const device = env
    ? devicesOf(env).find(
        (entry) => entry.platform === platform && entry.slot === slot && Boolean(entry.physical) === physical,
      )
    : undefined;
  const { mac, state: link, connection } = useMacConnection();
  const running = Boolean(device?.running && streamsFrames(device, link.kind === 'open' ? link.features : null));
  const viewOnly = physical && platform === 'ios';
  const slotRange = useReplayRange({ workspace, platform, slot });
  const range = physical ? null : slotRange;
  const replayOff = !physical && env?.recording?.enabled === false;
  const timeline = useMemo(() => (range && !replayOff ? buildTimeline(range.spans) : null), [range, replayOff]);
  const hasFootage = timeline !== null && preset.video.length > 0;
  const [view, setView] = useState(LIVE_VIEW);
  const replayStart = hasFootage ? view.startAt : null;
  const streams = running || replayStart !== null;
  const [scrubbing, setScrubbing] = useState(false);
  const streamOptions = useMemo(
    () => ({ enabled: streams, fps: preset.fps, maxEdge, video: preset.video, startAt: replayStart }),
    [streams, preset.fps, maxEdge, preset.video, replayStart],
  );
  const stream = useDeviceStream({ workspace, platform, slot, physical }, streamOptions);
  const canReplay = hasFootage && stream.replayable !== false;
  const replaying = stream.replay !== null;
  const resumeAt = useReplayAt(view.replayedLive && !running ? stream.playhead : null);
  const synced = replayView(view, {
    type: 'sync',
    replaying,
    running,
    at: resumeAt,
    timelineStart: timeline?.start ?? null,
  });
  if (synced !== view) setView(synced);
  const source = stream.video ?? stream.frame;
  const control = useDeviceControl(workspace, platform, slot, physical);
  const readOnly = !viewOnly && control.allowed === false;
  const [copied, setCopied] = useState(false);
  const deviceId = link.kind === 'open' ? link.deviceId : null;
  const controlling = control.state.kind === 'on';
  const [ownLease, setOwnLease] = useState<string | null>(null);
  const leaseSince = control.state.kind === 'on' ? control.state.leaseSince : null;
  if (leaseSince && leaseSince !== ownLease) setOwnLease(leaseSince);
  const driver = otherDriver(device?.activity, leaseSince ?? ownLease);
  const insets = useSafeAreaInsets();
  const root = useRef<ViewInstance>(null);
  const stage = useRef<ViewInstance>(null);
  const screenZoom = useScreenZoom(!controlling && streams);
  const replayPlaying = stream.replay !== null && stream.replay.rate > 0 && !stream.replay.ended;
  const controls = useAutoHide(scrubbing || (stream.replay !== null && !replayPlaying), !controlling);
  const hideControls = controls.hide;
  useEffect(() => {
    if (controlling) hideControls();
  }, [controlling, hideControls]);
  const reduceMotion = useReducedMotion();
  const controlsFade = useAnimatedStyle(() => ({
    opacity: withTiming(controls.shown ? 1 : 0, { duration: reduceMotion ? 0 : CONTROLS_FADE_MS }),
  }));
  const revealTap = useTapGesture({
    enabled: !controlling && streams,
    onActivate: () => {
      'worklet';
      scheduleOnRN(controls.toggle);
    },
  });
  const screenGesture = useExclusiveGestures(screenZoom.gesture, revealTap);
  const zoom = useDeviceZoom(
    zoomKey({ macId: mac?.id ?? '', workspace, platform, slot, physical }),
    aspectOf(source),
    platform === 'web' ? 1.6 : platform === 'ios' ? 0.46 : 0.45,
    !controlling && !((sideBySide || table) && readOnly) && !screenZoom.zoomed && !scrubbing,
    root,
    stage,
    screenZoom.lens,
  );
  const [underBar, setUnderBar] = useState(false);
  const zoomScale = screenZoom.lens.scale;
  useAnimatedReaction(
    () => zoomScale.get() > 1.001,
    (now, before) => {
      if (now !== before) scheduleOnRN(setUnderBar, now);
    },
  );
  const snapshot = zoom.landed && source ? null : zoom.snapshot;
  const screen = zoom.screenSize;
  const keyboard = useRef<TextInputInstance>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [moving, setMoving] = useState<DevicePosture | null>(null);
  const [barBottom, setBarBottom] = useState(0);
  const [bannerHeight, setBannerHeight] = useState(0);
  const [barSides, setBarSides] = useState<[number, number]>([0, 0]);
  const { height: keyboardHeight, shown: keyboardShown } = useKeyboardHeight();
  const typingBarShown = typing && keyboardShown;
  useEffect(() => {
    if (!keyboardShown || !controlling) keyboard.current?.blur();
  }, [keyboardShown, controlling]);
  const rest = zoom.screenRect;
  const headerGap = theme.space.md;
  const lift = useAnimatedStyle(() => {
    const covered = keyboardHeight.get();
    if (!rest || covered <= 0 || rootHeight <= 0) return { transform: [{ translateY: 0 }] };
    const shift = liftAbove(
      rest[1],
      rest[3],
      rootHeight - covered - TYPING_BAR_HEIGHT,
      insets.top + barBottom + headerGap,
    );
    return { transform: [{ translateY: -shift }] };
  });
  const typingBar = useAnimatedStyle(() => ({ transform: [{ translateY: -keyboardHeight.get() }] }));
  const [rotateNote, setRotateNote] = useState<{ text: string; turned: boolean } | null>(null);
  useAnnounce(rest ? rotateNote?.text : null);
  const screenReader = useScreenReaderEnabled();
  useEffect(() => {
    if (!rotateNote) return;
    const timer = setTimeout(() => setRotateNote(null), screenReader ? ROTATE_NOTE_SCREEN_READER_MS : ROTATE_NOTE_MS);
    return () => clearTimeout(timer);
  }, [rotateNote, screenReader]);
  const orientation = orientationOf(source);
  const [rotating, setRotating] = useState<'landscape' | 'portrait' | null>(null);
  if (rotating && orientation && orientation !== rotating) {
    setRotating(null);
    const name = orientationName(orientation);
    setRotateNote({ text: t`Rotated to ${name}`, turned: true });
  }
  useEffect(() => {
    if (!rotating) return;
    const timer = setTimeout(() => {
      const name = orientationName(rotating);
      setRotateNote({
        text: t`The screen stayed in ${name}. The app in front may not support rotating.`,
        turned: false,
      });
      setRotating(null);
    }, ROTATE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [rotating]);
  const rotate = (direction: RotateDirection) => {
    control.rotate(direction);
    setRotateNote(null);
    setRotating(orientation);
  };

  const touches = useRef({ active: false, lastMove: 0, pending: null as { x: number; y: number } | null });
  const point = (x: number, y: number, clamp: boolean) =>
    source && screen ? framePoint(x, y, screen, source, clamp) : null;
  const touchHandlers = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderGrant: (event: GestureResponderEvent) => {
      const at = point(event.nativeEvent.locationX, event.nativeEvent.locationY, false);
      touches.current = { active: at !== null, lastMove: Date.now(), pending: at };
      if (at) control.touch('down', at.x, at.y);
    },
    onResponderMove: (event: GestureResponderEvent) => {
      if (!touches.current.active) return;
      const at = point(event.nativeEvent.locationX, event.nativeEvent.locationY, true);
      if (!at) return;
      touches.current.pending = at;
      const now = Date.now();
      if (now - touches.current.lastMove < MOVE_INTERVAL_MS) return;
      touches.current.lastMove = now;
      control.touch('move', at.x, at.y);
    },
    onResponderRelease: (event: GestureResponderEvent) => {
      if (!touches.current.active) return;
      const at = point(event.nativeEvent.locationX, event.nativeEvent.locationY, true) ?? touches.current.pending;
      touches.current.active = false;
      if (at) control.touch('up', at.x, at.y);
    },
    onResponderTerminate: () => {
      const at = touches.current.pending;
      if (!touches.current.active || !at) return;
      touches.current.active = false;
      control.touch('up', at.x, at.y);
    },
  };

  const takeOver = () => {
    const driverName = driver ?? t`Another client`;
    Alert.alert(
      t`Take over this device?`,
      t`${driverName} is driving it. Your touches and keys can interfere with its work.`,
      [
        { text: t`Cancel`, style: 'cancel' },
        {
          text: t`Take over`,
          style: 'destructive',
          onPress: () => control.begin(true),
        },
      ],
    );
  };
  const seek = (at: number, rate: ReplayRate) => {
    if (controlling) control.end();
    setView((current) => replayView(current, { type: 'seek', at, running, hasFootage }));
    stream.seek(at, rate);
  };
  const goLive = () => {
    if (view.startAt !== null) return setView((current) => replayView(current, { type: 'live' }));
    stream.live();
  };
  const toggle = () => {
    if (control.state.kind === 'starting') return;
    if (controlling) return control.end();
    setTyped('');
    if (driver) return takeOver();
    control.begin(false);
  };
  const press = (button: InputButton) => control.button(button);
  const postures = control.state.kind === 'on' ? control.state.postures : [];
  const shown = stream.frame?.posture ?? stream.video?.posture;
  const move = (posture: DevicePosture) => {
    setMoving(posture);
    control
      .posture(posture)
      .catch((cause: Error) => Alert.alert(t`Posture not changed`, cause.message))
      .finally(() => setMoving(null));
  };
  const readOnlyBanner = readOnly ? (
    <View style={styles.banner(true)}>
      <View style={styles.bannerBody}>
        <Text weight="semibold" style={styles.mediaText}>
          {readOnlyReason()}
        </Text>
        <Text variant="footnote" style={styles.mediaText}>
          {allowControlSteps(mac?.name, deviceId)}
        </Text>
        <View style={styles.bannerActions}>
          {deviceId ? (
            <Button
              title={copied ? t`Copied` : t`Copy command`}
              variant="plain"
              size="small"
              onPress={() => void Clipboard.setStringAsync(grantCommand(deviceId)).then(() => setCopied(true))}
            />
          ) : null}
          <Button title={t`Reconnect`} variant="plain" size="small" onPress={() => connection?.reconnect()} />
        </View>
      </View>
    </View>
  ) : null;
  const replayBar =
    (timeline && canReplay) || replaying ? (
      <ReplayBar
        timeline={canReplay ? timeline : null}
        markers={range?.markers ?? []}
        replay={stream.replay}
        playhead={stream.playhead}
        seeking={stream.seeking}
        canGoLive={running}
        recording={range?.recording ?? false}
        onSeek={seek}
        onLive={goLive}
        onScrubbing={setScrubbing}
      />
    ) : null;
  const agentFeed =
    (!landscape || book || table) && !physical && device?.id && streams ? (
      <AgentFeed
        workspace={workspace}
        slot={slot}
        deviceId={device.id}
        playhead={replaying ? stream.playhead : null}
        onOpen={() =>
          router.push({
            pathname: '/mac/[id]/agent',
            params: { id: mac?.id ?? '', path: workspace, platform, slot, device: device.id ?? '' },
          })
        }
      />
    ) : null;
  const overlayControls = !table && replayBar !== null && streams && rest !== null && rootHeight > 0;
  const buttons =
    controlling || readOnly ? (
      <>
        {controlling && overlayControls && !controls.shown ? (
          <ToolButton label={t`Replay`} onPress={controls.reveal} />
        ) : null}
        <ToolButton
          label={typing ? t`Hide keyboard` : t`Keyboard`}
          disabled={readOnly}
          onPress={() => (typing ? keyboard.current?.blur() : keyboard.current?.focus())}
        />
        {platform !== 'web' ? <ToolButton label={t`Home`} disabled={readOnly} onPress={() => press('home')} /> : null}
        {platform !== 'ios' ? <ToolButton label={t`Back`} disabled={readOnly} onPress={() => press('back')} /> : null}
        {platform === 'android' ? (
          <ToolButton label={t`Apps`} disabled={readOnly} onPress={() => press('app-switch')} />
        ) : null}
        {platform !== 'web' ? <ToolButton label={t`Lock`} disabled={readOnly} onPress={() => press('lock')} /> : null}
        {(platform === 'android' && !physical) || (platform === 'ios' && !postures.length && !shown) ? (
          <>
            <ToolButton label={t`Rotate left`} disabled={readOnly} onPress={() => rotate('left')} />
            <ToolButton label={t`Rotate right`} disabled={readOnly} onPress={() => rotate('right')} />
          </>
        ) : null}
        {postures
          .filter((posture) => platform === 'android' || posture !== shown)
          .map((posture) => (
            <ToolButton
              key={posture}
              label={moving === posture ? t`Moving...` : postureLabel(posture)}
              disabled={moving !== null}
              onPress={() => move(posture)}
            />
          ))}
      </>
    ) : null;
  const toolbars = buttons ? (
    sideBySide ? (
      <View style={styles.toolbar}>{buttons}</View>
    ) : (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.toolScroll}
        contentContainerStyle={styles.toolRow}
      >
        {buttons}
      </ScrollView>
    )
  ) : null;
  const model = device?.page
    ? shortUrl(device.page.url)
    : (device?.model ?? (platform === 'ios' ? t`iOS Simulator` : platform === 'web' ? t`Web` : t`Android Emulator`));
  const title = item?.title ?? workspaceTitleAt(workspace, null);
  const subtitle = platform === 'web' ? t`Web \u00B7 ${model}` : t`${model} \u00B7 ${slot}`;
  const scrubHint = t`Scrub below to replay what it recorded.`;

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <NavigationBar style="light" />
      <GestureDetector gesture={zoom.pan}>
        <View
          ref={root}
          style={styles.root}
          collapsable={false}
          onLayout={(event) => {
            setRootHeight(event.nativeEvent.layout.height);
            setRootWidth(event.nativeEvent.layout.width);
          }}
        >
          <Animated.View style={[styles.backdrop, zoom.fadeStyle]} pointerEvents="none" />
          <Animated.View style={[styles.root, zoom.fadeStyle]}>
            <View
              style={[
                styles.root,
                {
                  paddingTop: insets.top,
                  paddingBottom: insets.bottom,
                  paddingLeft: insets.left,
                  paddingRight: insets.right,
                },
              ]}
            >
              <View style={styles.root}>
                <View style={table ? { height: table.start - insets.top } : styles.root}>
                  <View style={{ height: barBottom + headerGap }} />
                  {sideBySide || table ? null : readOnlyBanner}
                  <View
                    style={book && { width: book.start - insets.left }}
                    onLayout={(event) => setBannerHeight(event.nativeEvent.layout.height)}
                  >
                    <Banner
                      control={control.state}
                      canTakeOver={control.allowed === true && !replaying}
                      readOnly={readOnly}
                      onTakeOver={takeOver}
                    />
                    {stream.delayed || replayOff ? (
                      <View style={styles.chips}>
                        {stream.delayed ? (
                          <Pill tone="warning">{stream.delayedReason ?? t`Screen updates delayed`}</Pill>
                        ) : null}
                        {replayOff ? (
                          <Pill>
                            <Trans>Replay off</Trans>
                          </Pill>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  <View style={sideBySide ? styles.row : styles.root}>
                    <View
                      ref={stage}
                      style={[
                        styles.stage,
                        book && { flex: 0, width: book.start - insets.left },
                        table && {
                          maxHeight: Math.max(0, table.start - insets.top - barBottom - headerGap - bannerHeight),
                        },
                      ]}
                      onLayout={barBottom > 0 ? zoom.measure : undefined}
                      collapsable={false}
                    >
                      {streams ? null : (
                        <Text style={styles.placeholder}>
                          {device?.running ? unservedReason(device) : (device?.state ?? t`This device is not running.`)}
                          {canReplay ? ` ${scrubHint}` : ''}
                        </Text>
                      )}
                    </View>
                    {book ? (
                      <View style={[styles.pane, { marginLeft: book.end - book.start }]}>
                        <ScrollView style={styles.root} contentContainerStyle={styles.sideContent}>
                          {readOnlyBanner}
                          {toolbars}
                        </ScrollView>
                        {agentFeed}
                      </View>
                    ) : landscape && !table ? (
                      controlling || readOnly ? (
                        <ScrollView style={styles.side} contentContainerStyle={styles.sideContent}>
                          {readOnlyBanner}
                          {toolbars}
                        </ScrollView>
                      ) : null
                    ) : table ? null : (
                      toolbars
                    )}
                  </View>
                </View>
                {table ? (
                  <>
                    <View style={{ height: table.end - table.start }} />
                    <ScrollView style={styles.root} contentContainerStyle={styles.sideContent}>
                      {readOnlyBanner}
                      {toolbars}
                    </ScrollView>
                  </>
                ) : null}
                {overlayControls || !replayBar ? null : (
                  <View style={book && { width: book.start - insets.left }}>{replayBar}</View>
                )}
                {book ? null : agentFeed}
              </View>
            </View>
          </Animated.View>
          {streams ? (
            <GestureDetector gesture={screenGesture}>
              <View
                style={[StyleSheet.absoluteFill, table && { bottom: rootHeight - table.start }]}
                pointerEvents="box-none"
              >
                <Animated.View style={[styles.flying, zoom.screenStyle, lift]}>
                  <DeviceScreen
                    stream={stream}
                    label={model}
                    style={StyleSheet.absoluteFill}
                    requested={{ fps: preset.fps, maxEdge }}
                  >
                    {snapshot ? (
                      <Image
                        source={{ uri: `data:${snapshot.mime};base64,${snapshot.data}` }}
                        style={StyleSheet.absoluteFill}
                        contentFit="contain"
                        transition={0}
                      />
                    ) : null}
                    {source ? (
                      <View
                        style={[styles.overlay, controlling && styles.overlayActive]}
                        pointerEvents={controlling ? 'auto' : 'none'}
                        {...(controlling ? touchHandlers : {})}
                      />
                    ) : null}
                  </DeviceScreen>
                </Animated.View>
              </View>
            </GestureDetector>
          ) : null}
          <Animated.View
            style={[
              styles.header,
              {
                paddingTop: insets.top,
                paddingLeft: insets.left,
                paddingRight: book ? 0 : insets.right,
                right: book ? rootWidth - book.start : 0,
              },
              zoom.fadeStyle,
            ]}
          >
            {underBar ? <ViewerBackdrop /> : null}
            <View style={styles.bar} onLayout={(event) => setBarBottom(event.nativeEvent.layout.height)}>
              <Touch
                onLayout={(event) => {
                  const { width } = event.nativeEvent.layout;
                  setBarSides(([, right]) => [width, right]);
                }}
                onPress={() => {
                  Keyboard.dismiss();
                  keyboardHeight.set(withTiming(0, { duration: 200 }));
                  zoom.close();
                }}
                accessibilityLabel={t`Close`}
                style={styles.barButton}
              >
                <Icon name="xmark" size={22} color={theme.media.text} />
              </Touch>
              <View
                style={[
                  styles.titles,
                  {
                    paddingLeft: Math.max(0, barSides[1] - barSides[0]),
                    paddingRight: Math.max(0, barSides[0] - barSides[1]),
                  },
                ]}
              >
                <Text
                  variant="body"
                  weight="semibold"
                  style={styles.mediaText}
                  numberOfLines={1}
                  maxFontSizeMultiplier={BAR_MAX_FONT_SCALE}
                >
                  {title}
                </Text>
                <View style={styles.subtitleRow}>
                  <Text
                    variant="caption"
                    style={styles.subtitle}
                    numberOfLines={1}
                    maxFontSizeMultiplier={BAR_MAX_FONT_SCALE}
                  >
                    {subtitle}
                  </Text>
                  {range?.recording && !replayOff ? (
                    <View style={styles.driver} accessible accessibilityLabel={t`Recording for replay`}>
                      <View style={styles.recordingDot} />
                      <Text
                        variant="caption2"
                        weight="medium"
                        style={styles.driverText}
                        numberOfLines={1}
                        maxFontSizeMultiplier={BAR_MAX_FONT_SCALE}
                      >
                        <Trans>Recording</Trans>
                      </Text>
                    </View>
                  ) : null}
                  {driver ? (
                    <View
                      style={styles.driver}
                      accessible
                      accessibilityLabel={controlling ? t`Also driven by ${driver}` : t`Driven by ${driver}`}
                    >
                      <Icon name="cursorarrow.rays" size={11} color={theme.colors.accent} />
                      <Text
                        variant="caption2"
                        weight="medium"
                        style={styles.driverText}
                        numberOfLines={1}
                        maxFontSizeMultiplier={BAR_MAX_FONT_SCALE}
                      >
                        {driver}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <View
                onLayout={(event) => {
                  const { width } = event.nativeEvent.layout;
                  setBarSides(([left]) => [left, width]);
                }}
              >
                {!viewOnly && control.allowed !== null ? (
                  <ControlButton on={controlling} disabled={readOnly || replaying} onPress={toggle} />
                ) : null}
              </View>
            </View>
          </Animated.View>
          {overlayControls && rest ? (
            <Animated.View
              pointerEvents={controls.shown ? 'box-none' : 'none'}
              accessibilityElementsHidden={!controls.shown}
              importantForAccessibility={controls.shown ? 'auto' : 'no-hide-descendants'}
              style={[
                styles.controlsLayer,
                {
                  ...controlsSpan(rest[0], rest[2], insets.left, book ? book.start : window.width - insets.right),
                  bottom: rootHeight - rest[1] - rest[3],
                },
                zoom.fadeStyle,
                lift,
              ]}
            >
              <Animated.View
                style={[
                  styles.controlsPanel,
                  rest[2] >= CONTROLS_MIN_WIDTH && styles.controlsPanelRounded,
                  controlsFade,
                ]}
                onTouchStart={controls.reveal}
              >
                {replayBar}
              </Animated.View>
            </Animated.View>
          ) : null}
          {rotateNote && rest ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.noteRow,
                { top: rest[1] + rest[3] - NOTE_INSET, left: rest[0], width: rest[2] },
                zoom.fadeStyle,
                lift,
              ]}
            >
              <Text
                variant="footnote"
                weight="semibold"
                tone={rotateNote.turned ? 'success' : 'warning'}
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={styles.note}
              >
                {rotateNote.text}
              </Text>
            </Animated.View>
          ) : null}
          <Animated.View
            style={[
              styles.typingBar,
              { paddingLeft: theme.space.xl + insets.left, paddingRight: theme.space.xl + insets.right },
              typingBar,
              !typingBarShown && styles.hidden,
            ]}
            pointerEvents={typingBarShown ? 'auto' : 'none'}
            accessibilityElementsHidden={!typingBarShown}
            importantForAccessibility={typingBarShown ? 'auto' : 'no-hide-descendants'}
          >
            <TextInput
              ref={keyboard}
              style={styles.typed}
              placeholder={t`Type on the device`}
              placeholderTextColor={withAlpha(theme.media.text, theme.opacity.disabled)}
              value={typed}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="ascii-capable"
              disableFullscreenUI
              submitBehavior="submit"
              onChangeText={(next) => {
                const delta = keyboardDelta(typed, next);
                setTyped(next);
                if (delta) control.text(delta);
              }}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === 'Backspace' && typed === '') control.text('\b');
              }}
              onSubmitEditing={() => {
                setTyped('');
                control.text('\n');
              }}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              accessibilityLabel={t`Type on the device`}
            />
            <Touch onPress={() => keyboard.current?.blur()} style={styles.typingDone}>
              <Text weight="semibold" tone="brand">
                <Trans>Done</Trans>
              </Text>
            </Touch>
          </Animated.View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

function Banner({
  control,
  canTakeOver,
  readOnly,
  onTakeOver,
}: {
  control: ReturnType<typeof useDeviceControl>['state'];
  canTakeOver: boolean;
  readOnly: boolean;
  onTakeOver: () => void;
}) {
  const { theme } = useUnistyles();
  const ended = control.kind === 'off' ? control.ended : undefined;
  const message =
    control.kind === 'busy'
      ? control.message
      : control.kind === 'failed'
        ? control.message
        : ended
          ? t`Control ended. ${ended}`
          : control.kind === 'starting'
            ? t`Starting control...`
            : null;
  if (!message) return null;
  const offer = (canTakeOver || readOnly) && control.kind === 'busy';
  return (
    <View style={styles.banner(control.kind === 'failed')}>
      <Text variant="footnote" style={[styles.mediaText, styles.bannerText]}>
        {message}
      </Text>
      {offer ? (
        <Touch
          onPress={onTakeOver}
          disabled={readOnly}
          defaultOpacity={readOnly ? theme.opacity.disabled : 1}
          accessibilityHint={readOnly ? readOnlyReason() : undefined}
          style={styles.bannerButton}
        >
          <Text weight="semibold" tone="brand" style={readOnly && styles.mutedAction}>
            <Trans>Take over</Trans>
          </Text>
        </Touch>
      ) : null}
    </View>
  );
}

const BAR_MAX_FONT_SCALE = 1.5;

function ControlButton({ on, disabled, onPress }: { on: boolean; disabled: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      defaultOpacity={disabled ? theme.opacity.disabled : 1}
      accessibilityRole="switch"
      accessibilityLabel={t`Control`}
      accessibilityState={{ checked: on, disabled }}
      hitSlop={7}
      style={styles.control(on)}
    >
      {on ? <Icon name="checkmark" size={13} color={theme.colors.onPrimary} /> : null}
      <Text weight="semibold" style={styles.controlText(on)} maxFontSizeMultiplier={BAR_MAX_FONT_SCALE}>
        <Trans>Control</Trans>
      </Text>
    </Touch>
  );
}

function controlsSpan(left: number, width: number, from: number, to: number) {
  const span = Math.min(Math.max(width, CONTROLS_MIN_WIDTH), to - from);
  return { left: Math.min(Math.max(left + width / 2 - span / 2, from), to - span), width: span };
}

function ToolButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { theme } = useUnistyles();
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      defaultOpacity={disabled ? theme.opacity.disabled : 1}
      accessibilityState={{ disabled }}
      style={styles.tool}
    >
      <Text weight="medium" style={styles.mediaText}>
        {label}
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.media.screen,
  },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.xs,
  },
  titles: { flex: 1, alignItems: 'center' },
  mediaText: { color: theme.media.text },
  subtitle: { color: theme.media.textTertiary, flexShrink: 1 },
  subtitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: theme.space.md,
    maxWidth: '100%',
  },
  driver: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    paddingHorizontal: theme.space.sm,
    paddingVertical: 1,
    borderRadius: theme.radius.chip,
    backgroundColor: theme.media.fill,
  },
  recordingDot: { width: 6, height: 6, borderRadius: theme.radius.round, backgroundColor: theme.colors.error },
  driverText: { color: theme.media.textSecondary },
  chips: {
    flexDirection: 'row',
    gap: theme.space.md,
    paddingHorizontal: theme.space.xl,
    paddingBottom: theme.space.sm,
  },
  controlsLayer: { position: 'absolute' },
  controlsPanel: {
    overflow: 'hidden',
    backgroundImage: 'linear-gradient(to bottom, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.7) 65%, rgba(0, 0, 0, 0.78))',
  },
  controlsPanelRounded: {
    borderBottomLeftRadius: LANDED_SCREEN_RADIUS,
    borderBottomRightRadius: LANDED_SCREEN_RADIUS,
  },
  noteRow: { position: 'absolute', alignItems: 'center', paddingHorizontal: theme.space.xl },
  note: {
    overflow: 'hidden',
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderRadius: theme.radius.control,
    backgroundColor: theme.media.note,
    textAlign: 'center',
  },
  row: { flex: 1, flexDirection: 'row' },
  side: { width: SIDE_WIDTH, flexGrow: 0 },
  pane: { flex: 1 },
  sideContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.space.md },
  stage: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  flying: { position: 'absolute', overflow: 'hidden' },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  overlayActive: { borderColor: theme.colors.primary },
  placeholder: { color: theme.media.textTertiary, textAlign: 'center', paddingHorizontal: theme.space.xxxl },
  banner: (warning: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    marginHorizontal: theme.space.xl,
    marginBottom: theme.space.sm,
    padding: theme.space.md,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: warning ? theme.colors.warning : theme.colors.border,
    backgroundColor: theme.media.fillSubtle,
  }),
  bannerText: { flex: 1 },
  bannerBody: { flex: 1, gap: theme.space.xs },
  bannerActions: { flexDirection: 'row', gap: theme.space.xxl, paddingTop: theme.space.xs },
  bannerButton: {
    minWidth: MIN_TARGET,
    minHeight: MIN_TARGET,
    paddingHorizontal: theme.space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mutedAction: { color: theme.media.textTertiary },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  toolScroll: { flexGrow: 0 },
  toolRow: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  tool: {
    minWidth: MIN_TARGET,
    minHeight: MIN_TARGET,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.round,
    backgroundColor: theme.media.fill,
  },
  barButton: {
    width: MIN_TARGET,
    height: MIN_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typingDone: {
    minWidth: MIN_TARGET,
    minHeight: MIN_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  control: (on: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    height: 30,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.round,
    backgroundColor: on ? theme.colors.primary : theme.media.fill,
  }),
  controlText: (on: boolean) => ({ color: on ? theme.colors.onPrimary : theme.media.text }),
  typingBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: TYPING_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    backgroundColor: theme.media.bar,
  },
  hidden: { opacity: 0 },
  typed: {
    flex: 1,
    height: 40,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.control,
    backgroundColor: theme.media.fill,
    color: theme.media.text,
    fontSize: theme.typography.body.fontSize,
  },
}));

function useKeyboardHeight(): { height: SharedValue<number>; shown: boolean } {
  const height = useSharedValue(0);
  const [shown, setShown] = useState(false);
  // React Native's Android keyboard events report the IME inset minus the system bars' bottom inset.
  const { bottom } = useSafeAreaInsets();
  const barInset = OS.OS === 'android' ? bottom : 0;
  useEffect(() => {
    const show = OS.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = OS.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subscriptions = [
      Keyboard.addListener(show, (event) => {
        setShown(true);
        height.set(withTiming(event.endCoordinates.height + barInset, { duration: event.duration || 250 }));
      }),
      Keyboard.addListener(hide, (event) => {
        setShown(false);
        height.set(withTiming(0, { duration: event.duration || 250 }));
      }),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [height, barInset]);
  return { height, shown };
}
