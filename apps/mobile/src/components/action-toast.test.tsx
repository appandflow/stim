import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { act, render, screen } from '@testing-library/react-native';

import '@/design/unistyles';

import { ActionToast } from './action-toast';

let mockScreenReader = false;
jest.mock('@/hooks/screen-reader', () => ({ useScreenReaderEnabled: () => mockScreenReader }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { call: () => {}, createAnimatedComponent: (component: unknown) => component },
  useReducedMotion: () => true,
}));

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('a result toast dismisses itself, but waits for a tap while a screen reader runs', async () => {
  const onDismiss = jest.fn();
  mockScreenReader = false;
  const { unmount } = await render(
    <ActionToast toast={{ kind: 'success', message: 'Reloaded' }} onDismiss={onDismiss} />,
  );
  await act(async () => {
    jest.advanceTimersByTime(2500);
  });
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await unmount();

  mockScreenReader = true;
  await render(<ActionToast toast={{ kind: 'error', message: 'Failed' }} onDismiss={onDismiss} />);
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
