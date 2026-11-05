import { renderHook } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import { useAnnounce } from './screen-reader';

let announce: jest.SpyInstance;

beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  announce.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

test('on iOS each new message is announced once', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const { rerender } = await renderHook((message: string | null) => useAnnounce(message), { initialProps: null });
  expect(announce).not.toHaveBeenCalled();
  await rerender('Reloaded');
  await rerender('Reloaded');
  await rerender('Stopped');
  expect(announce.mock.calls).toEqual([['Reloaded'], ['Stopped']]);
});

test('on Android the live region speaks, so nothing is announced twice', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  await renderHook(() => useAnnounce('Reloaded'));
  expect(announce).not.toHaveBeenCalled();
});
