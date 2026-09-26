import { Image } from 'expo-image';
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
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { Button } from '@/components/button';
import { DeviceScreen } from '@/components/device-screen';
import { Icon } from '@/components/icon';
import { ScrollView } from '@/components/lists';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { ViewerBackdrop } from '@/components/viewer-backdrop';
import { withAlpha } from '@/design/color';
import { useDeviceStream } from '@/hooks/device-stream';
import { useDeviceZoom, zoomKey } from '@/hooks/device-zoom';
import { useScreenZoom } from '@/hooks/screen-zoom';
import { grantCommand, READ_ONLY_REASON, allowControlSteps } from '@/components/read-only';
import { useDeviceControl, useMacConnection, useStatus } from '@/hooks/mac-connection';
import { useSettings, type VideoQuality } from '@/hooks/settings';
import { framePoint, keyboardDelta, orientationOf, otherDriver } from '@/lib/device-control';
import { aspectOf, liftAbove } from '@/lib/zoom';
import { devicesOf, workspaceTitleAt } from '@/lib/workspaces';
import type { DevicePosture, InputButton, Platform, RotateDirection } from '@/protocol/types';

const LIVE_FPS = 60;
const MAX_EDGE = 1600;
const MOVE_INTERVAL_MS = 16;

const DATA_SAVER_FPS = 10;
const DATA_SAVER_MAX_EDGE = 640;
const TYPING_BAR_HEIGHT = 56;
const ROTATE_WAIT_MS = 2500;
const ROTATE_NOTE_MS = 4000;
const NOTE_INSET = 64;
const SIDE_WIDTH = 208;

/** Maps the Settings screen's video quality choice to the fps, max edge and codecs requested from the server. */
const QUALITY_PRESETS: Record<VideoQuality, { fps: number; maxEdge: number | null; video: 'h264'[] }> = {
  // `maxEdge: null` keeps the window-sized cap computed below.
  auto: { fps: LIVE_FPS, maxEdge: null, video: ['h264'] },
  high: { fps: LIVE_FPS, maxEdge: MAX_EDGE, video: ['h264'] },
  dataSaver: { fps: DATA_SAVER_FPS, maxEdge: DATA_SAVER_MAX_EDGE, video: [] },
};

const POSTURE_LABELS: Record<DevicePosture, string> = {
  folded: 'Fold',
  'half-open': 'Half open',
  unfolded: 'Unfold',
};

export function DeviceView({ workspace, platform, slot }: { workspace: string; platform: Platform; slot: string }) {
  const { theme } = useUnistyles();
  const window = useWindowDimensions();
  const landscape = window.width > window.height;
  const { videoQuality } = useSettings();
  const preset = QUALITY_PRESETS[videoQuality];
  const windowMaxEdge = Math.min(MAX_EDGE, Math.round(Math.max(window.width, window.height) * PixelRatio.get()));
  const maxEdge = preset.maxEdge ?? windowMaxEdge;
  const status = useStatus();
  const env = status?.environments.find((candidate) => candidate.path === workspace);
  const device = env ? devicesOf(env).find((entry) => entry.platform === platform && entry.slot === slot) : undefined;
  const streams = Boolean(device?.running && device.owned && !device.physical);
  const streamOptions = useMemo(
    () => ({ enabled: streams, fps: preset.fps, maxEdge, video: preset.video }),
    [streams, preset.fps, maxEdge, preset.video],
  );
  const stream = useDeviceStream({ workspace, platform, slot }, streamOptions);
  const source = stream.video ?? stream.frame;
  const control = useDeviceControl(workspace, platform, slot);
  const { mac, state: link, connection } = useMacConnection();
  const readOnly = control.allowed === false;
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
  const zoom = useDeviceZoom(
    zoomKey({ macId: mac?.id ?? '', workspace, platform, slot }),
    aspectOf(source),
    platform === 'ios' ? 0.46 : 0.45,
    !controlling && !(landscape && readOnly) && !screenZoom.zoomed,
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
  const [rootHeight, setRootHeight] = useState(0);
  const [barBottom, setBarBottom] = useState(0);
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
  useEffect(() => {
    if (!rotateNote) return;
    const timer = setTimeout(() => setRotateNote(null), ROTATE_NOTE_MS);
    return () => clearTimeout(timer);
  }, [rotateNote]);
  const orientation = orientationOf(source);
  const [rotating, setRotating] = useState<'landscape' | 'portrait' | null>(null);
  if (rotating && orientation && orientation !== rotating) {
    setRotating(null);
    setRotateNote({ text: `Rotated to ${orientation}`, turned: true });
  }
  useEffect(() => {
    if (!rotating) return;
    const timer = setTimeout(() => {
      setRotateNote({
        text: `The screen stayed in ${rotating}. The app in front may not support rotating.`,
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

  const takeOver = () =>
    Alert.alert(
      'Take over this device?',
      `${driver ?? 'Another client'} is driving it. Your touches and keys can interfere with its work.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Take over',
          style: 'destructive',
          onPress: () => control.begin(true),
        },
      ],
    );
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
      .catch((cause: Error) => Alert.alert('Posture not changed', cause.message))
      .finally(() => setMoving(null));
  };
  const readOnlyBanner = readOnly ? (
    <View style={styles.banner(true)}>
      <View style={styles.bannerBody}>
        <Text weight="semibold" style={styles.mediaText}>
          {READ_ONLY_REASON}
        </Text>
        <Text variant="footnote" style={styles.mediaText}>
          {allowControlSteps(mac?.name, deviceId)}
        </Text>
        <View style={styles.bannerActions}>
          {deviceId ? (
            <Button
              title={copied ? 'Copied' : 'Copy command'}
              variant="plain"
              size="small"
              onPress={() => void Clipboard.setStringAsync(grantCommand(deviceId)).then(() => setCopied(true))}
            />
          ) : null}
          <Button title="Reconnect" variant="plain" size="small" onPress={() => connection?.reconnect()} />
        </View>
      </View>
    </View>
  ) : null;
  const buttons =
    controlling || readOnly ? (
      <>
        <ToolButton
          label={typing ? 'Hide keyboard' : 'Keyboard'}
          disabled={readOnly}
          onPress={() => (typing ? keyboard.current?.blur() : keyboard.current?.focus())}
        />
        <ToolButton label="Home" disabled={readOnly} onPress={() => press('home')} />
        {platform === 'android' ? <ToolButton label="Back" disabled={readOnly} onPress={() => press('back')} /> : null}
        {platform === 'android' ? (
          <ToolButton label="Apps" disabled={readOnly} onPress={() => press('app-switch')} />
        ) : null}
        <ToolButton label="Lock" disabled={readOnly} onPress={() => press('lock')} />
        <ToolButton label="Rotate left" disabled={readOnly} onPress={() => rotate('left')} />
        <ToolButton label="Rotate right" disabled={readOnly} onPress={() => rotate('right')} />
        {postures
          .filter((posture) => platform === 'android' || posture !== shown)
          .map((posture) => (
            <ToolButton
              key={posture}
              label={moving === posture ? 'Moving...' : POSTURE_LABELS[posture]}
              disabled={moving !== null}
              onPress={() => move(posture)}
            />
          ))}
      </>
    ) : null;
  const toolbars = buttons ? (
    landscape ? (
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
  const model = device?.model ?? (platform === 'ios' ? 'iOS Simulator' : 'Android Emulator');
  const title = workspaceTitleAt(workspace, status);

  return (
    <GestureHandlerRootView style={styles.root}>
      <GestureDetector gesture={zoom.pan}>
        <View
          ref={root}
          style={styles.root}
          collapsable={false}
          onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}
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
                <View style={{ height: barBottom + headerGap }} />
                {landscape ? null : readOnlyBanner}
                <Banner
                  control={control.state}
                  canTakeOver={control.allowed === true}
                  readOnly={readOnly}
                  onTakeOver={takeOver}
                />
                {stream.delayed ? (
                  <View style={styles.chips}>
                    <Pill tone="warning">Screen updates delayed</Pill>
                  </View>
                ) : null}
                <View style={landscape ? styles.row : styles.root}>
                  <View
                    ref={stage}
                    style={styles.stage}
                    onLayout={barBottom > 0 ? zoom.measure : undefined}
                    collapsable={false}
                  >
                    {streams ? null : (
                      <Text style={styles.placeholder}>{device?.state ?? 'This device is not running.'}</Text>
                    )}
                  </View>
                  {landscape ? (
                    controlling || readOnly ? (
                      <ScrollView style={styles.side} contentContainerStyle={styles.sideContent}>
                        {readOnlyBanner}
                        {toolbars}
                      </ScrollView>
                    ) : null
                  ) : (
                    toolbars
                  )}
                </View>
              </View>
            </View>
          </Animated.View>
          {streams ? (
            <GestureDetector gesture={screenZoom.gesture}>
              <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
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
              { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
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
                accessibilityLabel="Close"
                hitSlop={10}
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
                <Text variant="body" weight="semibold" style={styles.mediaText} numberOfLines={1}>
                  {title}
                </Text>
                <View style={styles.subtitleRow}>
                  <Text variant="caption" style={styles.subtitle} numberOfLines={1}>
                    {`${model} \u00B7 ${slot}`}
                  </Text>
                  {driver ? (
                    <View
                      style={styles.driver}
                      accessible
                      accessibilityLabel={controlling ? `Also driven by ${driver}` : `Driven by ${driver}`}
                    >
                      <View style={styles.driverDot} />
                      <Text variant="caption2" weight="medium" style={styles.driverText} numberOfLines={1}>
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
                {control.allowed !== null ? (
                  <ControlButton on={controlling} disabled={readOnly} onPress={toggle} />
                ) : null}
              </View>
            </View>
          </Animated.View>
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
              placeholder="Type on the device"
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
              accessibilityLabel="Type on the device"
            />
            <Touch onPress={() => keyboard.current?.blur()} hitSlop={8}>
              <Text weight="semibold" tone="brand">
                Done
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
  const message =
    control.kind === 'busy'
      ? control.message
      : control.kind === 'failed'
        ? control.message
        : control.kind === 'off' && control.ended
          ? `Control ended. ${control.ended}`
          : control.kind === 'starting'
            ? 'Starting control...'
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
          defaultOpacity={readOnly ? 0.6 : 1}
          accessibilityHint={readOnly ? READ_ONLY_REASON : undefined}
          style={styles.bannerButton}
          hitSlop={6}
        >
          <Text weight="semibold" tone="brand" style={readOnly && styles.mutedAction}>
            Take over
          </Text>
        </Touch>
      ) : null}
    </View>
  );
}

function ControlButton({ on, disabled, onPress }: { on: boolean; disabled: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      defaultOpacity={disabled ? theme.opacity.disabled : 1}
      accessibilityRole="switch"
      accessibilityLabel="Control"
      accessibilityState={{ checked: on, disabled }}
      hitSlop={7}
      style={styles.control(on)}
    >
      {on ? <Icon name="checkmark" size={13} color={theme.colors.onPrimary} /> : null}
      <Text weight="semibold" style={styles.controlText(on)}>
        Control
      </Text>
    </Touch>
  );
}

function ToolButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      defaultOpacity={disabled ? 0.6 : 1}
      accessibilityState={{ disabled }}
      style={styles.tool}
      hitSlop={4}
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
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md, maxWidth: '100%' },
  driver: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    paddingHorizontal: theme.space.sm,
    paddingVertical: 1,
    borderRadius: theme.radius.chip,
    backgroundColor: theme.media.fill,
  },
  driverDot: { width: 6, height: 6, borderRadius: theme.radius.round, backgroundColor: theme.colors.accent },
  driverText: { color: theme.media.textSecondary },
  chips: { flexDirection: 'row', paddingHorizontal: theme.space.xl, paddingBottom: theme.space.sm },
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
  bannerButton: { paddingHorizontal: theme.space.xs },
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
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.round,
    backgroundColor: theme.media.fill,
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
