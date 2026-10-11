import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { BarcodeScanningResult } from 'expo-camera';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import '@/design/unistyles';

import { pair } from '@/lib/connection';
import { saveMac } from '@/lib/macs';

import { Pair } from './pair';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ dismiss: jest.fn(), dismissTo: jest.fn() }),
}));
jest.mock('expo-camera', () => ({
  CameraView: (props: object) => {
    const { View } = jest.requireActual('react-native');
    return <View {...props} testID="camera" />;
  },
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
jest.mock('@/hooks/machines', () => ({ CLIENT: 'mobile', useMacs: () => ({ reload: jest.fn() }) }));
jest.mock('@/lib/connection', () => ({ pair: jest.fn() }));
jest.mock('@/lib/macs', () => ({ saveMac: jest.fn(), renameMac: jest.fn() }));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/touch', () => ({
  Touch: (props: object) => {
    const { Pressable } = jest.requireActual('react-native');
    return <Pressable {...props} />;
  },
}));
jest.mock('@/components/button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => {
    const { Pressable, Text } = jest.requireActual('react-native');
    return (
      <Pressable onPress={onPress} accessibilityLabel={title}>
        <Text>{title}</Text>
      </Pressable>
    );
  },
  IconButton: () => null,
}));
jest.mock('react-native-transformer-text-input', () => ({
  Transformer: class {},
  TransformerTextInput: jest.requireActual('react-native').TextInput,
}));

const scanned = {
  type: 'qr',
  data: JSON.stringify({ v: 1, name: 'Fixture Mac', endpoint: 'ws://127.0.0.1:1', pairingToken: 'fixture-token' }),
} as BarcodeScanningResult;
const pairing = jest.mocked(pair);

const scan = (data: BarcodeScanningResult = scanned) =>
  act(async () => screen.getByTestId('camera').props.onBarcodeScanned(data));
const connect = () => act(async () => fireEvent.press(screen.getByText('Connect')));

beforeEach(() => {
  jest.clearAllMocks();
  pairing.mockRejectedValue(new Error('Cannot reach Fixture Mac'));
});

test('a failed QR stays paused, including queued scans, until Retry', async () => {
  await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Pair />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  const callback = screen.getByTestId('camera').props.onBarcodeScanned as (result: BarcodeScanningResult) => void;
  await act(async () => callback(scanned));
  await connect();
  expect(pairing).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Cannot reach Fixture Mac')).toBeTruthy();
  await act(async () => {
    callback(scanned);
    callback(scanned);
  });
  expect(pairing).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Cannot reach Fixture Mac')).toBeTruthy();
  expect(saveMac).not.toHaveBeenCalled();
  expect(screen.getByTestId('camera').props.onBarcodeScanned).toBeUndefined();

  await fireEvent.press(screen.getByText('Retry'));
  expect(screen.queryByText('Cannot reach Fixture Mac')).toBeNull();
  await scan();
  await connect();
  expect(pairing).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Cannot reach Fixture Mac')).toBeTruthy();
});

test('manual choice clears the failed scan and returning to the camera permits a new attempt', async () => {
  await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Pair />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  await scan();
  await connect();
  await fireEvent.press(screen.getByText('Enter the Endpoint and Token Instead'));
  expect(screen.queryByText('Cannot reach Fixture Mac')).toBeNull();
  expect(screen.queryByTestId('camera')).toBeNull();
  expect(screen.getByText('Endpoint')).toBeTruthy();

  await fireEvent.press(screen.getByText('Scan a QR Code Instead'));
  await scan();
  await connect();
  expect(pairing).toHaveBeenCalledTimes(2);
});

test('an unrelated QR can be followed by a pairing QR without Retry', async () => {
  await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Pair />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  await act(async () =>
    screen.getByTestId('camera').props.onBarcodeScanned({ ...scanned, data: 'https://example.com' }),
  );
  expect(pairing).not.toHaveBeenCalled();
  expect(screen.queryByText('Retry')).toBeNull();
  await scan();
  await connect();
  expect(pairing).toHaveBeenCalledTimes(1);
});

const remote = (endpoint: string) => ({ ...scanned, data: JSON.stringify({ ...JSON.parse(scanned.data), endpoint }) });

test('a scanned code shows its host and connects only after Connect', async () => {
  await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Pair />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  await scan(remote('wss://evil.example.com:7443'));
  expect(pairing).not.toHaveBeenCalled();
  expect(screen.getByText('evil.example.com')).toBeTruthy();
  expect(screen.getByText(/not a Tailscale/)).toBeTruthy();

  await fireEvent.press(screen.getByText('Cancel'));
  expect(pairing).not.toHaveBeenCalled();
  expect(screen.getByTestId('camera').props.onBarcodeScanned).toBeDefined();

  await scan(remote('wss://mac.tail1234.ts.net'));
  expect(screen.getByText('mac.tail1234.ts.net')).toBeTruthy();
  expect(screen.queryByText(/not a Tailscale/)).toBeNull();
  await fireEvent.press(screen.getByText('Cancel'));
  await scan(remote('ws://127.0.0.1:1'));
  expect(screen.queryByText(/not a Tailscale/)).toBeNull();
});

test('a typed endpoint also waits for Connect, and Cancel keeps what was typed', async () => {
  await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <Pair />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  await fireEvent.press(screen.getByText('Enter the Endpoint and Token Instead'));
  await fireEvent.changeText(screen.getByLabelText('Endpoint'), 'wss://evil.example.com');
  await fireEvent.changeText(screen.getByLabelText('Pairing token'), 'typed-token');
  await fireEvent.press(screen.getByText('Pair'));
  await screen.findByText('evil.example.com');
  expect(pairing).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByText('Cancel'));
  expect(screen.getByLabelText('Endpoint').props.value).toBe('wss://evil.example.com');
  expect(screen.getByLabelText('Pairing token').props.defaultValue).toBe('typed-token');
  expect(pairing).not.toHaveBeenCalled();
});
