import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { fireEvent, render } from '@testing-library/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import '@/design/unistyles';

import { Welcome } from './welcome';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/touch', () => ({
  Touch: (props: object) => {
    const { Pressable } = jest.requireActual('react-native');
    return <Pressable accessibilityRole="button" {...props} />;
  },
}));

it('opens pairing or dismisses the welcome through its buttons', async () => {
  const dismiss = jest.fn();
  const screen = await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Welcome dismiss={dismiss} />
      </I18nProvider>
    </GestureHandlerRootView>,
  );

  await fireEvent.press(screen.getByRole('button', { name: 'Pair with your Mac' }));
  expect(mockPush).toHaveBeenCalledWith('/pair');
  expect(dismiss).not.toHaveBeenCalled();

  mockPush.mockClear();
  await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(mockPush).not.toHaveBeenCalled();
});
