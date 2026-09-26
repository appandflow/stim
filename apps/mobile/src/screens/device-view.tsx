import { router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  PixelRatio,
  Platform as OS,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { DeviceScreen } from '@/components/device-screen';
import { Toggle } from '@/components/toggle';
import { useDeviceStream } from '@/hooks/device-stream';
import { useDeviceControl, useStatus } from '@/hooks/mac-connection';
import { useSettings, type VideoQuality } from '@/hooks/settings';
import { framePoint, keyboardDelta, otherDriver, type Size } from '@/lib/device-control';
import { devicesOf } from '@/lib/workspaces';
import type { InputButton, Platform } from '@/protocol/types';
import { useColors, type Colors } from '@/theme';

const LIVE_FPS = 60;
const MAX_EDGE = 1600;
const MOVE_INTERVAL_MS = 16;

const DATA_SAVER_FPS = 10;
const DATA_SAVER_MAX_EDGE = 640;

/** Maps the Settings screen's video quality choice to the fps, max edge and codecs requested from the server. */
const QUALITY_PRESETS: Record<VideoQuality, { fps: number; maxEdge: number | null; video: 'h264'[] }> = {
  // `maxEdge: null` keeps the window-sized cap computed below.
  auto: { fps: LIVE_FPS, maxEdge: null, video: ['h264'] },
  high: { fps: LIVE_FPS, maxEdge: MAX_EDGE, video: ['h264'] },
  dataSaver: { fps: DATA_SAVER_FPS, maxEdge: DATA_SAVER_MAX_EDGE, video: [] },
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
  const controlling = control.state.kind === 'on';
  const driver = otherDriver(device?.activity, control.state.kind === 'on' ? control.state.leaseSince : null);
  const [screen, setScreen] = useState<Size | null>(null);
  const keyboard = useRef<TextInput>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');

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
        { text: 'Take over', style: 'destructive', onPress: () => control.begin(true) },
      ],
    );
  const toggle = () => {
    if (control.state.kind === 'starting') return;
    if (controlling) return control.end();
    setTyped('');
    control.begin(false);
  };
  const press = (button: InputButton) => control.button(button);
  const title = device?.model ?? (platform === 'ios' ? 'iOS Simulator' : 'Android Emulator');

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.screen }]} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.root} behavior={OS.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.bar}>
          <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}>
            <Text style={styles.back}>{'‹'}</Text>
          </Pressable>
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {slot}
            </Text>
          </View>
          {control.allowed ? (
            <Toggle colors={colors} label={controlling ? 'Control on' : 'Control'} on={controlling} onPress={toggle} />
          ) : null}
        </View>
        <Banner
          colors={colors}
          control={control.state}
          driver={driver}
          canTakeOver={control.allowed === true}
          onTakeOver={takeOver}
        />
        {stream.delayed ? (
          <View style={styles.chips}>
            <Chip tint={colors.warn}>Screen updates delayed</Chip>
          </View>
        ) : null}
        {streams ? (
          <DeviceScreen
            stream={stream}
            platform={platform}
            label={title}
            style={styles.stage}
            requested={{ fps: preset.fps, maxEdge }}
          >
            {source ? (
              <View
                style={[styles.overlay, controlling && { borderColor: colors.primary }]}
                onLayout={(event) => setScreen(event.nativeEvent.layout)}
                pointerEvents={controlling ? 'auto' : 'none'}
                {...(controlling ? touchHandlers : {})}
              />
            ) : null}
          </DeviceScreen>
        ) : (
          <View style={styles.stage}>
            <Text style={styles.placeholder}>{device?.state ?? 'This device is not running.'}</Text>
          </View>
        )}
        {controlling ? (
          <View style={styles.toolbar}>
            <ToolButton
              label={typing ? 'Hide keyboard' : 'Keyboard'}
              onPress={() => (typing ? keyboard.current?.blur() : keyboard.current?.focus())}
            />
            <ToolButton label="Home" onPress={() => press('home')} />
            {platform === 'android' ? <ToolButton label="Back" onPress={() => press('back')} /> : null}
            {platform === 'android' ? <ToolButton label="Apps" onPress={() => press('app-switch')} /> : null}
            <ToolButton label="Lock" onPress={() => press('lock')} />
          </View>
        ) : null}
        <TextInput
          ref={keyboard}
          style={styles.keyboard}
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Banner({
  colors,
  control,
  driver,
  canTakeOver,
  onTakeOver,
}: {
  colors: Colors;
  control: ReturnType<typeof useDeviceControl>['state'];
  driver: string | null;
  canTakeOver: boolean;
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
            : driver
              ? `Driven by ${driver}. Controlling it from here can interfere with that work.`
              : null;
  if (!message) return null;
  const offer = canTakeOver && (control.kind === 'busy' || (driver !== null && control.kind !== 'starting'));
  return (
    <View style={[styles.banner, { borderColor: control.kind === 'failed' ? colors.warn : colors.border }]}>
      <Text style={styles.bannerText}>{message}</Text>
      {offer ? (
        <Pressable onPress={onTakeOver} accessibilityRole="button" style={styles.bannerButton} hitSlop={6}>
          <Text style={[styles.bannerAction, { color: colors.primary }]}>Take over</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ToolButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.tool, pressed && styles.pressed]}
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
  stage: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', margin: 8 },
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
  bannerButton: { paddingHorizontal: 4 },
  bannerAction: { fontSize: 14, fontWeight: '600' },
  toolbar: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  tool: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: '#FFFFFF1F' },
  pressed: { opacity: 0.6 },
  toolText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  keyboard: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, bottom: 0 },
});
