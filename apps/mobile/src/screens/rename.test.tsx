import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import '@/design/unistyles';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { RequestError } from '@/lib/connection';
import { Rename } from './rename';

const mockRequest = jest.fn();
const mockReconnect = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ back: mockBack }) }));
jest.mock('@/hooks/machines', () => ({
  useMacs: () => ({
    reload: jest.fn(),
    connections: [
      {
        mac: { id: 'mac', name: 'Local label' },
        state: { kind: 'open', server: { name: 'Test Mac' }, deviceId: 'own-id', deviceName: 'Phone' },
        connection: { request: mockRequest, reconnect: mockReconnect },
      },
    ],
  }),
}));
jest.mock('@/lib/connection', () => ({
  RequestError: class extends Error {
    error: { code: string; message: string };
    constructor(value: { code: string; message: string }) {
      super(value.message);
      this.error = value;
    }
  },
}));
jest.mock('@/lib/macs', () => ({ listMacs: jest.fn(), renameMac: jest.fn() }));
jest.mock('@/components/button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled: boolean }) => {
    const { Pressable, Text } = jest.requireActual('react-native');
    return (
      <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}>
        <Text>{title}</Text>
      </Pressable>
    );
  },
}));

beforeEach(() => jest.clearAllMocks());

async function save() {
  await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Rename id="mac" on="machine" />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  await fireEvent.changeText(screen.getByLabelText('Name on the machine'), '  My Phone  ');
  await act(async () => {
    fireEvent.press(screen.getByText('Save'));
  });
}

test('renames the own record with trimmed text and reconnects', async () => {
  mockRequest.mockResolvedValue({ name: 'My Phone' });
  await save();
  expect(mockRequest).toHaveBeenCalledWith('device.rename', { id: 'own-id', name: 'My Phone' });
  expect(mockReconnect).toHaveBeenCalledTimes(1);
  expect(mockBack).toHaveBeenCalledTimes(1);
});

test('an older machine explains the CLI alternative and disables Save', async () => {
  mockRequest.mockRejectedValue(new RequestError({ code: 'unknown-method', message: 'Unknown method' }));
  await save();
  expect(screen.getByText(/stim pairings rename own-id <name>/)).toBeTruthy();
  expect(screen.getByRole('button')).toBeDisabled();
  expect(mockBack).not.toHaveBeenCalled();
  expect(mockReconnect).not.toHaveBeenCalled();
});
