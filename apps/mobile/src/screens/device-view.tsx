import { Image } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  PixelRatio,
  Platform as OS,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type TextInputInstance,
  type ViewInstance,
} from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { Chip } from '@/components/chip';
import { DeviceScreen } from '@/components/device-screen';
import { Toggle } from '@/components/toggle';
import { useDeviceStream } from '@/hooks/device-stream';
import { useDeviceZoom, zoomKey } from '@/hooks/device-zoom';
import { grantCommand, READ_ONLY_REASON, allowControlSteps } from '@/components/read-only';
import { useDeviceControl, useMacConnection, useStatus } from '@/hooks/mac-connection';
import { useSettings, type VideoQuality } from '@/hooks/settings';
import { framePoint, keyboardDelta, orientationOf, otherDriver } from '@/lib/device-control';
import { aspectOf, liftAbove } from '@/lib/zoom';
import { devicesOf, workspaceTitleAt } from '@/lib/workspaces';
import type { DevicePosture, InputButton, Platform, RotateDirection } from '@/protocol/types';
import { useColors, type Colors } from '@/theme';

const LIVE_FPS = 60;
const MAX_EDGE = 1600;
const MOVE_INTERVAL_MS = 16;

const DATA_SAVER_FPS = 10;
const DATA_SAVER_MAX_EDGE = 640;
const TYPING_BAR_HEIGHT = 56;
const ROTATE_WAIT_MS = 2500;
const ROTATE_NOTE_MS = 4000;
const NOTE_INSET = 64;

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
  const colors = useColors();
  const window = useWindowDimensions();
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
  const driver = otherDriver(device?.activity, control.state.kind === 'on' ? control.state.leaseSince : null);
  const insets = useSafeAreaInsets();
  const root = useRef<ViewInstance>(null);
  const stage = useRef<ViewInstance>(null);
  const zoom = useDeviceZoom(
    zoomKey({ macId: mac?.id ?? '', workspace, platform, slot }),
    aspectOf(source),
    platform === 'ios' ? 0.46 : 0.45,
    !controlling,
    root,
    stage,
  );
  const snapshot = zoom.landed && source ? null : zoom.snapshot;
  const screen = zoom.screenSize;
  const keyboard = useRef<TextInputInstance>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [moving, setMoving] = useState<DevicePosture | null>(null);
  const [tookOver, setTookOver] = useState(false);
  const [rootHeight, setRootHeight] = useState(0);
  const [barBottom, setBarBottom] = useState(0);
  const { height: keyboardHeight, shown: keyboardShown } = useKeyboardHeight();
  const typingBarShown = typing && keyboardShown;
  useEffect(() => {
    if (!keyboardShown || !controlling) keyboard.current?.blur();
  }, [keyboardShown, controlling]);
  const rest = zoom.screenRect;
  const lift = useAnimatedStyle(() => {
    const covered = keyboardHeight.get();
    if (!rest || covered <= 0 || rootHeight <= 0) return { transform: [{ translateY: 0 }] };
    const shift = liftAbove(rest[1], rest[3], rootHeight - covered - TYPING_BAR_HEIGHT, barBottom);
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
          onPress: () => {
            setTookOver(true);
            control.begin(true);
          },
        },
      ],
    );
  const toggle = () => {
    if (control.state.kind === 'starting') return;
    if (controlling) return control.end();
    setTyped('');
    setTookOver(false);
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
          <Animated.View
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.screen }, zoom.fadeStyle]}
            pointerEvents="none"
          />
          <Animated.View style={[styles.root, zoom.fadeStyle]}>
            <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
              <View style={styles.root}>
                <View
                  style={styles.bar}
                  onLayout={(event) => {
                    const { y, height } = event.nativeEvent.layout;
                    setBarBottom(insets.top + y + height);
                  }}
                >
                  <Pressable
                    onPress={() => {
                      Keyboard.dismiss();
                      keyboardHeight.set(withTiming(0, { duration: 200 }));
                      zoom.close();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    hitSlop={10}
                  >
                    <Text style={styles.back}>{'‹'}</Text>
                  </Pressable>
                  <View style={styles.titles}>
                    <Text style={styles.title} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {`${model} · ${slot}`}
                    </Text>
                  </View>
                  {control.allowed !== null ? (
                    <Toggle
                      colors={colors}
                      label={controlling ? 'Control on' : 'Control'}
                      on={controlling}
                      disabled={readOnly}
                      onPress={toggle}
                    />
                  ) : null}
                </View>
                {readOnly ? (
                  <View style={[styles.banner, { borderColor: colors.warn }]}>
                    <View style={styles.bannerBody}>
                      <Text style={styles.bannerTitle}>{READ_ONLY_REASON}</Text>
                      <Text style={styles.bannerSteps}>{allowControlSteps(mac?.name, deviceId)}</Text>
                      <View style={styles.bannerActions}>
                        {deviceId ? (
                          <Pressable
                            onPress={() =>
                              void Clipboard.setStringAsync(grantCommand(deviceId)).then(() => setCopied(true))
                            }
                            accessibilityRole="button"
                            hitSlop={6}
                          >
                            <Text style={[styles.bannerAction, { color: colors.primary }]}>
                              {copied ? 'Copied' : 'Copy command'}
                            </Text>
                          </Pressable>
                        ) : null}
                        <Pressable onPress={() => connection?.reconnect()} accessibilityRole="button" hitSlop={6}>
                          <Text style={[styles.bannerAction, { color: colors.primary }]}>Reconnect</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                ) : null}
                <Banner
                  colors={colors}
                  control={control.state}
                  driver={driver}
                  tookOver={tookOver}
                  canTakeOver={control.allowed === true}
                  readOnly={readOnly}
                  onTakeOver={takeOver}
                />
                {stream.delayed ? (
                  <View style={styles.chips}>
                    <Chip tint={colors.warn}>Screen updates delayed</Chip>
                  </View>
                ) : null}
                <View ref={stage} style={styles.stage} onLayout={zoom.measure} collapsable={false}>
                  {streams ? null : (
                    <Text style={styles.placeholder}>{device?.state ?? 'This device is not running.'}</Text>
                  )}
                </View>
                {controlling || readOnly ? (
                  <View style={styles.toolbar}>
                    <ToolButton
                      label={typing ? 'Hide keyboard' : 'Keyboard'}
                      disabled={readOnly}
                      onPress={() => (typing ? keyboard.current?.blur() : keyboard.current?.focus())}
                    />
                    <ToolButton label="Home" disabled={readOnly} onPress={() => press('home')} />
                    {platform === 'android' ? (
                      <ToolButton label="Back" disabled={readOnly} onPress={() => press('back')} />
                    ) : null}
                    {platform === 'android' ? (
                      <ToolButton label="Apps" disabled={readOnly} onPress={() => press('app-switch')} />
                    ) : null}
                    <ToolButton label="Lock" disabled={readOnly} onPress={() => press('lock')} />
                  </View>
                ) : null}
                {controlling || readOnly ? (
                  <View style={styles.toolbar}>
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
                  </View>
                ) : null}
              </View>
            </View>
          </Animated.View>
          {streams ? (
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
                    style={[styles.overlay, controlling && { borderColor: colors.primary }]}
                    pointerEvents={controlling ? 'auto' : 'none'}
                    {...(controlling ? touchHandlers : {})}
                  />
                ) : null}
              </DeviceScreen>
            </Animated.View>
          ) : null}
          {rotateNote && rest ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.noteRow, { top: rest[1] + rest[3] - NOTE_INSET }, zoom.fadeStyle, lift]}
            >
              <Text
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={[styles.note, { color: rotateNote.turned ? colors.live : colors.warn }]}
              >
                {rotateNote.text}
              </Text>
            </Animated.View>
          ) : null}
          <Animated.View
            style={[styles.typingBar, typingBar, !typingBarShown && styles.hidden]}
            pointerEvents={typingBarShown ? 'auto' : 'none'}
            accessibilityElementsHidden={!typingBarShown}
            importantForAccessibility={typingBarShown ? 'auto' : 'no-hide-descendants'}
          >
            <TextInput
              ref={keyboard}
              style={styles.typed}
              placeholder="Type on the device"
              placeholderTextColor="#FFFFFF66"
              value={typed}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="ascii-capable"
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
            <Pressable onPress={() => keyboard.current?.blur()} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.bannerAction, { color: colors.primary }]}>Done</Text>
            </Pressable>
          </Animated.View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

function Banner({
  colors,
  control,
  driver,
  tookOver,
  canTakeOver,
  readOnly,
  onTakeOver,
}: {
  colors: Colors;
  control: ReturnType<typeof useDeviceControl>['state'];
  driver: string | null;
  tookOver: boolean;
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
            : control.kind === 'on' && driver
              ? tookOver
                ? `You took over from ${driver}. It can still send input to this device.`
                : `${driver} is also driving this device. Its input and yours can interfere.`
              : driver
                ? `Driven by ${driver}. Controlling it from here can interfere with that work.`
                : null;
  if (!message) return null;
  const offer =
    (canTakeOver || readOnly) &&
    (control.kind === 'busy' || (driver !== null && control.kind !== 'starting' && control.kind !== 'on'));
  return (
    <View style={[styles.banner, { borderColor: control.kind === 'failed' ? colors.warn : colors.border }]}>
      <Text style={styles.bannerText}>{message}</Text>
      {offer ? (
        <Pressable
          onPress={onTakeOver}
          disabled={readOnly}
          accessibilityRole="button"
          accessibilityState={{ disabled: readOnly }}
          accessibilityHint={readOnly ? READ_ONLY_REASON : undefined}
          style={[styles.bannerButton, readOnly && styles.pressed]}
          hitSlop={6}
        >
          <Text style={[styles.bannerAction, { color: readOnly ? '#FFFFFF99' : colors.primary }]}>Take over</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ToolButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.tool, (pressed || disabled) && styles.pressed]}
      hitSlop={4}
    >
      <Text style={styles.toolText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  back: { color: '#FFFFFF', fontSize: 32, lineHeight: 32 },
  titles: { flex: 1 },
  title: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  subtitle: { color: '#FFFFFF99', fontSize: 12 },
  chips: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 6 },
  noteRow: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  note: {
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#000000D9',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
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
  placeholder: { color: '#FFFFFF99', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: '#FFFFFF14',
  },
  bannerText: { flex: 1, color: '#FFFFFF', fontSize: 13, lineHeight: 18 },
  bannerBody: { flex: 1, gap: 4 },
  bannerTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  bannerSteps: { color: '#FFFFFF', fontSize: 13, lineHeight: 18 },
  bannerActions: { flexDirection: 'row', gap: 20, paddingTop: 4 },
  bannerButton: { paddingHorizontal: 4 },
  bannerAction: { fontSize: 14, fontWeight: '600' },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  tool: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: '#FFFFFF1F' },
  pressed: { opacity: 0.6 },
  toolText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  typingBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: TYPING_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    backgroundColor: '#1C1C1E',
  },
  hidden: { opacity: 0 },
  typed: {
    flex: 1,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#FFFFFF1F',
    color: '#FFFFFF',
    fontSize: 16,
  },
});

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
