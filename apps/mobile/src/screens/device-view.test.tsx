import 'react-native-unistyles/mocks';

import { fireEvent, render } from '@testing-library/react-native';
import { Alert, Dimensions } from 'react-native';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';

import '@/design/unistyles';

import { DeviceView } from './device-view';

const mockBegin = jest.fn();
const mockRotate = jest.fn();
const mockZoom = jest.fn();
const mockTouch = jest.fn();
let mockArtwork = false;
let mockControlling = true;
let mockAllowed = true;
let mockPhysical = false;
let mockFeatures = ['frames'];
const mockKey = jest.fn();
const mockButton = jest.fn();
const mockSimulator = jest.fn();
const mockDriver = { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: '2026-10-01' }, basis: [] };

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'm1' }),
  useRouter: () => ({ back: jest.fn() }),
}));
jest.mock('react-native-hinges', () => ({ useHinges: () => [] }));
jest.mock('react-native-reserved-regions', () => ({ useReservedRegions: () => [] }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: () => {} }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: jest.requireActual<typeof import('react-native')>('react-native').View },
  useAnimatedStyle: (style: () => unknown) => style(),
  useAnimatedReaction: () => {},
  useSharedValue: (value: number) => ({ get: () => value, set: jest.fn() }),
  useReducedMotion: () => true,
  withTiming: (value: number) => value,
}));
jest.mock('expo-image', () => ({ Image: jest.requireActual<typeof import('react-native')>('react-native').View }));
jest.mock('expo-navigation-bar', () => ({ NavigationBar: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: unknown }) => children,
  GestureHandlerRootView: jest.requireActual<typeof import('react-native')>('react-native').View,
  useTapGesture: () => ({}),
  useExclusiveGestures: () => ({}),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/hooks/settings', () => ({ useSettings: () => ({ videoQuality: 'auto' }) }));
jest.mock('@/hooks/machines', () => ({
  useWorkspace: () => ({
    title: 'Duo fixture',
    env: {
      path: '/fixture',
      ios: { udid: 'fixture', owned: true, state: 'Booted', name: 'stim-fixture (iPhone Duo 27.1)' },
      activity: { ios: mockDriver },
      deviceLeases: mockPhysical ? [] : undefined,
    },
  }),
  useMacConnection: () => ({
    mac: { id: 'm1', name: 'Fixture Mac' },
    state: { kind: 'open', deviceId: 'phone', features: mockFeatures },
    connection: null,
  }),
}));
jest.mock('@/hooks/device-control', () => ({
  useDeviceControl: () => ({
    allowed: mockAllowed,
    state: mockControlling
      ? { kind: 'on', session: 'c1', leaseSince: null, postures: ['folded', 'half-open', 'unfolded'] }
      : { kind: 'busy', message: 'Driven by another client' },
    begin: mockBegin,
    end: jest.fn(),
    rotate: mockRotate,
    touch: mockTouch,
    key: mockKey,
    button: mockButton,
    simulator: mockSimulator,
  }),
}));
jest.mock('@/hooks/device-stream', () => ({
  useReplayAt: () => null,
  useDeviceStream: () => ({
    frame: { width: 400, height: 800, ...(mockArtwork ? { artworkTurns: 0 } : { posture: 'folded' }) },
    replay: null,
    video: null,
    artwork: mockArtwork
      ? {
          width: 500,
          height: 1000,
          aperture: { x: 50, y: 100, width: 400, height: 800 },
          quarterTurns: 0,
          cornerRadius: 20,
          background: 'png',
          foreground: 'png',
        }
      : null,
  }),
}));
jest.mock('@/hooks/replay-range', () => ({ useReplayRange: () => null }));
jest.mock('@/hooks/auto-hide', () => ({ useAutoHide: () => ({ shown: true, hide: jest.fn() }) }));
jest.mock('@/hooks/screen-reader', () => ({ useAnnounce: () => {}, useScreenReaderEnabled: () => false }));
jest.mock('@/hooks/device-zoom', () => ({
  zoomKey: () => 'fixture',
  useDeviceZoom: (...args: unknown[]) => {
    mockZoom(...args);
    return {
      landed: true,
      screenRect: null,
      snapshot: null,
      screenSize: { width: 400, height: 800 },
      pan: {},
      fadeStyle: {},
      screenStyle: {},
    };
  },
}));
jest.mock('@/hooks/screen-zoom', () => ({
  useScreenZoom: () => ({ gesture: {}, zoomed: false, lens: { scale: { get: () => 1 } } }),
}));
jest.mock('@/components/agent-feed', () => ({ AgentFeed: () => null }));
jest.mock('@/components/device-screen', () => ({
  DeviceScreen: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/viewer-backdrop', () => ({ ViewerBackdrop: () => null }));
jest.mock('@/components/replay-bar', () => ({ ReplayBar: () => null }));
jest.mock('@/components/lists', () => ({
  ScrollView: jest.requireActual<typeof import('react-native')>('react-native').ScrollView,
}));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/button', () => ({ Button: () => null }));
jest.mock('@/components/pill', () => ({ Pill: () => null }));
jest.mock('@/components/viewer-menu', () => ({
  ViewerMenu: ({
    actions,
    label,
    children,
  }: {
    actions: import('@/components/viewer-toolbar').ViewerAction[];
    label: string;
    children: import('react').ReactElement;
  }) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const { Pressable, View, Text } = jest.requireActual<typeof import('react-native')>('react-native');
    const [open, setOpen] = React.useState(false);
    return (
      <View>
        <Pressable accessibilityLabel={label} onPress={() => setOpen(!open)}>
          {children}
        </Pressable>
        {open
          ? actions.map((action) => (
              <Pressable
                key={action.id}
                accessibilityLabel={action.label}
                disabled={action.disabled}
                accessibilityState={{ disabled: action.disabled, selected: action.selected }}
                onPress={action.onPress}
              >
                <Text>{action.label}</Text>
              </Pressable>
            ))
          : null}
      </View>
    );
  },
}));

beforeEach(() => {
  mockControlling = true;
  mockAllowed = true;
  mockPhysical = false;
  mockArtwork = false;
  mockFeatures = ['frames', 'device-frames'];
  jest.clearAllMocks();
});

it('keeps dismissal dragging disabled for a read-only flat landscape viewer', async () => {
  mockControlling = false;
  mockAllowed = false;
  const previous = Dimensions.get('window');
  Dimensions.set({ window: { ...previous, width: 800, height: 400 } });
  try {
    const screen = await render(
      <I18nProvider i18n={i18n}>
        <DeviceView workspace="/fixture" platform="ios" slot="default" />
      </I18nProvider>,
    );
    expect(mockZoom.mock.calls.at(-1)?.[3]).toBe(false);
    await screen.unmount();
  } finally {
    Dimensions.set({ window: previous });
  }
});

it('lets a Duo control session rotate in both directions while advertising postures', async () => {
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" />
    </I18nProvider>,
  );
  await fireEvent.press(screen.getByLabelText('Rotate left'));
  await fireEvent.press(screen.getByLabelText('Rotate right'));
  expect(mockRotate.mock.calls).toEqual([['left'], ['right']]);
  expect(screen.queryByLabelText('Fold')).toBeNull();
  await fireEvent.press(screen.getByLabelText('More'));
  expect(screen.getByLabelText('Fold').props.accessibilityState).toEqual({ disabled: true, selected: true });
});

it('dispatches secondary device actions from More and keeps them disabled on a read-only pairing', async () => {
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" />
    </I18nProvider>,
  );
  expect(screen.queryByLabelText('Lock')).toBeNull();
  await fireEvent.press(screen.getByLabelText('More'));
  await fireEvent.press(screen.getByLabelText('Lock'));
  expect(mockButton).toHaveBeenCalledWith('lock');
  await screen.unmount();
  mockButton.mockClear();
  mockAllowed = false;
  mockControlling = false;
  const readOnly = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" />
    </I18nProvider>,
  );
  await fireEvent.press(readOnly.getByLabelText('More'));
  await fireEvent.press(readOnly.getByLabelText('Lock'));
  expect(mockButton).not.toHaveBeenCalled();
});

it('takes over directly from the conflict banner without a second confirmation', async () => {
  mockControlling = false;
  const alert = jest.spyOn(Alert, 'alert');
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" />
    </I18nProvider>,
  );
  await fireEvent.press(screen.getByText('Take over'));
  expect(mockBegin).toHaveBeenCalledWith(true);
  expect(alert).not.toHaveBeenCalled();
  alert.mockRestore();
});

it('keeps physical iPhones view-only without rotation buttons', async () => {
  mockPhysical = true;
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" physical />
    </I18nProvider>,
  );
  expect(screen.queryByLabelText('Rotate left')).toBeNull();
  expect(screen.queryByLabelText('Rotate right')).toBeNull();
});

it('lets a Duo viewer enable its device frame with Control off', async () => {
  mockControlling = false;
  mockFeatures = ['frames', 'device-frames', 'duo-frames'];
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" />
    </I18nProvider>,
  );
  await fireEvent.press(screen.getByLabelText('More'));
  const toggle = screen.getByLabelText('Device frame');
  expect(toggle.props.accessibilityState.selected).toBe(false);
  await fireEvent.press(toggle);
  expect(screen.getByLabelText('Device frame').props.accessibilityState.selected).toBe(true);
  expect(mockBegin).not.toHaveBeenCalled();
});

it('starts frameless and maps framed touches using the aperture layout rather than the housing fit', async () => {
  mockArtwork = true;
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="ios" slot="default" />
    </I18nProvider>,
  );
  expect(screen.queryByLabelText('Device frame')).toBeNull();
  await fireEvent.press(screen.getByLabelText('More'));
  const toggle = screen.getByLabelText('Device frame');
  expect(toggle.props.accessibilityState.selected).toBe(false);
  await fireEvent.press(toggle);
  expect(screen.getByLabelText('Device frame').props.accessibilityState.selected).toBe(true);
  const views = screen.root!.queryAll(
    (view) => view.props.onResponderGrant !== undefined && view.props.pointerEvents === 'auto',
  );
  const aperture = views.find((view) => view.props.onResponderGrant)!;
  expect(views.filter((view) => view.props.onResponderGrant)).toHaveLength(1);
  await fireEvent(aperture, 'layout', { nativeEvent: { layout: { x: 30, y: 60, width: 300, height: 600 } } });
  await fireEvent(aperture, 'responderGrant', { nativeEvent: { locationX: 150, locationY: 300 } });
  await fireEvent(aperture, 'responderRelease', { nativeEvent: { locationX: 450, locationY: 900 } });
  expect(mockTouch.mock.calls).toEqual([
    ['down', 0.5, 0.5],
    ['up', 1, 1],
  ]);
  mockTouch.mockClear();
  await fireEvent(aperture, 'responderGrant', { nativeEvent: { locationX: -10, locationY: 300 } });
  expect(mockTouch).not.toHaveBeenCalled();
});

it('keeps the frame presentation toggle available without a control lease or control permission', async () => {
  mockArtwork = true;
  mockControlling = false;
  for (const allowed of [true, false]) {
    mockAllowed = allowed;
    const screen = await render(
      <I18nProvider i18n={i18n}>
        <DeviceView workspace="/fixture" platform="ios" slot="default" />
      </I18nProvider>,
    );
    await fireEvent.press(screen.getByLabelText('More'));
    const toggle = screen.getByLabelText('Device frame');
    expect(toggle.props.accessibilityState.disabled).not.toBe(true);
    expect(toggle.props.accessibilityState.selected).toBe(false);
    await fireEvent.press(toggle);
    expect(screen.getByLabelText('Device frame').props.accessibilityState.selected).toBe(true);
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockTouch).not.toHaveBeenCalled();
    await screen.unmount();
  }
});

it('keeps native mouse scrolling in the main bar without simulator buttons', async () => {
  mockFeatures = ['macos-window', 'macos-window-control'];
  const screen = await render(
    <I18nProvider i18n={i18n}>
      <DeviceView workspace="/fixture" platform="macos" slot="default" />
    </I18nProvider>,
  );
  expect(screen.getByLabelText('Scroll')).toBeTruthy();
  expect(screen.queryByLabelText('Rotate left')).toBeNull();
  expect(screen.queryByLabelText('Home')).toBeNull();
  expect(screen.queryByLabelText('Lock')).toBeNull();
  expect(screen.queryByLabelText('Back')).toBeNull();
  expect(screen.getByLabelText('Keyboard')).toBeTruthy();
  expect(screen.queryByLabelText('Select all')).toBeNull();
});
