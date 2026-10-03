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
let mockControlling = true;
let mockAllowed = true;
let mockPhysical = false;
const mockDriver = { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: '2026-10-01' }, basis: [] };

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
      ios: { udid: 'fixture', owned: true, state: 'Booted', formFactor: 'dual', model: 'iPhone Duo' },
      activity: { ios: mockDriver },
      deviceLeases: mockPhysical ? [] : undefined,
    },
  }),
  useMacConnection: () => ({
    mac: { id: 'm1', name: 'Fixture Mac' },
    state: { kind: 'open', deviceId: 'phone', features: ['frames'] },
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
  }),
}));
jest.mock('@/hooks/device-stream', () => ({
  useReplayAt: () => null,
  useDeviceStream: () => ({ frame: { width: 400, height: 800, posture: 'folded' }, replay: null, video: null }),
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
jest.mock('@/components/device-screen', () => ({ DeviceScreen: () => null }));
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

beforeEach(() => {
  mockControlling = true;
  mockAllowed = true;
  mockPhysical = false;
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
  expect(screen.getByLabelText('Fold').props.accessibilityState).toEqual({ disabled: true, selected: true });
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
